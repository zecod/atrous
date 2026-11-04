// herdr browser helper (Node 22+, no dependencies).
//
// Native mode (--native, Windows): the page is drawn natively by herdr-browser-host (native/,
// a WebView2 in a popup kept over the panel's page area, built with dotnet on first use into
// %LOCALAPPDATA%\herdr-browser\host). The helper starts it, drives it over the same DevTools
// Protocol (WebView2's, on <cdp-port>) for everything but drawing: tabs go through the host,
// there is no screencast, and the pick/annotate hover outline is drawn in the page itself.
// If the host can't be built or started, the helper falls back to the screencast below.
//
// Screencast mode (any OS): runs or reuses a headless Chrome (Edge as a fallback) with the DevTools Protocol on
// 127.0.0.1:<cdp-port>, follows one page target, streams it with Page.startScreencast
// into JPEG files the browser-panel mod shows with image(), and answers a tiny HTTP API
// on 127.0.0.1:<port> (navigate, back/forward/reload, mouse, wheel, keys, text, resize, state).
//
// The same Chrome stays open to agents: Playwright connectOverCDP("http://127.0.0.1:9333")
// or Playwright MCP --cdp-endpoint http://127.0.0.1:9333. A page an agent opens is followed.
//
// Chrome is started through WMI, so it belongs to no herdr-core terminal and outlives this
// helper (agents keep their session; a new helper reattaches); the helper exits when Chrome goes.
// A newly started Chrome opens https://www.google.com unless --url says otherwise.
//
// Where frames go matters (measured on herdr-app 0.1.12): the app caches every decoded image
// by path, and only drops one when its file changes or goes away under a folder it watches
// (mods/<name>/, except hidden ones and node_modules), and then it reloads every image in that
// folder, which blanks them for a moment. So:
// - frames go to a sibling folder with no main.js (mods/browser-panel-frames/, not a mod):
//   in the mod's own folder every frame would reload the mod;
// - each frame has a new name (a reused name can show a stale cached picture) and lives alone
//   in one of 16 bucket folders (b00..b15, round robin), so writing a frame only touches the
//   folder of the frame 16 back, long off screen; deleting that old frame frees its memory;
// - a picture identical to one still on disk (a blinking caret) reuses that file;
// - after a new document commits, the last good frame stays until the page paints.
//
//   node helper.mjs [--port 9334] [--cdp-port 9333] [--home ~/.config/herdr-app]
//                   [--frames mods/browser-panel-frames] [--profile <dir>] [--browser <exe>]
//                   [--width 800 --height 600 --scale 1.25] [--url https://...] [--headed] [--log-frames]
//                   [--native [--host-port 9335] [--herdr-pid <pid>]]
//
// API (JSON, 127.0.0.1 only): GET /state[?since=<ver>&wait=<ms>] (long poll; ?peek=1 doesn't
// count as watching), GET /cookie-stats (cookie counts per site, never values);
// POST /navigate {url}, /back, /forward, /reload {hard?}, /stop-loading,
// /resize {width,height,scale}, /input {events:[{t:"mouse"|"wheel"|"key"|"text"|"paste"|"copy",...}]},
// /mouse, /wheel, /key, /text, /paste, /copy {cut?}, /target {id}, /close-target {id?},
// /new {url?}, /shutdown (closes Chrome too), /detach (helper exits, Chrome keeps running),
// /inspect {mode: "pick" | "annotate" | "off"} (Chrome's inspect mode: hover highlight, a click
// sets state.picked; pick copies the element's outerHTML), /pick-action {action: "copy" | "shot"},
// /marks {marks: [{n, backendNodeId}]} (numbered note markers on the page), /element-shot
// {backendNodeId}, /clipboard {text}; GET /debug?kind=console|network[&since=<dver>],
// /debug-request?id=, /html?what=page|picked; POST /debug-clear {kind}.
// state.hover: in pick/annotate mode, the box (viewport CSS px) and label of the element under the
// pointer; the panel draws the outline itself. POST /perf {reset?, mod?}: input -> frame latencies
// (and the panel's render numbers, matched to them); POST /tune {minFrameMs, castScale}: debugging.
// Every tab keeps a session (console, network) from when it appears; only the shown one is cast.

import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---- options ----------------------------------------------------------------------------

const opt = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const eq = a[i].indexOf("=");
    if (eq > 0) opt[a[i].slice(2, eq)] = a[i].slice(eq + 1);
    else if (i + 1 < a.length && !a[i + 1].startsWith("--")) opt[a[i].slice(2)] = a[++i];
    else opt[a[i].slice(2)] = "true";
  }
}

const CDP_PORT = Number(opt["cdp-port"] ?? 9333);
const API_PORT = Number(opt.port ?? 9334);
const WIN = process.platform === "win32", MAC = process.platform === "darwin";
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"); // Windows
// Where the browser's own data lives (profile, logs, shots): per-user app data on each OS.
const BASE = WIN ? path.join(LOCAL, "herdr-browser")
  : MAC ? path.join(os.homedir(), "Library", "Application Support", "herdr-browser")
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "herdr-browser");
// One profile per helper port: a second Chrome on the same profile would only hand off to the first.
const PROFILE = opt.profile || path.join(BASE, API_PORT === 9334 ? "profile" : `profile-${API_PORT}`);
const HOME = opt.home || path.join(os.homedir(), ".config", "herdr-app");
const FRAMES_REL = (opt.frames || "mods/browser-panel-frames").replace(/\\/g, "/").replace(/\/+$/, "");
const FRAMES_DIR = path.resolve(HOME, FRAMES_REL);
const LOG_FRAMES = opt["log-frames"] === "true"; // debugging: log every frame and page lifecycle event
const ARCHIVE = opt.archive || null; // debugging: keep a copy of every frame written (<seq>-<ms>.jpg)
// Every frame the panel shows costs the app about two whole-window redraws (~60-75 ms of its
// main thread, measured on herdr-app 0.1.12: 3.4 fps ~32% of a core, 9.5 fps ~78%, 24 fps a full
// core, whatever the frame's pixel size). So the frame rate follows the person: 15 a second while
// they use the page (and 1.5 s after), 3 a second when the page only moves on its own (animations,
// video). Faster would starve the app's own input handling, which is what feels like lag.
let MIN_FRAME_MS = 0; // debugging override (/tune); 0 = adaptive
const ACTIVE_GAP_MS = 66, IDLE_GAP_MS = 333, ACTIVE_FOR_MS = 1500;
let lastInputAt = 0;
const frameGap = () => MIN_FRAME_MS || (Date.now() - lastInputAt < ACTIVE_FOR_MS ? ACTIVE_GAP_MS : IDLE_GAP_MS);
const IDLE_MS = 5000; // nobody asked for state this long: stop the screencast
const RUN = Date.now().toString(36); // frame names never repeat, across runs too
const TMP_DIR = path.join(BASE, `tmp${API_PORT === 9334 ? "" : `-${API_PORT}`}`); // frames are written here, then moved in
// Native mode (Windows): the WebView2 host draws the page; see the top of this file.
let NATIVE = opt.native === "true" && WIN;
const HOST_PORT = Number(opt["host-port"] ?? 9335);
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const HOST_DIR = path.join(BASE, "host");
const HOST_EXE = path.join(HOST_DIR, "herdr-browser-host.exe");
const NATIVE_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "native");
const DEFAULT_URL = "https://www.google.com"; // a newly started Chrome opens this unless told otherwise

fs.mkdirSync(BASE, { recursive: true });
fs.mkdirSync(FRAMES_DIR, { recursive: true });
// A helper on another port (a test) keeps its own log and last page.
const SUFFIX = API_PORT === 9334 ? "" : `-${API_PORT}`;
const LOG = path.join(BASE, `helper${SUFFIX}.log`);
try { fs.writeFileSync(LOG, ""); } catch {}
function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${parts.join(" ")}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
  try { process.stdout.write(line); } catch {}
}

// ---- browser discovery and launch -------------------------------------------------------

function browserCandidates() {
  if (MAC) {
    const apps = ["/Applications", path.join(os.homedir(), "Applications")];
    const names = [["Google Chrome.app", "Google Chrome"], ["Chromium.app", "Chromium"], ["Microsoft Edge.app", "Microsoft Edge"]];
    return [opt.browser, ...apps.flatMap((a) => names.map(([app, bin]) => path.join(a, app, "Contents", "MacOS", bin)))].filter(Boolean);
  }
  if (!WIN) {
    const dirs = (process.env.PATH || "/usr/bin:/usr/local/bin").split(path.delimiter).filter(Boolean);
    const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
    return [opt.browser, ...names.flatMap((n) => dirs.map((d) => path.join(d, n)))].filter(Boolean);
  }
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  return [
    opt.browser,
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(LOCAL, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
}

function findBrowser() {
  return browserCandidates().find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

// The installed version's major number, from its version folder (never runs the exe:
// on Windows `chrome.exe --version` opens the user's own browser instead of printing).
function majorVersion(exe) {
  if (MAC) {
    try {
      const plist = fs.readFileSync(path.join(path.dirname(exe), "..", "Info.plist"), "utf8");
      return /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)/.exec(plist)?.[1] ?? null;
    } catch { return null; }
  }
  if (!WIN) {
    try { return /(\d+)\.\d+/.exec(spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 5000 }).stdout)?.[1] ?? null; } catch { return null; }
  }
  try {
    const dirs = fs.readdirSync(path.dirname(exe)).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
    dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return dirs[0]?.split(".")[0] ?? null;
  } catch { return null; }
}

async function cdpVersion(ms = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// Something listening on the port (a busy Chrome answers slowly): don't start a second one.
function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: CDP_PORT });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// A Chrome that is still closing holds the profile; a launch then only hands off to it and
// quits. So a launch that doesn't open the port is tried once more, a moment later.
async function launchBrowser() {
  try { return await launchOnce(); }
  catch (e) {
    log(e.message, "- trying again");
    await sleep(2000);
    const v = await cdpVersion();
    return v ?? launchOnce();
  }
}

async function launchOnce() {
  const exe = findBrowser();
  if (!exe) throw new Error("No Chrome or Edge found");
  const edge = /msedge\.exe$/i.test(exe);
  const major = majorVersion(exe);
  // Headless Chrome says "HeadlessChrome" in its user agent, which many sites treat as a bot.
  const ua = major
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${edge ? ` Edg/${major}.0.0.0` : ""}`
    : null;
  fs.mkdirSync(PROFILE, { recursive: true });
  const w = Math.max(200, Math.round(Number(opt.width) || 1024));
  const h = Math.max(200, Math.round(Number(opt.height) || 768));
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${PROFILE}`,
    ...(opt.headed === "true" ? [] : ["--headless=new"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--hide-crash-restore-bubble",
    `--window-size=${w},${h}`,
    ...(ua ? [`--user-agent=${ua}`] : []),
    opt.url || DEFAULT_URL,
  ];
  log("launching", exe);
  await launchDetached(exe, args);
  for (let i = 0; i < 60; i++) {
    const v = await cdpVersion();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`Browser did not open its DevTools port ${CDP_PORT}`);
}

// herdr-core ends a terminal's whole process tree when the terminal ends, so a browser this
// helper spawns would die with the helper. On Windows it's started through WMI, so it belongs to
// no terminal and outlives the helper (agents keep their session; a new helper reattaches);
// elsewhere a detached spawn in its own process group does the same.
async function launchDetached(exe, args) {
  let independent = false;
  if (WIN) {
    try {
      const out = await powershell(
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:HERDR_BROWSER_CMD }; \"$($r.ReturnValue) $($r.ProcessId)\"",
        undefined, { HERDR_BROWSER_CMD: [exe, ...args].map(winQuote).join(" ") });
      independent = out.trim().startsWith("0 ");
      if (!independent) log("WMI launch failed:", out.trim());
    } catch (e) { log("WMI launch failed:", e.message); }
  }
  if (!independent) {
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (e) => log("spawn error", e.message));
    child.unref();
  }
}

// ---- the native host (Windows) ------------------------------------------------------------

async function hostState(ms = 1500) {
  try {
    const r = await fetch(`${HOST}/state`, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function hostPost(p, body, ms = 15000) {
  const r = await fetch(`${HOST}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(ms) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `host ${p}: ${r.status}`);
  return j;
}

function runQuiet(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill(), opts.timeout ?? 300000);
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// The host is built from native/ (sources only in the mod) into BASE/host, the first time and
// whenever a source is newer than the exe. The build runs in BASE/host-build, so no bin/obj
// ever lands in the mod folder.
async function ensureHostBuilt() {
  let srcs = [];
  try { srcs = fs.readdirSync(NATIVE_SRC).filter((f) => /\.(cs|csproj|manifest|json)$/i.test(f)); } catch {}
  if (!srcs.length) throw new Error(`no native sources in ${NATIVE_SRC}`);
  const newest = Math.max(...srcs.map((f) => fs.statSync(path.join(NATIVE_SRC, f)).mtimeMs));
  let built = 0;
  try { built = fs.statSync(HOST_EXE).mtimeMs; } catch {}
  if (built && built >= newest) return;
  const work = path.join(BASE, "host-build");
  fs.mkdirSync(work, { recursive: true });
  for (const f of srcs) fs.copyFileSync(path.join(NATIVE_SRC, f), path.join(work, f));
  S.phase = "Building the native browser view (first run, about a minute)…";
  bump();
  log("building the native host:", "dotnet build -c Release -o", HOST_DIR);
  const r = await runQuiet("dotnet", ["build", "-c", "Release", "-o", HOST_DIR, "--nologo", "-v", "q"], { cwd: work, timeout: 600000 });
  S.phase = "";
  if (r.code !== 0) {
    log("host build failed:", r.out.slice(-1500));
    if (!built) throw new Error("the native host didn't build (is the .NET 9 SDK installed?)");
    log("keeping the host built before");
  }
}

// The first native start brings the panel's sign-ins, history and bookmarks over from the
// screencast's Chrome profile (import-chrome.mjs with that profile as the source), once.
async function migrateProfile() {
  const data = path.join(BASE, HOST_PORT === 9335 ? "webview2" : `webview2-${HOST_PORT}`, "EBWebView");
  const marker = path.join(BASE, `migrated${SUFFIX}`);
  if (fs.existsSync(marker) || fs.existsSync(path.join(data, "Default")) || !fs.existsSync(path.join(PROFILE, "Default"))) return;
  S.phase = "Bringing this browser's sign-ins over…";
  bump();
  const importer = path.join(path.dirname(fileURLToPath(import.meta.url)), "import-chrome.mjs");
  const r = await runQuiet(process.execPath, [importer, "--source", PROFILE, "--dest", data, "--report", path.join(BASE, `migrate-report${SUFFIX}.json`),
    "--cdp-port", String(CDP_PORT)], { timeout: 180000 });
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
  log("profile migration", r.code === 0 ? "done" : `failed (${r.code})`, r.out.replace(/s+/g, " ").slice(-500));
  S.phase = "";
}

async function launchHost() {
  await ensureHostBuilt();
  await migrateProfile().catch((e) => log("profile migration:", e.message));
  const args = ["--home", HOME, "--port", String(HOST_PORT), "--cdp-port", String(CDP_PORT), "--frames", FRAMES_REL,
    "--url", opt.url || DEFAULT_URL];
  if (opt["herdr-pid"]) args.push("--herdr-pid", String(opt["herdr-pid"]));
  if (opt["host-args"]) args.push(...String(opt["host-args"]).split(" ").filter(Boolean));
  log("launching", HOST_EXE, args.join(" "));
  await launchDetached(HOST_EXE, args);
  for (let i = 0; i < 100; i++) {
    const v = await cdpVersion();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`The native host did not open its DevTools port ${CDP_PORT}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One argument for a Windows command line (CommandLineToArgvW rules).
function winQuote(a) {
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

// ---- CDP connection ---------------------------------------------------------------------

class Cdp {
  constructor(url) { this.url = url; this.next = 1; this.calls = new Map(); this.listeners = []; this.closed = false; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let open = false;
      ws.onopen = () => { open = true; resolve(); };
      ws.onerror = () => { if (!open) reject(new Error("Cannot connect to the browser")); };
      ws.onclose = () => {
        this.closed = true;
        for (const c of this.calls.values()) c.reject(new Error("browser connection closed"));
        this.calls.clear();
        if (open) this.onclose?.();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch { return; }
        if (msg.id !== undefined) {
          const c = this.calls.get(msg.id);
          if (!c) return;
          this.calls.delete(msg.id);
          clearTimeout(c.timer);
          if (msg.error) c.reject(new Error(`${c.method}: ${msg.error.message}`));
          else c.resolve(msg.result);
        } else {
          for (const l of this.listeners) {
            try { l(msg.method, msg.params ?? {}, msg.sessionId); } catch (e) { log("listener error", e.stack || e); }
          }
        }
      };
    });
  }
  send(method, params = {}, sessionId, timeout = 20000) {
    if (this.closed) return Promise.reject(new Error("browser connection closed"));
    const id = this.next++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`${method}: timed out`)); }, timeout);
      this.calls.set(id, { resolve, reject, method, timer });
      this.ws.send(JSON.stringify(msg));
    });
  }
}

// ---- state ------------------------------------------------------------------------------

const S = {
  ver: 1,
  url: "", title: "", loading: false, canGoBack: false, canGoForward: false,
  frame: null, frameSeq: 0, frameW: 0, frameH: 0,
  width: Math.round(Number(opt.width) || 800), height: Math.round(Number(opt.height) || 600),
  scale: Number(opt.scale) || 1,
  targetId: null, session: null, casting: false,
  browser: "", error: null, started: Date.now(),
  inspect: "off", // "pick" | "annotate": Chrome's inspect mode (hover highlight, click picks)
  picked: null, // the last clicked element: { seq, mode, targetId, backendNodeId, tag, selector, text, rect, html, shot }
  hoverNode: null,
  toast: null, // { seq, text } a short confirmation for the panel to show
  phase: "", // what the helper is busy with before the browser is up
};
let pickSeq = 0, toastSeq = 0;
const PERF = { inputAt: 0, kind: "", chromeAt: 0, samples: [], written: 0, mod: null, hoverAt: 0, hover: [], writeMs: [] };
const toast = (text) => { S.toast = { seq: ++toastSeq, text }; bump(); };
const targets = new Map(); // targetId -> { id, url, title, order }
let order = 0;
let cdp = null;
let waiters = [];
let lastPoll = 0;
let activeWaits = 0;

function bump() {
  S.ver++;
  const ws = waiters; waiters = [];
  for (const w of ws) w();
}

const watching = () => activeWaits > 0 || Date.now() - lastPoll < IDLE_MS;
const internal = (url) => /^(devtools|chrome-extension|edge-extension):/i.test(url ?? "");

function publicState() {
  return {
    ok: true, ver: S.ver,
    url: S.url, title: S.title, loading: S.loading, canGoBack: S.canGoBack, canGoForward: S.canGoForward,
    frame: S.frame, frameSeq: S.frameSeq, frameW: S.frameW, frameH: S.frameH,
    width: S.width, height: S.height, scale: S.scale, casting: S.casting,
    targetId: S.targetId,
    targets: [...targets.values()].filter((t) => !internal(t.url)).sort((a, b) => a.order - b.order)
      .map((t) => ({ id: t.id, url: t.url, title: t.title, current: t.id === S.targetId })),
    cdp: `http://127.0.0.1:${CDP_PORT}`, browser: S.browser, error: S.error, pid: process.pid,
    native: NATIVE, host: NATIVE ? HOST : null, ready, phase: S.phase,
    inspect: S.inspect, picked: S.picked, toast: S.toast, hover: S.inspect !== "off" ? S.hover : null,
    dver: tabs.get(S.targetId)?.dver ?? 0, // the debug drawer's lists changed when this did
  };
}

// Serialize target switches so two quick target events can't interleave attaches.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn).catch((e) => { log("switch error", e.message); }));

// ---- following a page -------------------------------------------------------------------

// Every tab keeps its own session from the moment it's seen, so the debug drawer has its
// console and network from the start; only the shown tab is screencast.
const tabs = new Map(); // targetId -> { session, console: [], net: [], dver, ... }
const bySession = new Map(); // sessionId -> targetId
const MAX_CONSOLE = 500, MAX_NET = 300;

function tabFor(session) {
  const id = bySession.get(session);
  return id ? tabs.get(id) : null;
}

async function attach(targetId) {
  let tab = tabs.get(targetId);
  if (tab?.session) return tab.session;
  if (tab?.attaching) return tab.attaching;
  if (!tab) { tab = { id: targetId, session: null, console: [], net: [], netById: new Map(), cseq: 0, dver: 1 }; tabs.set(targetId, tab); }
  tab.attaching = (async () => {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, undefined, NATIVE ? 5000 : 20000);
    tab.session = sessionId;
    bySession.set(sessionId, targetId);
    await Promise.all([
      cdp.send("Page.enable", {}, sessionId, NATIVE ? 5000 : 20000),
      cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId).catch(() => {}),
      cdp.send("Runtime.enable", {}, sessionId).catch(() => {}),
      cdp.send("Log.enable", {}, sessionId).catch(() => {}),
      cdp.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId).catch(() => {}),
      NATIVE ? Promise.resolve() : cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId).catch(() => {}),
      NATIVE ? cdp.send("Runtime.addBinding", { name: "__herdrKey" }, sessionId).catch(() => {}) : Promise.resolve(),
    ]);
    return sessionId;
  })();
  try { return await tab.attaching; } finally { tab.attaching = null; }
}

async function follow(targetId) {
  if (S.targetId === targetId && S.session) return;
  const old = S.session;
  if (old && S.inspect !== "off") inspectOn(old, false);
  S.targetId = targetId; S.session = null; S.casting = false;
  S.loading = false; S.canGoBack = false; S.canGoForward = false;
  const t = targets.get(targetId);
  S.url = t?.url ?? ""; S.title = t?.title ?? "";
  bump();
  if (old) cdp.send("Page.stopScreencast", {}, old).catch(() => {});
  const sessionId = await attach(targetId);
  if (S.targetId !== targetId) return;
  S.session = sessionId;
  await applyMetrics();
  if (NATIVE) hostPost("/tabs/activate", { id: targetId }).catch(() => {});
  else cdp.send("Target.activateTarget", { targetId }).catch(() => {});
  await refreshHistory();
  if (S.inspect !== "off") await inspectOn(sessionId, true);
  try { fs.writeFileSync(path.join(BASE, `last-target${SUFFIX}`), targetId); } catch {}
  log("following", targetId, S.url);
  if (watching()) await startCast();
  bump();
}

async function applyMetrics() {
  const s = S.session;
  if (!s || NATIVE) return; // natively the page has its real size
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: S.width, height: S.height, deviceScaleFactor: S.scale, mobile: false }, s).catch((e) => log(e.message));
}

async function refreshHistory() {
  if (!S.session) return;
  try {
    const h = await cdp.send("Page.getNavigationHistory", {}, S.session);
    S.canGoBack = h.currentIndex > 0;
    S.canGoForward = h.currentIndex < h.entries.length - 1;
    const cur = h.entries[h.currentIndex];
    if (cur) { S.url = cur.url; if (cur.title) S.title = cur.title; }
  } catch {}
}

async function startCast() {
  if (!S.session || S.casting || NATIVE) return;
  S.casting = true;
  const s = S.session;
  try {
    await cdp.send("Page.startScreencast", {
      format: "jpeg", quality: 82, everyNthFrame: 1,
      maxWidth: Math.ceil(S.width * (PERF.castScale || S.scale)), maxHeight: Math.ceil(S.height * (PERF.castScale || S.scale)),
    }, s);
  } catch (e) { if (S.session === s) S.casting = false; log("screencast", e.message); }
  bump();
}

async function stopCast() {
  if (!S.casting) return;
  S.casting = false;
  if (S.session) await cdp.send("Page.stopScreencast", {}, S.session).catch(() => {});
  bump();
}

async function restartCast() {
  if (!S.casting) return;
  await stopCast();
  await startCast();
}

function pickFallback() {
  const pages = [...targets.values()].filter((t) => !internal(t.url)).sort((a, b) => b.order - a.order);
  return pages[0]?.id ?? null;
}

async function ensurePage() {
  const id = pickFallback();
  if (id) return follow(id);
  const { targetId } = NATIVE ? { targetId: (await hostPost("/tabs/new", { url: "about:blank" })).id }
    : await cdp.send("Target.createTarget", { url: "about:blank" });
  if (!targets.has(targetId)) targets.set(targetId, { id: targetId, url: "about:blank", title: "", order: ++order });
  return follow(targetId);
}

// ---- frames -----------------------------------------------------------------------------

// Frames live one per bucket folder (frames/b00 .. b15, round robin). The app reloads every
// image in a folder where a file changed, so a new frame must never share a folder with the
// frames still on screen (that was the blank flashing): with buckets, writing frame N touches
// only the folder of frame N-16, long gone from the screen.
const BUCKETS = 16;
let pending = null;
let writing = false;
let lastWrite = 0;
let pumpTimer = null;
const written = []; // bucket index -> its current file name
const recent = new Map(); // picture hash -> { rel, seq, w, h } of frames still on disk

// A JPEG's pixel size, from its start-of-frame marker.
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// The page's CSS viewport behind a frame: ours, unless someone (an agent) set another one.
let viewportKey = "";
let viewportCss = null;
async function frameCss(px, session) {
  const ew = Math.round(S.width * S.scale), eh = Math.round(S.height * S.scale);
  if (!px || (Math.abs(px.w - ew) <= 2 && Math.abs(px.h - eh) <= 2)) return { w: S.width, h: S.height };
  const key = `${px.w}x${px.h}|${S.width}x${S.height}@${S.scale}`;
  if (key !== viewportKey) {
    viewportKey = key;
    const r = await cdp.send("Runtime.evaluate", { expression: "[innerWidth, innerHeight]", returnByValue: true }, session, 3000).catch(() => null);
    const v = r?.result?.value;
    viewportCss = Array.isArray(v) && v[0] > 0 && v[1] > 0 ? { w: v[0], h: v[1] } : { w: px.w / S.scale, h: px.h / S.scale };
  }
  return viewportCss;
}

// Rename over the old frame; the app may be reading it this instant (Windows: EPERM/EBUSY).
async function replace(from, to) {
  for (let i = 0; ; i++) {
    try { return await fsp.rename(from, to); }
    catch (e) {
      if (i >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      await sleep(5 + i * 5);
    }
  }
}

function ack(frame) {
  if (frame.acked) return;
  frame.acked = true;
  cdp.send("Page.screencastFrameAck", { sessionId: frame.params.sessionId }, frame.session).catch(() => {});
}

function onFrame(params, session) {
  const frame = { params, session, at: Date.now() };
  if (PERF.inputAt && !PERF.chromeAt && session === S.session) PERF.chromeAt = frame.at;
  if (session !== S.session) return ack(frame);
  if (pending) ack(pending);
  pending = frame;
  // While held, keep Chrome sending (ack now) but keep only the newest picture.
  if (Date.now() < holdUntil) ack(frame);
  pump();
}

// After a new document commits, the last good frame stays on screen until the new page paints
// (first contentful paint, or 1.5 s at most), as Chrome's own window does: no white in between.
let holdUntil = 0;
let blankUntil = 0; // after a commit: near-blank frames are skipped until then
let heldBlank = null;
const BLANK_BYTES_PER_PX = 0.022; // JPEG size per pixel below which a frame is near-uniform
function hold(ms) {
  holdUntil = Date.now() + ms;
  if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  pump();
}

async function pump() {
  if (writing || !pending) return;
  const wait = Math.max(lastWrite + frameGap(), holdUntil) - Date.now();
  if (wait > 0) {
    if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait);
    return;
  }
  const frame = pending; pending = null; writing = true;
  ack(frame); // Chrome captures the next frame while this one is written
  try {
    if (frame.session === S.session) {
      const data = Buffer.from(frame.params.data, "base64");
      const px = jpegSize(data);
      // Just after a new document commits, a near-blank picture (a white page before its
      // content or styles arrive) would flash between two real pages: keep the last good
      // frame instead, for up to 1.5 s, unless nothing better comes.
      if (Date.now() < blankUntil && px && data.length / (px.w * px.h) < BLANK_BYTES_PER_PX) {
        ack(frame);
        // Parked: shown when the hold ends if nothing better came by then.
        if (!heldBlank) setTimeout(() => {
          if (heldBlank && !pending) pending = heldBlank;
          heldBlank = null; blankUntil = 0; pump();
        }, Math.max(5, blankUntil - Date.now() + 5));
        heldBlank = frame;
        if (LOG_FRAMES) log("frame held (near blank)", data.length);
        return;
      }
      if (px && data.length / (px.w * px.h) >= BLANK_BYTES_PER_PX) { blankUntil = 0; heldBlank = null; }
      const css = await frameCss(px, frame.session);
      const hash = createHash("sha1").update(data).digest("base64");
      const same = recent.get(hash);
      if (same && same.seq > S.frameSeq - (BUCKETS - 4) && same.w === css.w && same.h === css.h) {
        // The same picture as a frame still on disk (a caret blinking, a spinner's loop): show
        // that file again; nothing new to write or for the app to decode.
        if (S.frame !== same.rel) { S.frame = same.rel; bump(); }
        lastWrite = Date.now();
        if (LOG_FRAMES) log("frame again", same.seq);
      } else {
        const seq = S.frameSeq + 1;
        const bucket = `b${String(seq % BUCKETS).padStart(2, "0")}`;
        const dir = path.join(FRAMES_DIR, bucket);
        const name = `f${RUN}-${seq}.jpg`;
        // The bucket's previous frame (BUCKETS frames old, no longer drawn) goes first: deleting
        // it is what makes the app drop its decoded copy. The new one is written outside the
        // watched folder and moved in whole (same volume: an atomic rename), so the app's watcher
        // sees one event for it and never a half-written file.
        const old = written[seq % BUCKETS];
        if (old) await fsp.rm(path.join(dir, old), { force: true }).catch(() => {});
        const tmp = path.join(TMP_DIR, `${name}.part`);
        const w0 = Date.now();
        await fsp.writeFile(tmp, data);
        await replace(tmp, path.join(dir, name));
        PERF.writeMs.push(Date.now() - w0); if (PERF.writeMs.length > 300) PERF.writeMs.shift();
        written[seq % BUCKETS] = name;
        S.frameSeq = seq;
        S.frame = `${FRAMES_REL}/${bucket}/${name}`;
        S.frameW = css.w;
        S.frameH = css.h;
        lastWrite = Date.now();
        recent.set(hash, { rel: S.frame, seq, w: css.w, h: css.h });
        if (PERF.inputAt) {
          const now = Date.now();
          PERF.samples.push({ kind: PERF.kind, at: PERF.inputAt, seq, chrome: (PERF.chromeAt || now) - PERF.inputAt, written: now - PERF.inputAt, frameWait: now - frame.at });
          if (PERF.samples.length > 200) PERF.samples.shift();
          if (LOG_FRAMES) log("latency", PERF.kind, "chrome", (PERF.chromeAt || now) - PERF.inputAt, "written", now - PERF.inputAt);
          PERF.inputAt = 0;
        }
        PERF.written++;
        for (const [k, v] of recent) if (v.seq <= seq - BUCKETS) recent.delete(k);
        if (ARCHIVE) fsp.writeFile(path.join(ARCHIVE, `${String(seq).padStart(5, "0")}-${Date.now() - S.started}.jpg`), data).catch(() => {});
        if (LOG_FRAMES) log("frame", seq, data.length, `${jpegSize(data)?.w}x${jpegSize(data)?.h}`, S.loading ? "loading" : "", S.url.slice(0, 60));
        bump();
      }
    }
  } catch (e) {
    log("frame write", e.message);
  } finally {
    writing = false;
    ack(frame);
    if (pending) pump();
  }
}

function clearFrames() {
  const frame = /^\.?f[0-9a-z]+-\d+\.jpg(\.part)?$/;
  try {
    for (const f of fs.readdirSync(FRAMES_DIR)) {
      const p = path.join(FRAMES_DIR, f);
      if (frame.test(f)) fs.rmSync(p, { force: true });
      else if (/^b\d\d$/.test(f)) for (const g of fs.readdirSync(p)) if (frame.test(g)) fs.rmSync(path.join(p, g), { force: true });
    }
  } catch {}
  written.length = 0;
  recent.clear();
}

function makeBuckets() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  for (const f of fs.readdirSync(TMP_DIR)) if (f.endsWith(".part")) fs.rmSync(path.join(TMP_DIR, f), { force: true });
  for (let i = 0; i < BUCKETS; i++) fs.mkdirSync(path.join(FRAMES_DIR, `b${String(i).padStart(2, "0")}`), { recursive: true });
}

// ---- CDP events -------------------------------------------------------------------------

function onEvent(method, p, session) {
  if (LOG_FRAMES && session === S.session) {
    if (method === "Page.lifecycleEvent" && p.frameId === S.targetId) log("life", p.name);
    if (method === "Page.frameNavigated" && !p.frame.parentId) log("navigated", p.frame.url.slice(0, 60));
    if (method === "Page.frameRequestedNavigation" && p.frameId === S.targetId) log("requested", p.reason, String(p.url).slice(0, 60));
  }
  switch (method) {
    case "Page.screencastFrame":
      onFrame(p, session);
      break;
    case "Target.targetCreated": {
      const t = p.targetInfo;
      if (t.type !== "page") break;
      if (!targets.has(t.targetId)) targets.set(t.targetId, { id: t.targetId, url: t.url, title: t.title, order: ++order });
      // Follow the newest page (an agent's new tab, a popup), unless it's DevTools' own.
      // Natively the host shows new tabs itself and hostWatch follows what it shows.
      if (ready && !internal(t.url)) {
        attach(t.targetId).catch(() => {});
        if (!NATIVE) serial(() => follow(t.targetId));
      }
      bump();
      break;
    }
    case "Target.targetInfoChanged": {
      const t = p.targetInfo;
      if (t.type !== "page") break;
      const known = targets.get(t.targetId);
      if (known) { known.url = t.url; known.title = t.title; }
      if (t.targetId === S.targetId) { S.url = t.url; S.title = t.title; }
      bump();
      break;
    }
    case "Target.targetDestroyed": {
      targets.delete(p.targetId);
      const gone = tabs.get(p.targetId);
      if (gone) { bySession.delete(gone.session); tabs.delete(p.targetId); }
      if (p.targetId === S.targetId) {
        S.session = null; S.targetId = null; S.casting = false;
        if (!NATIVE) serial(() => ensurePage()); // natively the host shows another tab; hostWatch follows it
      }
      bump();
      break;
    }
    case "Target.detachedFromTarget":
      if (bySession.has(p.sessionId)) {
        const tab = tabs.get(bySession.get(p.sessionId));
        if (tab) tab.session = null;
        bySession.delete(p.sessionId);
      }
      if (p.sessionId === S.session) {
        const id = S.targetId;
        S.session = null; S.targetId = null; S.casting = false;
        serial(() => (targets.has(id) ? follow(id) : NATIVE ? null : ensurePage()));
        bump();
      }
      break;
    case "Inspector.targetCrashed":
      if (session === S.session) { S.error = "The page crashed. Reload to try again."; bump(); }
      break;
    case "Page.frameStartedLoading":
      if (session === S.session && p.frameId === S.targetId) { S.loading = true; S.error = null; bump(); }
      break;
    case "Page.frameStoppedLoading":
      if (session === S.session && p.frameId === S.targetId) { S.loading = false; refreshHistory().then(bump); }
      break;
    case "Page.frameNavigated":
      if (!p.frame.parentId) {
        // A new document: the console marks it.
        const tab = tabFor(session);
        if (tab) pushConsole(tab, { level: "nav", text: `Navigated to ${p.frame.url}`, source: "" });
        if (session === S.session && S.inspect !== "off") setTimeout(() => S.session === session && inspectOn(session, true), 300);
      }
      if (session === S.session && !p.frame.parentId && S.frame) { blankUntil = Date.now() + 1500; hold(1500); }
      if (session === S.session && !p.frame.parentId) { S.url = p.frame.url; refreshHistory().then(bump); bump(); }
      break;
    // ---- debug drawer: console and network, per tab ----
    case "Runtime.consoleAPICalled": {
      const tab = tabFor(session);
      if (!tab) break;
      const level = { warning: "warn", error: "error", assert: "error", debug: "debug", info: "info" }[p.type] ?? "log";
      const top = p.stackTrace?.callFrames?.[0];
      pushConsole(tab, { level, text: (p.args ?? []).map(remoteText).join(" "), source: top ? `${shortUrl(top.url)}:${top.lineNumber + 1}` : "" });
      break;
    }
    case "Runtime.exceptionThrown": {
      const tab = tabFor(session);
      const d = p.exceptionDetails ?? {};
      if (tab) pushConsole(tab, { level: "error", text: d.exception?.description ?? d.text ?? "Uncaught exception",
        source: d.url ? `${shortUrl(d.url)}:${(d.lineNumber ?? 0) + 1}` : "" });
      break;
    }
    case "Log.entryAdded": {
      const tab = tabFor(session), e = p.entry ?? {};
      if (tab) pushConsole(tab, { level: e.level === "warning" ? "warn" : e.level === "verbose" ? "debug" : e.level ?? "log", text: e.text ?? "",
        source: e.url ? `${shortUrl(e.url)}${e.lineNumber !== undefined ? `:${e.lineNumber + 1}` : ""}` : e.source ?? "" });
      break;
    }
    case "Network.requestWillBeSent": {
      const tab = tabFor(session);
      if (!tab) break;
      // A new main document starts the list over (as DevTools does), keeping its own request.
      if (p.type === "Document" && p.frameId === tab.id && !p.redirectResponse) { tab.net = []; tab.netById.clear(); }
      const prev = tab.netById.get(p.requestId);
      if (prev && p.redirectResponse) { prev.status = p.redirectResponse.status; prev.done = true; prev.rid = `${p.requestId}~${prev.n}`; }
      const e = { n: ++tab.cseq, rid: p.requestId, method: p.request?.method ?? "GET", url: p.request?.url ?? "", type: p.type ?? "",
        start: p.timestamp, status: 0, size: 0, time: 0, failed: false, error: "", reqHeaders: p.request?.headers ?? {}, resHeaders: {} };
      tab.netById.set(p.requestId, e);
      tab.net.push(e);
      if (tab.net.length > MAX_NET) { const old = tab.net.shift(); if (tab.netById.get(old.rid) === old) tab.netById.delete(old.rid); }
      tab.dver++;
      break;
    }
    case "Network.responseReceived": {
      const e = tabFor(session)?.netById.get(p.requestId);
      if (e) { e.status = p.response?.status ?? 0; e.mime = p.response?.mimeType ?? ""; e.resHeaders = p.response?.headers ?? {}; e.type = p.type ?? e.type; tabFor(session).dver++; }
      break;
    }
    case "Network.loadingFinished": {
      const e = tabFor(session)?.netById.get(p.requestId);
      if (e) { e.size = p.encodedDataLength ?? 0; e.time = Math.round((p.timestamp - e.start) * 1000); e.done = true; tabFor(session).dver++; }
      break;
    }
    case "Network.loadingFailed": {
      const e = tabFor(session)?.netById.get(p.requestId);
      if (e) { e.failed = true; e.error = p.canceled ? "canceled" : p.errorText ?? "failed"; e.time = Math.round((p.timestamp - e.start) * 1000); e.done = true; tabFor(session).dver++; }
      break;
    }
    // ---- pick / annotate (Chrome's inspect mode) ----
    case "Overlay.nodeHighlightRequested":
      if (session === S.session) { S.hoverNode = p.nodeId; measureHover(p.nodeId, session); }
      break;
    case "Runtime.bindingCalled":
      // pick/annotate keys pressed in the page itself (native mode: the page has the keyboard)
      if (p.name === "__herdrKey" && session === S.session && S.inspect !== "off") {
        if (p.payload === "escape") setInspect("off").catch(() => {});
        else if (S.inspect === "pick" && (p.payload === "c" || p.payload === "s")) pickAction(p.payload === "c" ? "copy" : "shot").catch((e) => log("pick", e.message));
      }
      break;
    case "Overlay.inspectNodeRequested":
      if (session === S.session) inspected(p.backendNodeId).catch((e) => log("inspect", e.message));
      break;
    case "Page.lifecycleEvent":
      // Painted: let frames through a moment later (the painted frame is on its way).
      if (session === S.session && p.frameId === S.targetId && holdUntil > Date.now()
        && ["firstContentfulPaint", "firstMeaningfulPaint", "load"].includes(p.name)) hold(100);
      break;
    case "Page.navigatedWithinDocument":
      if (session === S.session && p.frameId === S.targetId) { S.url = p.url; refreshHistory().then(bump); bump(); }
      break;
  }
}

// ---- input ------------------------------------------------------------------------------

const MOD = (m = {}) => (m.alt ? 1 : 0) | (m.control || m.ctrl ? 2 : 0) | (m.platform || m.meta ? 4 : 0) | (m.shift ? 8 : 0);

const SPECIAL = {
  enter: ["Enter", "Enter", 13, "\r"], backspace: ["Backspace", "Backspace", 8], tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27], space: [" ", "Space", 32, " "], left: ["ArrowLeft", "ArrowLeft", 37],
  up: ["ArrowUp", "ArrowUp", 38], right: ["ArrowRight", "ArrowRight", 39], down: ["ArrowDown", "ArrowDown", 40],
  home: ["Home", "Home", 36], end: ["End", "End", 35], pageup: ["PageUp", "PageUp", 33],
  pagedown: ["PageDown", "PageDown", 34], delete: ["Delete", "Delete", 46], insert: ["Insert", "Insert", 45],
};
for (let i = 1; i <= 12; i++) SPECIAL[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];
const PUNCT = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188],
  ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
};

function keyInfo(name, shift) {
  const k = String(name ?? "").toLowerCase();
  if (SPECIAL[k]) { const [key, code, keyCode, text] = SPECIAL[k]; return { key, code, keyCode, text }; }
  if (/^[a-z]$/.test(k)) return { key: shift ? k.toUpperCase() : k, code: `Key${k.toUpperCase()}`, keyCode: k.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(k)) return { key: k, code: `Digit${k}`, keyCode: 48 + Number(k) };
  if (PUNCT[k]) return { key: k, code: PUNCT[k][0], keyCode: PUNCT[k][1] };
  return { key: name ?? "", code: "", keyCode: 0 };
}

function need() {
  if (!S.session) throw new Error("No page yet");
  return S.session;
}

// Input goes out without waiting for Chrome's ack: CDP keeps the socket's order, and a
// renderer that is busy (a heavy page, a navigation) must not hold up the next key.
function fire(method, params, session) {
  cdp.send(method, params, session, 10000).catch((e) => log(e.message));
}

function key(b) {
  const s = need();
  const m = b.modifiers ?? {};
  const altGr = (m.control || m.ctrl) && m.alt; // Windows AltGr arrives as ctrl+alt
  const bits = altGr ? MOD({ shift: m.shift }) : MOD(m);
  const info = keyInfo(b.key, m.shift);
  let text = b.text && (altGr || !(bits & (2 | 4))) ? b.text : undefined;
  if (!text && info.text && !(bits & (1 | 2 | 4))) text = info.text;
  if (text && text.length === 1 && text !== "\r" && !SPECIAL[String(b.key).toLowerCase()]) info.key = text;
  const base = {
    modifiers: bits, key: info.key, code: info.code,
    windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode, autoRepeat: Boolean(b.repeat),
  };
  fire("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) }, s);
  fire("Input.dispatchKeyEvent", { type: "keyUp", ...base }, s);
}

function mouse(b) {
  const s = need();
  const type = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" }[b.action];
  if (!type) throw new Error("action: down | up | move");
  const button = b.button ?? (type === "mouseMoved" ? "none" : "left");
  const bit = { left: 1, right: 2, middle: 4 }[button] ?? 0;
  const buttons = b.buttons ?? (type === "mousePressed" ? bit : 0);
  fire("Input.dispatchMouseEvent", {
    type, x: Number(b.x) || 0, y: Number(b.y) || 0, button, buttons,
    clickCount: type === "mouseMoved" ? 0 : Math.max(1, Number(b.clickCount) || 1), modifiers: MOD(b.modifiers),
  }, s);
}

function wheel(b) {
  const s = need();
  // The outline follows its element when the page scrolls under it.
  if (S.inspect !== "off" && S.hoverNode) setTimeout(() => S.hoverNode && measureHover(S.hoverNode, S.session), 90);
  fire("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: Number(b.x) || 0, y: Number(b.y) || 0,
    deltaX: Number(b.dx) || 0, deltaY: Number(b.dy) || 0, modifiers: MOD(b.modifiers),
  }, s);
}

// A batch from the mod, in order: [{ t: "mouse" | "wheel" | "key" | "text" | "paste" | "copy", ... }].
async function input(events) {
  let done = 0;
  lastInputAt = Date.now();
  const kinds = (Array.isArray(events) ? events : []).map((e) => (e.t === "mouse" ? `mouse-${e.action}` : e.t)).filter((k) => k !== "mouse-move");
  if (kinds.length) { PERF.inputAt = Date.now(); PERF.kind = kinds.join(","); PERF.chromeAt = 0; }
  else if (S.inspect !== "off" && !PERF.hoverAt) PERF.hoverAt = Date.now();
  for (const e of Array.isArray(events) ? events : []) {
    if (!S.session) break;
    try {
      if (e.t === "mouse") mouse(e);
      else if (e.t === "wheel") wheel(e);
      else if (e.t === "key") key(e);
      else if (e.t === "text") { if (e.text) fire("Input.insertText", { text: String(e.text) }, S.session); }
      else if (e.t === "paste") await paste();
      else if (e.t === "copy") await copy(e);
      done++;
    } catch (err) { log("input", e.t, err.message); }
  }
  return { ok: true, done };
}

// ---- system clipboard (headless Chrome keeps its own) -----------------------------------

function powershell(script, input, env) {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    let out = "", err = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.stderr.on("data", (d) => (err += d));
    ps.on("error", reject);
    ps.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `powershell exited ${code}`))));
    if (input !== undefined) ps.stdin.end(Buffer.from(input, "utf8")); else ps.stdin.end();
  });
}

// A program's stdout, with stdin from `input` (macOS and Linux clipboards).
function pipe(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`))));
    p.stdin.end(input === undefined ? undefined : Buffer.from(input, "utf8"));
  });
}
const wayland = () => Boolean(process.env.WAYLAND_DISPLAY);
const readClipboard = () => WIN ? powershell("[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $t = Get-Clipboard -Raw; if ($t) { [Console]::Out.Write($t) }")
  : MAC ? pipe("pbpaste", [])
  : wayland() ? pipe("wl-paste", ["--no-newline"]) : pipe("xclip", ["-selection", "clipboard", "-o"]);
// --no-clipboard (tests): what would be copied goes to clipboard-test.txt beside the log instead.
const writeClipboard = (text) => opt["no-clipboard"] === "true"
  ? fsp.writeFile(path.join(BASE, `clipboard-test${SUFFIX}.txt`), text)
  : WIN ? powershell("[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t", text)
  : MAC ? pipe("pbcopy", [], text)
  : wayland() ? pipe("wl-copy", [], text) : pipe("xclip", ["-selection", "clipboard"], text);

const SELECTION = `(() => {
  let d = document, a = d.activeElement;
  while (a && a.tagName === "IFRAME") { try { d = a.contentDocument; a = d.activeElement; } catch { break; } }
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number")
    return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(d.getSelection ? d.getSelection() : "");
})()`;

async function copy(b) {
  const s = need();
  const r = await cdp.send("Runtime.evaluate", { expression: SELECTION, returnByValue: true }, s).catch(() => null);
  const text = r?.result?.value ?? "";
  key({ key: b.cut ? "x" : "c", modifiers: { control: true } });
  if (text) await writeClipboard(text);
  return { ok: true, copied: text.length };
}

async function paste() {
  const s = need();
  const text = (await readClipboard()).replace(/\r\n/g, "\n");
  if (text) fire("Input.insertText", { text }, s);
  return { ok: true, pasted: text.length };
}

// ---- navigation -------------------------------------------------------------------------

function normalizeUrl(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?([/?#]|$)/.test(s)) return `http://${s}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[a-z0-9.-]+:\d+([/?#]|$)/i.test(s)) return s;
  if (!/\s/.test(s) && /^[^/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

async function navigate(raw) {
  const url = normalizeUrl(raw);
  if (!url) throw new Error("No URL");
  if (!S.session) await serial(() => ensurePage());
  S.url = url; S.loading = true; S.error = null; bump();
  const r = await cdp.send("Page.navigate", { url }, need(), 30000);
  if (r.errorText) { S.error = `${r.errorText} (${url})`; S.loading = false; bump(); }
  return { ok: !r.errorText, url, error: r.errorText };
}

async function history(delta) {
  const s = need();
  const h = await cdp.send("Page.getNavigationHistory", {}, s);
  const e = h.entries[h.currentIndex + delta];
  if (e) await cdp.send("Page.navigateToHistoryEntry", { entryId: e.id }, s);
}

// ---- debug drawer -----------------------------------------------------------------------

const shortUrl = (u) => { try { const x = new URL(u); return `${x.pathname.split("/").pop() || x.host}`; } catch { return String(u ?? ""); } };

function remoteText(a) {
  if (!a) return "";
  if (a.type === "string") return a.value;
  if (a.unserializableValue) return a.unserializableValue;
  if ("value" in a && a.type !== "object") return String(a.value);
  if (a.preview?.properties) {
    const inner = a.preview.properties.slice(0, 8).map((p) => (a.subtype === "array" ? p.value : `${p.name}: ${p.value}`)).join(", ");
    return a.subtype === "array" ? `[${inner}${a.preview.overflow ? ", …" : ""}]` : `${a.className && a.className !== "Object" ? `${a.className} ` : ""}{${inner}${a.preview.overflow ? ", …" : ""}}`;
  }
  if ("value" in a) return JSON.stringify(a.value);
  return a.description ?? a.type;
}

function pushConsole(tab, e) {
  e.n = ++tab.cseq;
  e.t = Date.now();
  if (e.text.length > 4000) e.text = `${e.text.slice(0, 4000)}…`;
  tab.console.push(e);
  if (tab.console.length > MAX_CONSOLE) tab.console.shift();
  tab.dver++;
}

function debugList(kind, since) {
  const tab = tabs.get(S.targetId);
  if (!tab) return { ver: 0, entries: [] };
  if (Number(since) === tab.dver) return { ver: tab.dver, same: true };
  const entries = kind === "network"
    ? tab.net.map((e) => ({ id: e.rid, n: e.n, method: e.method, url: e.url, type: e.type, status: e.status, size: e.size, time: e.time, failed: e.failed, error: e.error, done: Boolean(e.done) }))
    : tab.console;
  return { ver: tab.dver, entries };
}

// ---- pick / annotate --------------------------------------------------------------------

// Chrome's own inspect overlay: a light fill and its tag + size label, drawn into the frames.
// Chrome's inspect mode finds the element under the pointer and keeps clicks from the page; it
// draws nothing itself (all transparent): the panel draws the outline and label natively from
// state.hover, so it follows the pointer without waiting for a frame.
const CLEAR = { r: 0, g: 0, b: 0, a: 0 };
const HIGHLIGHT = {
  showInfo: false, showStyles: false, showAccessibilityInfo: false, showExtensionLines: false,
  contentColor: CLEAR, paddingColor: CLEAR, borderColor: CLEAR, marginColor: CLEAR,
};

// The hovered element's box (viewport CSS px) and its label: tag, id/classes, text, size.
const HOVER_INFO = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const r = el.getBoundingClientRect();
  const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
  const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim();
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, tag: el.localName + (el.id ? '#' + el.id : cls), text: text.slice(0, 40) };
}`;
// Natively the panel can't draw over the page (the page is a window above it), so the hovered
// element's outline and label chip are drawn in the page itself, in a shadow root that follows
// the element every animation frame: the same 2 px white outline with a dark halo and chip the
// panel draws over frames in screencast mode.
const OUTLINE = `function (label) {
  const el = this.nodeType === 1 ? this : this.parentElement;
  let o = window.__herdrOutline;
  if (!o) {
    const host = document.createElement('div');
    host.setAttribute('data-herdr', 'outline');
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    const root = host.attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #fff;border-radius:4px;box-shadow:0 0 0 1px rgba(0,0,0,.7),inset 0 0 0 1px rgba(0,0,0,.7);display:none';
    const chip = document.createElement('div');
    chip.style.cssText = 'position:fixed;height:21px;padding:0 7px;box-sizing:border-box;border-radius:5px;background:rgba(17,20,24,.93);border:1px solid rgba(255,255,255,.25);color:#fff;font:11px/19px "JetBrains Mono",Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none';
    root.append(box, chip);
    let cur = null, text = '', raf = 0;
    const place = () => {
      raf = 0;
      if (!cur || !cur.isConnected) { box.style.display = 'none'; chip.style.display = 'none'; return; }
      if (!host.isConnected) document.documentElement.appendChild(host);
      const r = cur.getBoundingClientRect(), W = innerWidth, H = innerHeight;
      box.style.display = ''; box.style.left = (r.left - 3) + 'px'; box.style.top = (r.top - 3) + 'px';
      box.style.width = (Math.max(2, r.width) + 6) + 'px'; box.style.height = (Math.max(2, r.height) + 6) + 'px';
      chip.textContent = text + '  ' + Math.round(r.width) + '\u00d7' + Math.round(r.height);
      const top = r.top - 26 >= 2 ? r.top - 26 : r.bottom + 26 <= H ? r.bottom + 5 : Math.max(2, r.top + 4);
      chip.style.display = ''; chip.style.top = top + 'px';
      chip.style.left = Math.max(4, Math.min(r.left - 3, W - 120)) + 'px'; chip.style.maxWidth = Math.max(100, W - Math.max(4, Math.min(r.left - 3, W - 120)) - 6) + 'px';
      raf = requestAnimationFrame(place);
    };
    o = window.__herdrOutline = {
      show(el, label) { cur = el; text = label; if (!raf) raf = requestAnimationFrame(place); },
      hide() { cur = null; box.style.display = 'none'; chip.style.display = 'none'; },
    };
  }
  o.show(el, label);
}`;
// The page's own keys while picking (the page has the keyboard natively): Esc leaves the mode,
// C and S copy or screenshot in pick mode.
const KEYS_INSTALL = `(() => {
  if (window.__herdrKeysOn !== undefined) { window.__herdrKeysOn = true; return; }
  window.__herdrKeysOn = true;
  addEventListener('keydown', (e) => {
    if (!window.__herdrKeysOn || typeof __herdrKey !== 'function') return;
    const k = (e.key || '').toLowerCase();
    if (k === 'escape' || (!e.ctrlKey && !e.altKey && !e.metaKey && (k === 'c' || k === 's'))) {
      e.preventDefault(); e.stopImmediatePropagation(); __herdrKey(k);
    }
  }, true);
})()`;
let hoverBusy = false, hoverNext = null, hoverSeq = 0;
async function measureHover(nodeId, session) {
  if (hoverBusy) { hoverNext = { nodeId, session }; return; }
  hoverBusy = true;
  try {
    const { object } = await cdp.send("DOM.resolveNode", { nodeId }, session, 3000);
    const r = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: HOVER_INFO, returnByValue: true }, session, 3000);
    cdp.send("Runtime.releaseObject", { objectId: object.objectId }, session).catch(() => {});
    if (session === S.session && S.inspect !== "off" && r.result?.value) {
      S.hover = { seq: ++hoverSeq, nodeId, ...r.result.value };
      bump();
      if (NATIVE) {
        const h = S.hover;
        cdp.send("DOM.resolveNode", { nodeId }, session, 3000)
          .then(({ object }) => cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: OUTLINE,
            arguments: [{ value: `${h.tag}${h.text ? ` "${h.text}"` : ""}` }] }, session, 3000)
            .finally(() => cdp.send("Runtime.releaseObject", { objectId: object.objectId }, session).catch(() => {})))
          .catch(() => {});
      }
      if (PERF.hoverAt) { PERF.hover.push(Date.now() - PERF.hoverAt); PERF.hoverAt = 0; if (PERF.hover.length > 200) PERF.hover.shift(); }
    }
  } catch {} finally {
    hoverBusy = false;
    if (hoverNext) { const n = hoverNext; hoverNext = null; measureHover(n.nodeId, n.session); }
  }
}

async function inspectOn(session, on) {
  try {
    if (on) {
      await cdp.send("DOM.enable", {}, session);
      await cdp.send("Overlay.enable", {}, session);
      await cdp.send("DOM.getDocument", { depth: 0 }, session);
      await cdp.send("Overlay.setInspectMode", { mode: "searchForNode", highlightConfig: HIGHLIGHT }, session);
      if (NATIVE) await cdp.send("Runtime.evaluate", { expression: KEYS_INSTALL }, session).catch(() => {});
    } else {
      await cdp.send("Overlay.setInspectMode", { mode: "none", highlightConfig: HIGHLIGHT }, session);
      await cdp.send("Overlay.hideHighlight", {}, session);
      if (NATIVE) await cdp.send("Runtime.evaluate", { expression: "window.__herdrOutline && window.__herdrOutline.hide(); window.__herdrKeysOn = false" }, session).catch(() => {});
    }
  } catch (e) { log("inspect mode", e.message); }
}

async function setInspect(mode) {
  const next = ["pick", "annotate"].includes(mode) ? mode : "off";
  if (next === S.inspect) return;
  const was = S.inspect;
  S.inspect = next;
  if (next === "off") { S.hover = null; S.hoverNode = null; }
  if (S.session) await inspectOn(S.session, next !== "off");
  if (was !== next) bump();
}

const ELEMENT_INFO = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  const r = el.getBoundingClientRect();
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s);
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.documentElement && parts.length < 5; n = n.parentElement) {
    if (n.id) { parts.unshift('#' + esc(n.id)); break; }
    let s = n.localName;
    const cls = [...n.classList].filter((c) => !/^\\d/.test(c) && c.length < 40).slice(0, 2);
    if (cls.length) s += '.' + cls.map(esc).join('.');
    const p = n.parentElement;
    if (p) { const same = [...p.children].filter((c) => c.localName === n.localName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
    parts.unshift(s);
  }
  const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim();
  return { tag: el.localName, selector: parts.join(' > '), text: text.slice(0, 140),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height }, scroll: { x: scrollX, y: scrollY },
    html: el.outerHTML.slice(0, 600) };
}`;

async function elementInfo(backendNodeId, session = S.session) {
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId }, session);
  const r = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: ELEMENT_INFO, returnByValue: true }, session);
  cdp.send("Runtime.releaseObject", { objectId: object.objectId }, session).catch(() => {});
  return r.result?.value;
}

// A PNG of the element's visible part, without the highlight or note markers on it.
async function elementShot(backendNodeId, info, session = S.session) {
  info = info ?? await elementInfo(backendNodeId, session);
  const r = info?.rect;
  if (!r) return null;
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(S.width, r.x + r.w), y1 = Math.min(S.height, r.y + r.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  await cdp.send("Overlay.hideHighlight", {}, session).catch(() => {});
  await cdp.send("Runtime.evaluate", { expression: "window.__herdrMarks && window.__herdrMarks.hide(true); window.__herdrOutline && window.__herdrOutline.hide()" }, session).catch(() => {});
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png",
      clip: { x: x0 + info.scroll.x, y: y0 + info.scroll.y, width: x1 - x0, height: y1 - y0, scale: 1 } }, session, 10000);
    const dir = path.join(BASE, "shots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `element-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23)}.png`);
    await fsp.writeFile(file, Buffer.from(shot.data, "base64"));
    // Keep the newest 300.
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 300))) fs.rmSync(path.join(dir, f), { force: true });
    return file;
  } finally {
    cdp.send("Runtime.evaluate", { expression: "window.__herdrMarks && window.__herdrMarks.hide(false)" }, session).catch(() => {});
  }
}

async function outerHtml(backendNodeId, session = S.session, max = 1_000_000) {
  const { outerHTML } = await cdp.send("DOM.getOuterHTML", { backendNodeId }, session);
  return outerHTML.length > max ? `${outerHTML.slice(0, max)}\n<!-- … cut at ${max} characters -->` : outerHTML;
}

// A click in inspect mode. Pick copies the element's HTML; annotate hands it to the panel
// (with a screenshot taken now, while it looks the way the person saw it).
async function inspected(backendNodeId) {
  const mode = S.inspect, session = S.session;
  // natively the panel freezes the page for the note popover: no hover outline in that still
  if (NATIVE) cdp.send("Runtime.evaluate", { expression: "window.__herdrOutline && window.__herdrOutline.hide()" }, session).catch(() => {});
  const info = await elementInfo(backendNodeId, session);
  if (!info) return;
  const shot = mode === "annotate" ? await elementShot(backendNodeId, info, session).catch(() => null) : null;
  S.picked = { seq: ++pickSeq, mode, targetId: S.targetId, url: S.url, title: S.title, backendNodeId, ...info, shot };
  if (mode === "pick") {
    const html = await outerHtml(backendNodeId, session);
    await writeClipboard(html);
    S.toast = { seq: ++toastSeq, text: `Copied <${info.tag}> HTML (${html.length.toLocaleString("en-US")} characters)` };
  }
  bump();
}

// Pick mode keys: C copies, S saves a screenshot of the hovered (else the last picked) element.
async function pickAction(action) {
  const s = S.session;
  let backendNodeId = null;
  if (S.hoverNode) {
    try { backendNodeId = (await cdp.send("DOM.describeNode", { nodeId: S.hoverNode }, s)).node.backendNodeId; } catch {}
  }
  backendNodeId = backendNodeId ?? (S.picked?.targetId === S.targetId ? S.picked.backendNodeId : null);
  if (!backendNodeId) { toast("Point at an element first"); return { ok: false }; }
  const info = await elementInfo(backendNodeId, s);
  if (action === "shot") {
    const file = await elementShot(backendNodeId, info, s);
    if (!file) { toast("That element isn't on screen"); return { ok: false }; }
    await writeClipboard(file);
    toast(`Saved a screenshot of <${info.tag}>; its path is copied`);
    if (S.inspect !== "off") inspectOn(s, true);
    return { ok: true, file };
  }
  const html = await outerHtml(backendNodeId, s);
  await writeClipboard(html);
  toast(`Copied <${info.tag}> HTML (${html.length.toLocaleString("en-US")} characters)`);
  return { ok: true };
}

// Numbered note markers on the page (annotate): a shadow-root layer in the page that follows
// the elements; hidden while element screenshots are taken.
const MARKS_INSTALL = `(() => {
  if (window.__herdrMarks) return;
  const host = document.createElement('div');
  host.setAttribute('data-herdr', 'marks');
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  const root = host.attachShadow({ mode: 'open' });
  const marks = [];
  const place = () => {
    if (!host.isConnected && marks.length) document.documentElement.appendChild(host);
    for (const m of marks) {
      if (!m.el.isConnected) { m.dot.style.display = 'none'; continue; }
      const r = m.el.getBoundingClientRect();
      const t = 'translate(' + Math.round(r.left + scrollX - 9) + 'px,' + Math.round(r.top + scrollY - 9) + 'px)';
      if (m.dot.style.transform !== t) m.dot.style.transform = t;
      m.dot.style.display = '';
    }
  };
  window.__herdrMarks = {
    set(list) {
      for (const m of marks) m.dot.remove();
      marks.length = 0;
      for (const { el, n } of list) {
        const dot = document.createElement('div');
        dot.textContent = n;
        dot.style.cssText = 'position:absolute;left:0;top:0;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#2f6feb;color:#fff;font:600 11px/18px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.45);outline:1.5px solid #fff';
        root.appendChild(dot);
        marks.push({ el, dot });
      }
      if (marks.length && !host.isConnected) document.documentElement.appendChild(host);
      if (!marks.length) host.remove();
      place();
    },
    hide(h) { host.style.display = h ? 'none' : ''; },
  };
  addEventListener('resize', place);
  setInterval(place, 800);
})()`;

async function setMarks(list) {
  const s = S.session;
  if (!s) return { ok: false };
  await cdp.send("Runtime.evaluate", { expression: MARKS_INSTALL }, s);
  const objs = [];
  for (const m of list ?? []) {
    try { objs.push({ n: m.n, id: (await cdp.send("DOM.resolveNode", { backendNodeId: m.backendNodeId }, s)).object.objectId }); } catch {}
  }
  const args = [{ value: objs.map((o) => o.n) }, ...objs.map((o) => ({ objectId: o.id }))];
  const { result } = await cdp.send("Runtime.evaluate", { expression: "window" }, s);
  await cdp.send("Runtime.callFunctionOn", { objectId: result.objectId, arguments: args,
    functionDeclaration: "function (nums, ...els) { window.__herdrMarks.set(els.map((el, i) => ({ el, n: nums[i] }))); }" }, s);
  for (const o of objs) cdp.send("Runtime.releaseObject", { objectId: o.id }, s).catch(() => {});
  return { ok: true, placed: objs.length };
}

async function pageHtml(what) {
  const s = S.session;
  if (what === "picked" && S.picked?.targetId === S.targetId) return outerHtml(S.picked.backendNodeId, s, 400_000);
  const r = await cdp.send("Runtime.evaluate", { returnByValue: true,
    expression: "(() => { const d = document.documentElement.cloneNode(true); d.querySelectorAll('[data-herdr]').forEach((e) => e.remove()); return '<!DOCTYPE html>\\n' + d.outerHTML; })()" }, s);
  const html = r.result?.value ?? "";
  return html.length > 400_000 ? `${html.slice(0, 400_000)}\n<!-- … cut at 400,000 characters -->` : html;
}

// ---- HTTP API ---------------------------------------------------------------------------

async function route(method, pathname, q, b) {
  if (pathname === "/state" || pathname === "/health") {
    // ?peek=1 reads the state without counting as someone watching (no screencast for it).
    if (q.get("peek")) return publicState();
    lastPoll = Date.now();
    if (!S.casting && S.session) startCast();
    const since = Number(q.get("since") ?? -1);
    const wait = Math.min(25000, Number(q.get("wait") ?? 0));
    if (since === S.ver && wait > 0) {
      activeWaits++;
      try {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, wait);
          waiters.push(() => { clearTimeout(t); resolve(); });
        });
      } finally { activeWaits--; lastPoll = Date.now(); }
    }
    return publicState();
  }
  if (pathname === "/debug") return { ok: true, ...debugList(q.get("kind"), q.get("since")) };
  if (pathname === "/debug-request") {
    const e = tabs.get(S.targetId)?.net.find((x) => x.rid === q.get("id"));
    if (!e) throw Object.assign(new Error("No such request"), { status: 404 });
    return { ok: true, ...e };
  }
  if (pathname === "/html") return { ok: true, html: await pageHtml(q.get("what")) };
  if (pathname === "/cookie-stats") {
    // How many cookies this browser can read, per site: counts only, never values.
    const { cookies } = await cdp.send("Storage.getCookies", {});
    const per = new Map();
    let readable = 0;
    for (const c of cookies) {
      const d = String(c.domain).replace(/^\./, "");
      per.set(d, (per.get(d) ?? 0) + 1);
      if (c.value) readable++;
    }
    return { ok: true, total: cookies.length, readable, sites: per.size,
      top: [...per].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([domain, count]) => ({ domain, count })) };
  }
  if (method !== "POST") throw Object.assign(new Error("POST please"), { status: 405 });
  // The API answers before Chrome is connected; actions wait for it (up to 20 s).
  if (!ready && pathname !== "/shutdown" && pathname !== "/detach") await Promise.race([readyPromise, sleep(20000)]);
  if (!cdp) throw Object.assign(new Error("The browser isn't connected yet"), { status: 503 });
  switch (pathname) {
    case "/navigate": return navigate(b.url);
    case "/back": await history(-1); return { ok: true };
    case "/forward": await history(1); return { ok: true };
    case "/reload": S.error = null; await cdp.send("Page.reload", { ignoreCache: Boolean(b.hard) }, need()); return { ok: true };
    case "/stop-loading": await cdp.send("Page.stopLoading", {}, need()); return { ok: true };
    case "/resize": {
      const w = Math.max(50, Math.min(8000, Math.round(Number(b.width) || S.width)));
      const h = Math.max(50, Math.min(8000, Math.round(Number(b.height) || S.height)));
      const sc = Math.max(0.5, Math.min(4, Number(b.scale) || S.scale));
      if (w !== S.width || h !== S.height || sc !== S.scale) {
        S.width = w; S.height = h; S.scale = sc;
        await applyMetrics();
        await restartCast();
        bump();
      }
      return { ok: true, width: w, height: h, scale: sc };
    }
    case "/input": return input(b.events);
    case "/mouse": mouse(b); return { ok: true };
    case "/wheel": wheel(b); return { ok: true };
    case "/key": key(b); return { ok: true };
    case "/text": if (b.text) fire("Input.insertText", { text: String(b.text) }, need()); return { ok: true };
    case "/copy": return copy(b);
    case "/paste": return paste();
    case "/target": if (!targets.has(b.id)) throw new Error("No such page"); await serial(() => follow(b.id)); return { ok: true };
    case "/close-target":
      if (NATIVE) await hostPost("/tabs/close", { id: b.id ?? S.targetId });
      else await cdp.send("Target.closeTarget", { targetId: b.id ?? S.targetId });
      return { ok: true };
    case "/tune": { // debugging: a fixed frame gap (0 = adaptive), a screencast pixel scale (0 = device)
      if (b.minFrameMs !== undefined) MIN_FRAME_MS = Number(b.minFrameMs);
      if (b.castScale !== undefined) { PERF.castScale = Number(b.castScale); await restartCast(); }
      return { ok: true, minFrameMs: MIN_FRAME_MS };
    }
    case "/perf": {
      // The panel's own numbers (render time, state->render) and the helper's input->frame latencies.
      if (b.mod) {
        // input -> the panel's render of the frame that showed it (same clock: one machine).
        const frames = b.mod.frames ?? [];
        const e2e = PERF.samples.map((x) => { const f = frames.find((r) => r.seq >= x.seq); return f ? { kind: x.kind, ms: f.at - x.at } : null; }).filter(Boolean);
        PERF.mod = { ...b.mod, frames: frames.length, e2e };
        const st = (a) => { const v = a.map((x) => x.ms).sort((p, q) => p - q); return v.length ? `n=${v.length} median=${v[v.length >> 1]} p90=${v[Math.floor(v.length * 0.9)]} max=${v[v.length - 1]}` : "none"; };
        log("perf mod", JSON.stringify({ ...b.mod, frames: frames.length }));
        log("perf e2e click", st(e2e.filter((x) => x.kind.includes("mouse-down"))), "| key", st(e2e.filter((x) => x.kind === "key")));
      }
      const out = { samples: PERF.samples, written: PERF.written, mod: PERF.mod, hover: PERF.hover, writeMs: PERF.writeMs };
      if (b.reset) { PERF.samples = []; PERF.written = 0; PERF.hover = []; PERF.writeMs = []; }
      return { ok: true, ...out };
    }
    case "/clipboard": await writeClipboard(String(b.text ?? "")); return { ok: true };
    case "/inspect": await setInspect(b.mode); return { ok: true, inspect: S.inspect };
    case "/pick-action": return pickAction(b.action);
    case "/marks": return setMarks(b.marks);
    case "/element-shot": return { ok: true, file: await elementShot(b.backendNodeId) };
    case "/debug-clear": {
      const tab = tabs.get(S.targetId);
      if (tab) { if (b.kind === "network") { tab.net = []; tab.netById.clear(); } else tab.console = []; tab.dver++; }
      return { ok: true };
    }
    case "/new": {
      const url = normalizeUrl(b.url) ?? DEFAULT_URL;
      const { targetId } = NATIVE ? { targetId: (await hostPost("/tabs/new", { url })).id } : await cdp.send("Target.createTarget", { url });
      if (!targets.has(targetId)) targets.set(targetId, { id: targetId, url, title: "", order: ++order });
      await serial(() => follow(targetId));
      return { ok: true, targetId };
    }
    case "/shutdown":
      log("shutdown requested");
      setTimeout(() => shutdown(0, true), 10);
      return { ok: true };
    case "/detach":
      log("detach requested (browser keeps running)");
      setTimeout(() => shutdown(0, false), 10);
      return { ok: true };
  }
  throw Object.assign(new Error(`Unknown ${pathname}`), { status: 404 });
}

function reply(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  let b = {};
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw) { try { b = JSON.parse(raw); } catch { return reply(res, 400, { ok: false, error: "bad JSON" }); } }
  }
  try { reply(res, 200, (await route(req.method, u.pathname, u.searchParams, b)) ?? { ok: true }); }
  catch (e) { reply(res, e.status ?? 500, { ok: false, error: String(e.message ?? e) }); }
});

// ---- lifecycle --------------------------------------------------------------------------

let ready = false;
let exiting = false;
let setReady;
const readyPromise = new Promise((r) => (setReady = r));

async function shutdown(code, closeBrowser) {
  if (exiting) return;
  exiting = true;
  if (closeBrowser && NATIVE) await hostPost("/shutdown", {}, 3000).catch(() => {});
  else if (closeBrowser && cdp && !cdp.closed) {
    await cdp.send("Browser.close", {}, undefined, 3000).catch(() => {});
  }
  try { server.close(); } catch {}
  clearFrames();
  log("helper exit", code);
  process.exit(code);
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", (e) => reject(e.code === "EADDRINUSE" ? new Error(`API port ${API_PORT} is in use (another helper?)`) : e));
    server.listen(API_PORT, "127.0.0.1", resolve);
  });
  log(`api http://127.0.0.1:${API_PORT}  cdp http://127.0.0.1:${CDP_PORT}  frames ${FRAMES_DIR}`);
  clearFrames();
  makeBuckets();

  let v = await cdpVersion();
  // A busy browser can be slow to answer: if the port is open, give it longer before
  // starting another (a second Chrome on the same profile would only hand off and quit).
  if (!v && (await portOpen())) v = (await cdpVersion(8000)) ?? (await cdpVersion(8000));
  if (NATIVE) {
    try { v = await nativeBrowser(v); }
    catch (e) {
      // no native view: the screencast it is
      log("native view unavailable:", e.message, "- using the screencast");
      NATIVE = false;
      S.error = null;
      v = await cdpVersion();
    }
  }
  if (v) log("reusing browser on port", CDP_PORT, v.Browser);
  else if (await portOpen()) throw new Error(`Port ${CDP_PORT} is taken but doesn't answer as a browser`);
  else v = await launchBrowser();
  S.browser = v.Browser ?? "";
  cdp = new Cdp(v.webSocketDebuggerUrl);
  await cdp.connect();
  cdp.onclose = () => { log("browser went away"); shutdown(0, false); };
  cdp.listeners.push(onEvent);

  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const t of targetInfos) if (t.type === "page") targets.set(t.targetId, { id: t.targetId, url: t.url, title: t.title, order: ++order });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  ready = true;
  for (const t of targets.values()) if (!internal(t.url)) attach(t.id).catch(() => {});

  let last = null;
  try { last = fs.readFileSync(path.join(BASE, `last-target${SUFFIX}`), "utf8").trim(); } catch {}
  await serial(() => (last && targets.has(last) ? follow(last) : ensurePage()));
  setReady();
  if (opt.url && S.url === "about:blank") navigate(opt.url).catch(() => {});

  setInterval(() => { if (!watching() && S.casting) stopCast(); }, 1000);
  if (NATIVE) hostWatch();
}

// Natively the host decides which tab shows (a page's popup opens as a tab there): follow it,
// and pick up pages it made that no event announced (an adopted popup changes target).
async function hostWatch() {
  let ver = -1;
  while (!exiting && NATIVE) {
    let hs = null;
    try {
      const r = await fetch(`${HOST}/state?since=${ver}&wait=8000`, { signal: AbortSignal.timeout(12000) });
      hs = r.ok ? await r.json() : null;
    } catch {}
    if (!hs?.ok) { await sleep(1000); continue; }
    ver = hs.ver;
    if ((hs.tabs ?? []).some((t) => t.id && !targets.has(t.id))) {
      try {
        const { targetInfos } = await cdp.send("Target.getTargets", {}, undefined, 5000);
        for (const t of targetInfos) if (t.type === "page" && !targets.has(t.targetId)) {
          targets.set(t.targetId, { id: t.targetId, url: t.url, title: t.title, order: ++order });
          attach(t.targetId).catch(() => {});
        }
        bump();
      } catch {}
    }
    if (hs.active && hs.active !== S.targetId && targets.has(hs.active)) serial(() => follow(hs.active));
  }
}

// The host's browser on CDP_PORT: reuse a running host, else close whatever else holds the
// port (the screencast's headless Chrome from before) and start the host.
async function nativeBrowser(v) {
  const hs = await hostState();
  if (hs?.ok && v) return v;
  if (hs?.ok) {
    for (let i = 0; i < 100 && !v; i++) { await sleep(150); v = await cdpVersion(); }
    if (v) return v;
    throw new Error("the host runs but its DevTools port doesn't answer");
  }
  if (v) {
    log("closing the browser on", CDP_PORT, v.Browser, "for the native view");
    try {
      const c = new Cdp(v.webSocketDebuggerUrl);
      await c.connect();
      await c.send("Browser.close", {}, undefined, 3000).catch(() => {});
    } catch {}
    for (let i = 0; i < 50 && (await portOpen()); i++) await sleep(150);
  }
  return launchHost();
}

process.on("SIGINT", () => shutdown(0, false));
process.on("SIGTERM", () => shutdown(0, false));
process.on("SIGBREAK", () => shutdown(0, false));
process.on("uncaughtException", (e) => { log("uncaught", e.stack || e); shutdown(1, false); });
process.on("unhandledRejection", (e) => { log("unhandled", e?.stack || e); });

main().catch((e) => { log("fatal", e.message); try { server.close(); } catch {} process.exit(2); });
