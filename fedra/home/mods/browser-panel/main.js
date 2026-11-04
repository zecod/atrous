// Browser: a real web page in the side panel, shared with coding agents.
//
// GPUI has no web view, so a small Node helper (helper.mjs, started in the background with
// `hc run --bg --name herdr-browser`) runs a headless Chrome with the DevTools Protocol on
// 127.0.0.1:9333 and streams the page it follows into JPEG frames in mods/browser-panel-frames/
// (a sibling folder, not a mod: frames written in this folder would reload this mod; see
// helper.mjs for why each frame has a new name). This panel draws the newest frame and sends
// clicks, scrolling and keys back through the helper's localhost API (127.0.0.1:9334).
//
// Agents drive the same Chrome, and a page an agent opens is followed so the person sees it:
//   Playwright:     chromium.connectOverCDP("http://127.0.0.1:9333")
//   Playwright MCP: --cdp-endpoint http://127.0.0.1:9333
//
// Starts lazily (the first time it is shown) and polls only while shown. Closing the panel
// leaves Chrome running for agents; the footer's Stop closes it.
//
// Props: { url? } the first page when it starts Chrome; { scale? } overrides the display scale.
// Commands (keys.json "browser-panel.<name>"): focus, url, back, forward, reload, stop, start,
// import (Import from Chrome, asks first), import-now, pick, annotate, debug[:console|network|elements],
// note:<text> (saves the open note), send-to:<terminal> (sends the notes there), new-tab[:<url>],
// open:<url>.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, hc, exec, appHome, props, layout, settings, nextCommand, keys, shared, run, readTextFile, watchFolder } from "herdr";
import { Notes } from "./notes.js";
import { Debug } from "./debug.js";

const MOD = "browser-panel";
const NAME = "herdr-browser"; // the helper's herdr-core terminal
const API_PORT = 9334;
const CDP_PORT = 9333;
const API = `http://127.0.0.1:${API_PORT}`;
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const FRAMES = `mods/${MOD}-frames`;
const I = (name) => `mods/${MOD}/icons/${name}.svg`;
const WAIT_FOR_WATCHER = true; // show a new frame only once herdr's watcher has reported its file (see apply)
const LAYERS = 3; // frames stacked, newest on top: one still loading never leaves a hole
const MIN_REDRAW_MS = 45; // at most ~20 redraws a second, only while frames change
const WIDE = 680; // px: the side panel's width while the browser shows, when it was narrower (as Files does for a file)
const IMPORT = "herdr-browser-import"; // the Import from Chrome run's herdr-core terminal
const TABS_H = 34; // the tab strip
const BAR_H = 42; // the toolbar
const BIT = { left: 1, right: 2, middle: 4 };
const MODIFIER_KEYS = new Set(["shift", "control", "ctrl", "alt", "platform", "cmd", "super", "win", "capslock", "fn", "function"]);

const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function api(path, body) {
  const r = await fetch(`${API}${path}`, post(body));
  return r.json();
}

function findPath(node, path = []) {
  if (!node || typeof node !== "object") return null;
  const here = [...path, node];
  if (node.content?.mod === MOD) return here;
  for (const child of node.children ?? []) {
    const found = findPath(child, here);
    if (found) return found;
  }
  return null;
}

// On screen now: nothing above this block is hidden and every stack above shows our branch.
// A mod pane or an overlay isn't in the layout tree: it's shown while it lives.
function shownInLayout() {
  let path;
  try { path = findPath(layout()); } catch { return true; }
  if (!path) return true;
  for (let i = 0; i < path.length; i++) {
    const n = path[i];
    if (n.hidden) return false;
    if (n.type === "stack" && i + 1 < path.length && (n.active ?? n.children?.[0]?.id) !== path[i + 1].id) return false;
  }
  return true;
}

// Windows' display scale (AppliedDPI / 96): frames are rendered at physical pixels.
async function osScale() {
  try {
    const r = await exec("reg", ["query", "HKCU\\Control Panel\\Desktop\\WindowMetrics", "/v", "AppliedDPI"]);
    const m = /AppliedDPI\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r.stdout);
    if (m) return parseInt(m[1], 16) / 96;
  } catch {}
  return 1;
}

// One spelling for a key chord, whatever order its modifiers were written in.
function chord(stroke) {
  const s = String(stroke ?? "").toLowerCase().trim();
  let key, mods;
  if (s === "-") { key = "-"; mods = []; }
  else if (s.endsWith("--")) { key = "-"; mods = s.slice(0, -2).split("-"); }
  else { mods = s.split("-"); key = mods.pop(); }
  const alias = { control: "ctrl", option: "alt", super: "cmd", win: "cmd", platform: "cmd" };
  return [...mods.filter(Boolean).map((m) => alias[m] ?? m).sort(), key].join("-");
}

// The node that sizes this block (the side panel column): its nearest ancestor with a px size.
function sizedAncestor() {
  let path;
  try { path = findPath(layout()); } catch { return null; }
  for (let i = (path?.length ?? 0) - 2; i >= 0; i--) if (path[i]?.id && path[i]?.size?.px) return path[i];
  return null;
}

// A frame path as herdr's watcher and the helper name it, in one spelling: relative to the
// app home, forward slashes, lowercase (Windows paths are case-insensitive).
function norm(p) {
  const home = appHome().replace(/\\/g, "/").toLowerCase();
  // herdr's watcher reports extended-length paths on Windows: \\?\C:\...
  let s = String(p ?? "").replace(/\\/g, "/").toLowerCase().replace(/^\/\/\?\//, "");
  if (s.startsWith(home)) s = s.slice(home.length);
  return s.replace(/^\/+/, "");
}

const isWeb = (url) => /^https?:\/\//i.test(url ?? "");
const hostOf = (url) => { try { return new URL(url).host; } catch { return url ?? ""; } };

export default class Browser extends View {
  init(_props, cx) {
    this.st = null; // the helper's last state
    this.ver = -1;
    this.frames = []; // frame paths, newest last
    this.area = null; // the page area, logical px
    this.os = null; // display scale
    this.visible = false;
    this.loopGen = 0;
    this.looping = false;
    this.connected = false;
    this.starting = false;
    this.stopped = false;
    this.status = "";
    this.flash = null;
    this.queue = [];
    this.sending = false;
    this.buttons = 0;
    this.urlFocused = false;
    this.showPages = false;
    this.copied = false;
    this.pendingUrl = null;
    this.menu = false; // the "more" menu
    this.imp = null; // Import from Chrome: { phase: "confirm" | "running" | "done" | "error", ... }
    this.importing = false; // while true the helper isn't restarted
    this.rootW = 0; this.rootH = 600;
    this.seenFrames = new Set(); // frame files herdr's watcher has reported (normalized paths)
    this.waiting = null; // the newest frame, until its file has been reported
    this.initNotes();
    this.initDebug(cx);
    this.handle = cx.focus_handle();
    this.url = InputState.new({ placeholder: "Search or type a URL" });
    this.url.on("submit", (_e, cx) => this.go(this.url.value(), cx));
    this.url.on("focus", (_e, cx) => { this.urlFocused = true; cx.notify(); });
    this.url.on("blur", (_e, cx) => { this.urlFocused = false; this.syncUrl(); cx.notify(); });
    cx.spawn(async (cx) => { this.os = await osScale(); cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
      }
    });
    // Layout changes (panel shown, another stack child picked) re-render us; this is a backstop.
    cx.timer.every(2000, (cx) => this.wake(cx));
  }

  scale() {
    const zoom = Number(settings()?.zoom) || 1;
    return (Number(props()?.scale) || this.os || 1) * zoom;
  }

  isShown() {
    return props()?.overlay ? true : shownInLayout();
  }

  wake(cx) {
    this.visible = this.isShown();
    this.fitPanel();
    if (this.visible && this.area && this.os && !this.looping && !this.stopped) this.loop(cx);
  }

  // A page needs room: while the browser shows, a side panel narrower than WIDE is widened,
  // and put back to its old width when the browser stops showing (unless the person resized
  // it meanwhile). Never from render (run() is ignored there): from wake or a task.
  fitPanel() {
    if (props()?.overlay) return;
    const node = sizedAncestor();
    if (!node) return;
    const from = Number(localStorage.getItem("panel-was")) || 0;
    if (this.visible && !from && node.size.px < WIDE) {
      localStorage.setItem("panel-was", String(node.size.px));
      run("layout.resize", { id: node.id, px: WIDE });
    } else if (!this.visible && from) {
      localStorage.removeItem("panel-was");
      if (node.size.px === WIDE) run("layout.resize", { id: node.id, px: from });
    }
  }

  // ---- talking to the helper ----

  loop(cx) {
    this.watchFrames(cx);
    this.looping = true;
    const gen = ++this.loopGen;
    cx.spawn(async (cx) => {
      let fails = 0;
      try {
        while (gen === this.loopGen && this.visible && !this.stopped) {
          let st = null;
          try {
            const r = await fetch(`${API}/state?since=${this.ver}&wait=8000`);
            if (r.ok) st = await r.json();
          } catch {}
          if (gen !== this.loopGen || !this.visible || this.stopped) break;
          if (!st?.ok) {
            fails++;
            if (this.connected) { this.connected = false; this.ver = -1; cx.notify(); }
            if (!this.stopped && !this.importing) await this.ensureHelper(cx);
            await cx.sleep(Math.min(2000, 250 * fails));
            continue;
          }
          fails = 0;
          const changed = st.ver !== this.ver || !this.connected;
          if (!this.connected) { this.connected = true; this.status = ""; this.onConnect(cx); }
          if (changed) {
            const prev = this.st;
            if (st.frame !== prev?.frame) this.stateAt = Date.now();
            this.apply(st);
            this.afterApply(prev, cx);
            this.resize(cx);
            cx.notify();
          }
          // Right after input, the next frame shows as soon as it exists; otherwise redraws are spaced.
          await cx.sleep(Date.now() - (this.lastInputAt ?? 0) < 1500 ? 30 : MIN_REDRAW_MS);
        }
      } finally {
        if (gen === this.loopGen) this.looping = false;
      }
    });
  }

  apply(st) {
    const before = this.st?.url;
    this.ver = st.ver;
    this.st = st;
    if (st.frame && st.frame !== this.frames[this.frames.length - 1]?.path && st.frame !== this.waiting?.path) {
      const f = { path: st.frame, w: st.frameW, h: st.frameH, at: Date.now() };
      // A frame file herdr's watcher hasn't reported yet would be dropped and reloaded by herdr
      // the moment it does, a few tens of ms after it's on screen: for one frame the picture
      // under it (the previous frame) shows again. That was the flicker. So a new file is shown
      // only once the watcher has reported it (watchFrames); one it has seen shows right away.
      if (!WAIT_FOR_WATCHER || this.seenFrames.has(norm(st.frame))) this.showFrame(f);
      else {
        // A newer frame takes the waiting one's place, and its start: the timeout counts from the
        // first frame not yet shown, so a steady stream can't hold the picture back.
        if (this.waiting) f.at = this.waiting.at;
        this.waiting = f;
      }
    }
    if (!this.urlFocused && st.url !== before) this.syncUrl();
  }

  showFrame(f, timedOut) {
    if (this.waiting && (this.waiting === f || this.waiting.path === f.path)) this.waiting = null;
    const p = this.perf ?? (this.perf = { renders: 0, ms: [], wait: [], since: Date.now() });
    (p.watchWait ??= []).push(Date.now() - f.at);
    if (timedOut) p.timeouts = (p.timeouts ?? 0) + 1;
    if (f.path === this.frames[this.frames.length - 1]?.path) return;
    this.frames.push(f);
    if (this.frames.length > LAYERS) this.frames.shift();
  }

  // herdr's own watcher, the one that drops changed images, reporting the frames folder.
  watchFrames(cx) {
    if (this.watchingFrames) return;
    this.watchingFrames = true;
    const dir = `${appHome().replace(/\\/g, "/")}/${FRAMES}`;
    cx.spawn(async (cx) => {
      for (;;) {
        let paths = [];
        try { paths = await watchFolder(dir); } catch { await cx.sleep(1000); continue; }
        let all = false;
        for (const p of paths) {
          const n = norm(p);
          if (n === norm(dir)) all = true;
          this.seenFrames.add(n);
        }
        while (this.seenFrames.size > 200) this.seenFrames.delete(this.seenFrames.values().next().value);
        const w = this.waiting;
        if (w && (all || this.seenFrames.has(norm(w.path)))) {
          // herdr handles the event in the same pass; one more frame of margin, then show it
          await cx.sleep(16);
          if (this.waiting === w) { this.showFrame(w); cx.notify(); }
        }
      }
    });
    // Never wait forever on a report that doesn't come.
    cx.timer.every(100, (cx) => {
      const w = this.waiting;
      if (w && Date.now() - w.at > 400) { this.showFrame(w, true); cx.notify(); }
    });
  }

  onConnect(cx) {
    const url = this.pendingUrl;
    this.pendingUrl = null;
    if (url) this.call("/navigate", { url }, cx);
  }

  async ensureHelper(cx) {
    if (this.starting || this.stopped || this.importing) return;
    this.starting = true;
    try {
      const g = await hc(["get", NAME, "--json"]).catch(() => null);
      let info = null;
      try { info = g?.code === 0 ? JSON.parse(g.stdout) : null; } catch {}
      if (info?.state === "live") {
        // Still starting Chrome, or stuck: give it 25 s, then replace it.
        if (Date.now() - (info.created_ms ?? 0) < 25000) { this.status = "Starting the browser…"; return; }
        await hc(["kill", NAME]).catch(() => {});
      }
      if (info) await hc(["rm", NAME]).catch(() => {});
      this.status = "Starting the browser…";
      cx.notify();
      const home = appHome().replace(/\\/g, "/");
      const a = this.area ?? { width: 800, height: 600 };
      const args = ["run", "--bg", "--json", "--no-parent", "--no-notify", "--rm", "--name", NAME,
        "--cwd", `${home}/mods/${MOD}`, "--",
        "node", `${home}/mods/${MOD}/helper.mjs`,
        "--port", String(API_PORT), "--cdp-port", String(CDP_PORT), "--home", home, "--frames", FRAMES,
        "--width", String(Math.round(a.width)), "--height", String(Math.round(a.height)), "--scale", String(this.scale())];
      if (props()?.url) args.push("--url", String(props().url));
      const r = await hc(args);
      if (r.code !== 0) this.status = `Couldn't start the browser helper: ${(r.stderr || r.stdout).trim()}`;
    } catch (e) {
      this.status = `Couldn't start the browser helper: ${String(e?.message ?? e)}`;
    } finally {
      this.starting = false;
      cx.notify();
    }
  }

  resize(cx) {
    const st = this.st;
    if (!st || !this.area || this.resizing) return;
    const w = Math.round(this.area.width), h = Math.round(this.area.height), s = this.scale();
    if (w < 50 || h < 50) return;
    if (st.width === w && st.height === h && Math.abs(st.scale - s) < 0.001) return;
    this.resizing = true;
    cx.spawn(async () => {
      try { await api("/resize", { width: w, height: h, scale: s }); } catch {}
      finally { this.resizing = false; }
    });
  }

  call(path, body, cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await api(path, body);
        if (r?.ok === false && r.error) { this.flash = r.error; cx.notify(); }
      } catch {
        if (path === "/navigate") this.pendingUrl = body?.url ?? null;
      }
    });
  }

  // Input goes out in order, one request at a time; moves and wheel turns are coalesced.
  send(ev, cx) {
    this.lastInputAt = Date.now();
    if (!this.connected) return;
    const q = this.queue, last = q[q.length - 1];
    if (ev.t === "mouse" && ev.action === "move" && last?.t === "mouse" && last.action === "move") q[q.length - 1] = ev;
    else if (ev.t === "wheel" && last?.t === "wheel") { last.dx += ev.dx; last.dy += ev.dy; last.x = ev.x; last.y = ev.y; }
    else q.push(ev);
    if (this.sending) return;
    this.sending = true;
    cx.spawn(async () => {
      try {
        while (this.queue.length) {
          const events = this.queue.splice(0);
          try { await api("/input", { events }); } catch {}
        }
      } finally { this.sending = false; }
    });
  }

  // ---- actions ----

  go(text, cx) {
    const url = String(text ?? "").trim();
    if (!url) return;
    this.flash = null;
    this.handle.focus(); // leave the address bar, as a browser does
    if (!this.connected) { this.pendingUrl = url; this.wake(cx); return; }
    this.call("/navigate", { url }, cx);
  }

  syncUrl() {
    const u = this.st?.url ?? "";
    this.url.set_value(u === "about:blank" ? "" : u);
  }

  focusUrl() {
    this.url.focus();
    const v = this.url.value();
    this.url.set_selected_range({ start: 0, end: v.length });
  }

  stopBrowser(cx) {
    this.stopped = true;
    this.loopGen++;
    this.looping = false;
    this.connected = false;
    this.frames = [];
    this.st = null;
    this.ver = -1;
    this.showPages = false;
    this.url.set_value("");
    cx.spawn(async (cx) => {
      try { await api("/shutdown", {}); } catch {}
      await cx.sleep(4000);
      // The helper exits once Chrome is gone; make sure nothing lingers.
      const g = await hc(["get", NAME, "--json"]).catch(() => null);
      if (g?.code === 0) await hc(["kill", NAME]).catch(() => {});
    });
    cx.notify();
  }

  startBrowser(cx) {
    this.stopped = false;
    this.status = "Starting the browser…";
    this.wake(cx);
    cx.notify();
  }

  openOutside(cx) {
    const url = this.st?.url;
    if (!isWeb(url)) return;
    cx.spawn(async () => { await exec("rundll32", ["url.dll,FileProtocolHandler", url]).catch(() => {}); });
  }

  copyEndpoint(cx) {
    cx.spawn(async (cx) => {
      await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Set-Clipboard -Value '${CDP}'`]).catch(() => {});
      this.copied = true;
      cx.notify();
      await cx.sleep(1400);
      this.copied = false;
      cx.notify();
    });
  }

  // ---- Import from Chrome ----
  // Closes this browser, copies the person's Chrome profile data in (import-chrome.mjs, run in
  // the background: a big history can outlast exec's 30 s), starts it again and reloads the page.
  // Cookies are counted before and after (never read), to say what really came over.

  importStep(text, cx) {
    this.imp = { phase: "running", step: text };
    cx.notify();
  }

  startImport(cx) {
    if (this.importing) return;
    this.importing = true;
    this.menu = false;
    const back = isWeb(this.st?.url) ? this.st.url : null;
    this.importStep("Counting this browser's cookies…", cx);
    cx.spawn(async (cx) => {
      const stats = async () => { try { const r = await fetch(`${API}/cookie-stats`); return r.ok ? await r.json() : null; } catch { return null; } };
      const browserUp = async () => { try { return (await fetch(`${CDP}/json/version`)).ok; } catch { return false; } };
      try {
        const before = this.connected ? await stats() : null;
        this.importStep("Closing this browser for the copy…", cx);
        this.loopGen++;
        this.looping = false;
        this.connected = false;
        this.frames = [];
        this.st = null;
        this.ver = -1;
        try { await api("/shutdown", {}); } catch {}
        for (let i = 0; i < 40 && (await browserUp()); i++) await cx.sleep(250);
        if (await browserUp()) throw new Error("This browser didn't close, so nothing was copied.");
        this.importStep("Copying from Chrome…", cx);
        const report = await this.runImporter(cx);
        this.importStep("Starting this browser again…", cx);
        this.importing = false;
        this.pendingUrl = back;
        this.wake(cx);
        for (let i = 0; i < 120 && !this.connected; i++) await cx.sleep(250);
        await cx.sleep(1500); // cookies load with the first page
        const after = this.connected ? await stats() : null;
        this.imp = { phase: "done", report, before, after };
      } catch (e) {
        this.imp = { phase: "error", message: String(e?.message ?? e) };
      } finally {
        if (this.importing) { this.importing = false; this.wake(cx); }
        cx.notify();
      }
    });
  }

  async runImporter(cx) {
    const local = (await exec("cmd", ["/c", "echo", "%LOCALAPPDATA%"])).stdout.trim().replace(/\\/g, "/");
    const reportFile = `${local}/herdr-browser/import-report.json`;
    const home = appHome().replace(/\\/g, "/");
    await hc(["kill", IMPORT]).catch(() => {});
    await hc(["rm", IMPORT]).catch(() => {});
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", IMPORT, "--cwd", `${home}/mods/${MOD}`, "--",
      "node", `${home}/mods/${MOD}/import-chrome.mjs`, "--report", reportFile, "--cdp-port", String(CDP_PORT)]);
    if (r.code !== 0) throw new Error(`Couldn't start the import: ${(r.stderr || r.stdout).trim()}`);
    const started = Date.now();
    for (;;) {
      await cx.sleep(600);
      const g = await hc(["get", IMPORT, "--json"]).catch(() => null);
      let info = null;
      try { info = g?.code === 0 ? JSON.parse(g.stdout) : null; } catch {}
      if (!info || info.state === "finished") break;
      if (Date.now() - started > 5 * 60000) { await hc(["kill", IMPORT]).catch(() => {}); throw new Error("The import took over 5 minutes and was stopped."); }
    }
    await hc(["rm", IMPORT]).catch(() => {});
    const text = await readTextFile(reportFile);
    const report = text ? JSON.parse(text) : null;
    if (!report || Date.parse(report.started) < started - 60000) throw new Error("The import didn't write its report.");
    if (report.error) throw new Error(report.error);
    return report;
  }

  command(c, cx) {
    const s = String(c ?? "");
    const i = s.indexOf(":");
    const name = i < 0 ? s : s.slice(0, i), arg = i < 0 ? "" : s.slice(i + 1);
    if (name === "pick" || name === "annotate") this.setMode(name, cx);
    else if (name === "perf") this.perfReport(cx);
    else if (name === "debug") { if (!this.dbg.open || !arg) this.toggleDebug(cx); if (arg) this.dbgTab(arg, cx); }
    else if (name === "note" && this.draft) { this.noteBox.set_value(arg); this.addNote(cx); }
    else if (name === "send-to" && arg && this.notes.length) this.sendToSession({ address: arg, title: arg }, cx);
    else if (name === "new-tab") this.call("/new", { url: arg || undefined }, cx);
    else if (name === "import") { this.imp = { phase: "confirm" }; this.menu = false; }
    else if (name === "import-now") this.startImport(cx);
    else if (name === "focus") this.handle.focus();
    else if (name === "url") this.focusUrl();
    else if (name === "back") this.call("/back", {}, cx);
    else if (name === "forward") this.call("/forward", {}, cx);
    else if (name === "reload") this.call("/reload", {}, cx);
    else if (name === "stop") this.stopBrowser(cx);
    else if (name === "start") this.startBrowser(cx);
    else if ((name === "open" || name === "navigate") && arg) this.go(arg, cx);
    cx.notify();
  }

  // ---- pointer and keys on the page ----

  fit() {
    const st = this.st, a = this.area;
    if (!st?.frameW || !st?.frameH || !a) return null;
    const s = Math.min(a.width / st.frameW, a.height / st.frameH);
    return { s, w: st.frameW * s, h: st.frameH * s };
  }

  toPage(e, clamp) {
    const f = this.fit(), p = e.local_position;
    if (!f || !p) return null;
    let x = p.x / f.s, y = p.y / f.s;
    if (!clamp && (x < 0 || y < 0 || x > this.st.frameW || y > this.st.frameH)) return null;
    x = Math.max(0, Math.min(this.st.frameW - 1, x));
    y = Math.max(0, Math.min(this.st.frameH - 1, y));
    return { x, y };
  }

  press(e, button, cx) {
    this.handle.focus();
    if (this.menu || this.sendMenu) { this.menu = false; this.sendMenu = null; cx.notify(); }
    cx.stop_propagation();
    const p = this.toPage(e);
    if (!p) return;
    this.buttons |= BIT[button];
    this.send({ t: "mouse", action: "down", x: p.x, y: p.y, button, buttons: this.buttons, clickCount: e.click_count || 1, modifiers: e.modifiers }, cx);
  }

  release(e, button, cx) {
    if (!(this.buttons & BIT[button])) return;
    this.buttons &= ~BIT[button];
    const p = this.toPage(e, true);
    if (!p) return;
    this.send({ t: "mouse", action: "up", x: p.x, y: p.y, button, buttons: this.buttons, clickCount: e.click_count || 1, modifiers: e.modifiers }, cx);
  }

  move(e, cx) {
    const p = this.toPage(e, Boolean(this.buttons));
    if (!p) return;
    const button = this.buttons & 1 ? "left" : this.buttons & 2 ? "right" : this.buttons & 4 ? "middle" : "none";
    this.send({ t: "mouse", action: "move", x: p.x, y: p.y, button, buttons: this.buttons, modifiers: e.modifiers }, cx);
  }

  wheel(e, cx) {
    cx.stop_propagation();
    const p = this.toPage(e, true) ?? { x: 10, y: 10 };
    // GPUI: positive y scrolls up; CDP: positive deltaY scrolls down. A wheel notch is
    // 3 lines on Windows, which Chrome turns into 100 px.
    const lines = e.delta_lines;
    const dx = lines ? -lines.x * 33.34 : -(e.delta?.x ?? 0) / (this.fit()?.s || 1);
    const dy = lines ? -lines.y * 33.34 : -(e.delta?.y ?? 0) / (this.fit()?.s || 1);
    if (!dx && !dy) return;
    this.send({ t: "wheel", x: p.x, y: p.y, dx, dy, modifiers: e.modifiers }, cx);
  }

  // Keys Herdr binds (keys.json: global, this layout's, this mod's) stay Herdr's, so alt-h /
  // alt-left still leave the panel and ctrl-tab still switches tabs.
  herdrKeys() {
    const layoutName = String(shared("layout") ?? "");
    const sections = new Set(["global", `layout:${layoutName}`, `mod:${MOD}`]);
    let list = [];
    try { list = keys(); } catch {}
    const sig = `${layoutName}|${list.length}`;
    if (this.keySig !== sig) {
      this.keySig = sig;
      this.bound = new Set(list.filter((b) => sections.has(b.section)).map((b) => chord(b.keys)));
    }
    return this.bound;
  }

  key(e, cx) {
    const m = e.modifiers ?? {};
    const k = String(e.key ?? "").toLowerCase();
    if (MODIFIER_KEYS.has(k)) return;
    if (this.draft) return; // typing in the note popover
    if (this.herdrKeys().has(chord(e.keystroke))) return;
    const mode = this.inspectMode();
    if (mode !== "off" && !m.control && !m.alt && !m.platform) {
      if (k === "escape") { cx.stop_propagation(); return this.setMode(mode, cx); }
      if (mode === "pick" && (k === "c" || k === "s")) { cx.stop_propagation(); return this.call("/pick-action", { action: k === "c" ? "copy" : "shot" }, cx); }
    }
    const ctrl = (m.control || m.platform) && !m.alt;
    cx.stop_propagation();
    if (ctrl && !m.shift && k === "l") return this.focusUrl();
    if ((ctrl && k === "r") || k === "f5") return this.call("/reload", { hard: Boolean(m.shift || ctrl && k === "f5") }, cx);
    // Headless Chrome has a clipboard of its own: copy and paste go through the system's.
    if (ctrl && !m.shift && k === "v") return this.send({ t: "paste" }, cx);
    if (ctrl && !m.shift && (k === "c" || k === "x")) return this.send({ t: "copy", cut: k === "x" }, cx);
    this.send({ t: "key", key: k, text: e.key_char ?? undefined, modifiers: m, repeat: Boolean(e.is_held) }, cx);
  }

  // ---- drawing ----

  iconButton(id, icon, tip, enabled, action, t) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.muted)
      .when(!enabled, (el) => el.opacity(0.4))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action))
      .tooltip(tip)
      .child(svg(I(icon)).size(15));
  }

  header(t) {
    const st = this.st, on = this.connected;
    const pages = st?.targets?.length ?? 0;
    const secure = /^https:/i.test(st?.url ?? "");
    return h_flex().id("bp-toolbar").relative().h(BAR_H).flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border)
      .child(this.iconButton("bp-back", "arrow-left", "Back", on && st?.canGoBack, (_e, cx) => this.call("/back", {}, cx), t))
      .child(this.iconButton("bp-forward", "arrow-right", "Forward", on && st?.canGoForward, (_e, cx) => this.call("/forward", {}, cx), t))
      .child(st?.loading
        ? this.iconButton("bp-stop-loading", "x", "Stop loading", on, (_e, cx) => this.call("/stop-loading", {}, cx), t)
        : this.iconButton("bp-reload", "rotate-cw", "Reload (Ctrl+R)", on, (_e, cx) => this.call("/reload", {}, cx), t))
      .child(h_flex().id("bp-address").flex_1().min_w(0).h(28).ml(4).pl(9).gap(6).items_center().rounded(7).border_1()
        .border_color(this.urlFocused ? t.accent : t.input).bg(t.surface)
        .on_key_down((e, cx) => {
          if (e.key === "escape") { cx.stop_propagation(); this.syncUrl(); this.handle.focus(); cx.notify(); }
        })
        .child(svg(I(secure ? "lock" : "globe")).size(12).flex_none().text_color(t.dim))
        .child(Input.new(this.url).flex_1().min_w(0).h(26).pr(8).text_size(12.5).text_color(t.foreground)))
      .when(this.rootW >= 600, (el) => el.child(h_flex().id("bp-import-pill").h(26).px(9).gap(5).ml(2).flex_none().items_center().rounded(13)
        .border_1().border_color(t.input).text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.menu = false; this.imp = { phase: "confirm" }; cx.notify(); })
        .tooltip("Import bookmarks, history and passwords from Chrome").child(svg(I("import")).size(12)).child("Import")))
      .child(div().w(4).flex_none())
      .child(this.modeButton("bp-pick", "crosshair", "Pick an element: click copies its HTML, C copies, S screenshots", "pick", t))
      .child(this.modeButton("bp-annotate", "comment-plus", "Annotate: click elements, write notes, send them to an agent", "annotate", t, this.notes.length))
      .child(h_flex().id("bp-debug").h(26).w(26).flex_none().items_center().justify_center().rounded(7)
        .bg(this.dbg.open ? t.selected : t.background).text_color(this.dbg.open ? t.foreground : t.muted)
        .when(on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.toggleDebug(cx)))
        .when(!on, (el) => el.opacity(0.4))
        .tooltip("Debug: console, network, HTML").child(svg(I("code")).size(15)))
      .when(this.rootW >= 420, (el) => el.child(this.iconButton("bp-open", "external-link", "Open in your browser", on && isWeb(st?.url), (_e, cx) => this.openOutside(cx), t)))
      .child(this.iconButton("bp-more", "more", "More", true, (_e, cx) => { this.menu = !this.menu; cx.notify(); }, t))
      .when(Boolean(st?.loading) && on, (el) => el.child(div().absolute().bottom(0).left(0).w_full().h(2).bg(t.accent)
        .loop("opacity", { from: 0.25, to: 1, period: 900 })));
  }

  // The tab strip: every page in this browser (agents' too), newest last; + opens a new one.
  tabStrip(t) {
    const st = this.st, tabs = st?.targets ?? [];
    const tab = (p) => {
      const cur = p.id === st.targetId;
      return h_flex().id(`bp-tab-${p.id}`).h(TABS_H - 7).flex_1().min_w(60).max_w(210).pl(9).pr(4).gap(6).items_center().rounded(7)
        .bg(cur ? t.background : t.surface).text_color(cur ? t.foreground : t.muted).text_size(12)
        .when(cur, (el) => el.border_1().border_color(t.border))
        .when(!cur, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.call("/target", { id: p.id }, cx)))
        .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); this.call("/close-target", { id: p.id }, cx); })
        .tooltip(p.title ? `${p.title}\n${p.url}` : p.url)
        .child(cur && st.loading ? svg(I("spinner")).size(12).flex_none().text_color(t.working).spin(900) : svg(I("globe")).size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().child(p.title || hostOf(p.url) || "New tab"))
        .child(div().id(`bp-tab-x-${p.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
          .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Close tab")
          .on_click((_e, cx) => { cx.stop_propagation(); this.call("/close-target", { id: p.id }, cx); })
          .child(svg(I("x")).size(11)));
    };
    return h_flex().id("bp-tabs").h(TABS_H).flex_none().px(5).gap(3).items_center().bg(t.surface).border_b(1).border_color(t.border).overflow_hidden()
      .children(tabs.map(tab))
      .child(div().id("bp-tab-new").size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
        .when(this.connected, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.call("/new", {}, cx)))
        .tooltip("New tab").child(svg(I("plus")).size(14)))
      .child(div().flex_1());
  }

  center(t, children) {
    return v_flex().absolute().inset_0().items_center().justify_center().gap(10).p(24).text_size(12.5).text_color(t.muted).children(children);
  }

  viewport(t) {
    const fit = this.fit();
    let view = div().id("bp-view").relative().flex_1().min_h(0).w_full().overflow_hidden().bg(t.background)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => {
        const old = this.area;
        this.area = size;
        if (!old || Math.abs(old.width - size.width) >= 0.5 || Math.abs(old.height - size.height) >= 0.5) {
          this.resize(cx);
          this.wake(cx);
          cx.notify();
        }
      })
      .on_mouse_down("left", (e, cx) => this.press(e, "left", cx))
      .on_mouse_down("right", (e, cx) => this.press(e, "right", cx))
      .on_mouse_down("middle", (e, cx) => this.press(e, "middle", cx))
      .on_mouse_up("left", (e, cx) => this.release(e, "left", cx))
      .on_mouse_up("right", (e, cx) => this.release(e, "right", cx))
      .on_mouse_up("middle", (e, cx) => this.release(e, "middle", cx))
      .on_mouse_move((e, cx) => this.move(e, cx))
      .on_scroll_wheel((e, cx) => this.wheel(e, cx));
    if (this.connected && fit && this.frames.length) {
      // Oldest first, newest on top, each at its own size (a frame from before a resize isn't
      // stretched). The older ones only fill in while the newest loads: they are clipped to the
      // newest frame's box, so a bigger frame from before a resize never shows beside it.
      const top = this.frames[this.frames.length - 1];
      const tw = (top.w || this.st.frameW) * fit.s, th = (top.h || this.st.frameH) * fit.s;
      const layer = (f) => image(f.path).id(`bp-frame-${f.path}`).absolute().top(0).left(0).w((f.w || this.st.frameW) * fit.s).h((f.h || this.st.frameH) * fit.s);
      view = view.child(div().absolute().top(0).left(0).w(tw).h(th).overflow_hidden()
        .children(this.frames.slice(0, -1).map(layer)).child(layer(top)));
    }
    if (this.stopped) {
      view = view.child(this.center(t, [
        svg(I("globe")).size(26).text_color(t.dim),
        div().text_color(t.foreground).font_semibold().child("Browser stopped"),
        div().text_size(11.5).text_color(t.dim).child(`Chrome is closed; agents can't reach ${CDP.slice(7)} until it starts.`),
        h_flex().id("bp-start").h(30).px(14).items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground)
          .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.startBrowser(cx)).child("Start browser"),
      ]));
    } else if (!this.connected || !this.frames.length) {
      view = view.child(this.center(t, [
        svg(I("spinner")).size(18).text_color(t.working).spin(900),
        div().child(this.status || (this.connected ? "Loading…" : "Starting the browser…")),
      ]));
    }
    const error = this.flash || this.st?.error;
    if (error && !this.stopped) {
      view = view.child(h_flex().id("bp-error").absolute().top(8).left(8).right(8).px(10).py(7).gap(8).items_center()
        .rounded(8).border_1().border_color(t.border).bg(t.popover).text_size(12).text_color(t.blocked)
        .child(div().flex_1().min_w(0).child(error))
        .child(div().id("bp-error-x").size(18).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.flash = null; if (this.st) this.st.error = null; cx.notify(); })
          .child(svg(I("x")).size(11))));
    }
    if (this.connected && !this.stopped && fit && this.inspectMode() !== "off") {
      const sel = this.draft?.picked?.rect && !this.draft.editing ? this.draft.picked : null;
      const hov = this.st.hover && (!sel || this.st.hover.nodeId !== sel.nodeId) ? this.st.hover : null;
      if (hov) view = view.child(this.outline(t, fit, hov.rect, `${hov.tag}${hov.text ? ` "${hov.text}"` : ""}`, false));
      if (sel) view = view.child(this.outline(t, fit, sel.rect, null, true));
    }
    if (this.connected && !this.stopped) {
      if (this.draft) view = view.child(this.notePopover(t, fit));
      else if (this.notes.length && (this.showNotes || this.inspectMode() === "annotate") && !this.sendMenu) view = view.child(this.notesCard(t));
      if (this.sendMenu) view = view.child(this.sendMenuView(t));
    }
    if (this.toastMsg) view = view.child(this.toastView(t));
    return view;
  }

  footer(t) {
    const st = this.st;
    const link = (id, icon, label, tip, action) => h_flex().id(id).h(20).px(5).gap(5).items_center().rounded(5).flex_none()
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action).tooltip(tip)
      .child(svg(I(icon)).size(11)).child(label);
    return h_flex().h(26).flex_none().px(5).gap(4).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .child(link("bp-cdp", "plug", this.copied ? "Copied" : `CDP ${CDP.slice(7)}`,
        `Agents drive this browser over the DevTools Protocol at ${CDP}. Playwright: chromium.connectOverCDP("${CDP}"). Playwright MCP: --cdp-endpoint ${CDP}. Click to copy.`,
        (_e, cx) => this.copyEndpoint(cx)))
      .child(div().flex_1().min_w(0).truncate().text_right().child(this.connected ? (st?.browser ?? "").replace("/", " ").replace(/\.\d+\.\d+\.\d+$/, "") : ""))
      .child(this.stopped
        ? link("bp-power", "power", "Start", "Start the browser", (_e, cx) => this.startBrowser(cx))
        : link("bp-power", "power", "Stop", "Close this browser (agents using it lose it too)", (_e, cx) => this.stopBrowser(cx)));
  }

  // Perf: script time per render, and the wait from a new frame's state to the render showing it
  // (browser-panel.perf posts them to the helper log, then starts over).
  render(cx) {
    const t0 = Date.now();
    const el = this.renderPanel(cx);
    const p = this.perf ?? (this.perf = { renders: 0, ms: [], wait: [], since: t0 });
    p.renders++;
    p.ms.push(Date.now() - t0);
    const top = this.st?.frameSeq;
    if (top && top !== p.lastSeq) { p.lastSeq = top; (p.frames ??= []).push({ seq: top, at: t0 }); if (p.frames.length > 600) p.frames.shift(); }
    if (this.stateAt) { p.wait.push(t0 - this.stateAt); this.stateAt = 0; }
    if (p.ms.length > 2000) p.ms.shift();
    if (p.wait.length > 2000) p.wait.shift();
    return el;
  }

  perfReport(cx) {
    const p = this.perf ?? { renders: 0, ms: [], wait: [], since: Date.now() };
    const stat = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? { n: b.length, avg: +(b.reduce((x, y) => x + y, 0) / b.length).toFixed(1), p95: b[Math.floor(b.length * 0.95)], max: b[b.length - 1] } : null; };
    const mod = { seconds: Math.round((Date.now() - p.since) / 1000), renders: p.renders, renderMs: stat(p.ms), stateToRenderMs: stat(p.wait), frameWaitMs: stat(p.watchWait ?? []), watcherTimeouts: p.timeouts ?? 0, frames: p.frames ?? [] };
    this.perf = null;
    this.call("/perf", { mod }, cx);
  }

  renderPanel(cx) {
    const shown = this.isShown();
    if (shown !== this.visible) {
      this.visible = shown;
      cx.spawn(async () => this.fitPanel()); // run() is ignored during render
    }
    if (this.visible && this.area && this.os && !this.looping && !this.stopped && !this.importing) this.loop(cx);
    const t = theme();
    return v_flex().id("browser-panel").relative().size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.rootW) >= 1 || Math.abs(size.height - this.rootH) >= 1) { this.rootW = size.width; this.rootH = size.height; cx.notify(); }
      })
      .when(this.connected && (this.st?.targets?.length ?? 0) > 0, (el) => el.child(this.tabStrip(t)))
      .child(this.header(t))
      .when(this.connected && this.inspectMode() !== "off", (el) => el.child(this.hintBar(t)))
      .child(this.viewport(t))
      .when(this.connected && this.dbg.open, (el) => el.child(this.drawer(t)))
      .child(this.footer(t))
      .when(this.menu, (el) => el.child(this.moreMenu(t)))
      .when(Boolean(this.imp), (el) => el.child(this.importCard(t)));
  }

  moreMenu(t) {
    const item = (id, icon, label, action) => h_flex().id(id).h(30).px(9).gap(9).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(action)
      .child(svg(I(icon)).size(14).flex_none().text_color(t.muted)).child(div().flex_1().child(label));
    return v_flex().id("bp-menu").absolute().top((this.connected ? TABS_H : 0) + BAR_H + 2).right(8).w(230).p(4).rounded(9).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().text_size(12.5)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(item("bp-menu-open", "external-link", "Open in your browser", (_e, cx) => { this.menu = false; this.openOutside(cx); cx.notify(); }))
      .child(item("bp-menu-import", "import", "Import from Chrome…", (_e, cx) => { this.menu = false; this.imp = { phase: "confirm" }; cx.notify(); }))
      .child(this.stopped
        ? item("bp-menu-start", "power", "Start browser", (_e, cx) => { this.menu = false; this.startBrowser(cx); })
        : item("bp-menu-stop", "power", "Stop browser", (_e, cx) => { this.menu = false; this.stopBrowser(cx); }));
  }

  importCard(t) {
    const imp = this.imp;
    const button = (id, label, primary, action) => h_flex().id(id).h(30).px(13).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
    const close = (_e, cx) => { this.imp = null; cx.notify(); };
    let body;
    if (imp.phase === "confirm") {
      body = v_flex().gap(10)
        .child(div().text_color(t.muted).line_height("19px").child("Copies your bookmarks, history, saved passwords, autofill, settings and site icons from your Chrome profile into this browser. Your own Chrome isn't changed. This browser closes for the copy and opens again."))
        .child(div().text_color(t.dim).text_size(12).line_height("18px").child("Site logins (cookies) can only be copied while Chrome is closed, and recent Chrome seals most of them to its own profile, so you may still need to sign in once here. This browser remembers it."))
        .child(h_flex().pt(6).gap(8).justify_end()
          .child(button("bp-imp-cancel", "Cancel", false, close))
          .child(button("bp-imp-go", "Import", true, (_e, cx) => this.startImport(cx))));
    } else if (imp.phase === "running") {
      body = h_flex().gap(9).items_center().text_color(t.muted)
        .child(svg(I("spinner")).size(15).flex_none().text_color(t.working).spin(900))
        .child(div().flex_1().child(imp.step));
    } else if (imp.phase === "error") {
      body = v_flex().gap(10)
        .child(div().text_color(t.blocked).line_height("19px").child(imp.message))
        .child(h_flex().gap(8).justify_end().child(button("bp-imp-done", "Close", true, close)));
    } else {
      const items = imp.report?.items ?? [];
      const fmt = (n) => Number(n ?? 0).toLocaleString("en-US");
      const sealed = (i) => (i.appBound ? `, ${fmt(i.appBound)} sealed to Chrome` : "");
      const detail = (i) => {
        if (i.status !== "imported") return i.reason ?? "skipped";
        if (i.note) return i.note;
        if (i.bookmarks !== undefined) return `${fmt(i.bookmarks)} bookmarks`;
        if (i.pages !== undefined) return `${fmt(i.pages)} pages, ${fmt(i.visits)} visits`;
        if (i.logins !== undefined) return i.logins ? `${fmt(i.readable)} usable here${sealed(i)}` : "none saved";
        if (i.cookies !== undefined) return `${fmt(i.readable)} usable here${sealed(i)}`;
        if (i.autofill !== undefined) return `${fmt(i.autofill)} entries`;
        return "copied";
      };
      const locked = items.some((i) => i.locked);
      const b = imp.before, a = imp.after;
      body = v_flex().gap(8)
        .child(div().text_color(t.muted).child(`From your Chrome profile "${imp.report?.profile?.name ?? "Default"}"`))
        .child(v_flex().gap(5).children(items.map((i, k) => h_flex().id(`bp-imp-${k}`).gap(8).items_start()
          .child(div().w(14).flex_none().text_color(i.status === "imported" ? t.ansi2 : t.dim).child(i.status === "imported" ? "✓" : "–"))
          .child(v_flex().flex_1().min_w(0)
            .child(div().text_color(i.status === "imported" ? t.foreground : t.muted).child(i.name))
            .child(div().text_size(11.5).text_color(t.dim).child(detail(i)))))))
        .when(Boolean(a), (el) => el.child(div().pt(4).text_size(12).text_color(t.muted)
          .child(`This browser now reads ${fmt(a.readable)} cookies on ${fmt(a.sites)} sites${b ? ` (before: ${fmt(b.readable)} on ${fmt(b.sites)})` : ""}.`)))
        .when(locked, (el) => el.child(div().text_size(12).text_color(t.blocked).child("Close Chrome and import again to bring your logins.")))
        .child(h_flex().pt(6).gap(8).justify_end()
          .when(locked, (el) => el.child(button("bp-imp-again", "Import again", false, (_e, cx) => this.startImport(cx))))
          .child(button("bp-imp-done", "Done", true, close)));
    }
    // Absolute box outside, scroll area inside (see pagesList).
    const room = Math.max(160, Math.min(600, (this.area?.height ?? 500) - 20));
    return div().id("bp-import-box").absolute().top((this.connected ? TABS_H : 0) + BAR_H + 10).left(10).right(10).rounded(10).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_scroll_wheel((_e, cx) => cx.stop_propagation())
      .child(v_flex().id("bp-import").max_h(room).overflow_y_scrollbar().p(16).gap(12).text_size(12.5)
        .child(h_flex().items_center().gap(8)
          .child(svg(I("import")).size(16).text_color(t.muted))
          .child(div().flex_1().font_semibold().text_size(14).child("Import from Chrome"))
          .when(imp.phase !== "running", (el) => el.child(div().id("bp-imp-x").size(22).flex().items_center().justify_center().rounded(6)
            .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(close).child(svg(I("x")).size(12)))))
        .child(body));
  }
}

Object.assign(Browser.prototype, Notes, Debug);
