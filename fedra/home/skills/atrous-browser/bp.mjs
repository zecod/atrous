#!/usr/bin/env node
// bp: the Atrous Browser panel, for agents. See SKILL.md next to this file.
//
//   node bp.mjs <command> [args]          (JSON on stdout; errors on stderr, exit 1)
//
// Talks to the panel's helper (127.0.0.1:9734, or ATROUS_BROWSER_API=<port>), the same browser the
// person sees in Atrous, and for eval/shot to that browser's DevTools endpoint directly.
// Command groups live in modules next to this file: net.mjs (traffic, intercept, replay) and
// dom.mjs (live HTML, cookies, local/session storage, IndexedDB). Each exports run(argv, api);
// argv starts with the group word ("net", or "dom" | "cookies" | "local" | "session" | "idb").

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ATROUS_BROWSER_API) || 9734;
const BASE = `http://127.0.0.1:${PORT}`;

class NotRunning extends Error {}

/** Calls the helper: GET without a body, POST JSON with one. Returns parsed JSON; throws on errors. */
export async function api(p, body) {
  let res;
  try {
    res = await fetch(BASE + p, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new NotRunning(`The Browser panel isn't running (nothing on ${BASE}). Run: bp start`);
  }
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { ok: res.ok, text }; }
  if (!res.ok || j?.ok === false) throw new Error(j?.error || `${p}: HTTP ${res.status}`);
  return j;
}

const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const flag = (argv, name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (argv, name, def = null) => { const i = argv.indexOf(name); if (i < 0 || i + 1 >= argv.length) return def; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const textArg = (v) => (typeof v === "string" && v.startsWith("@") ? fs.readFileSync(v.slice(1), "utf8") : v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function state() {
  const s = await api("/state?peek=1");
  return {
    url: s.url, title: s.title, loading: s.loading, canGoBack: s.canGoBack, canGoForward: s.canGoForward,
    tab: s.targetId, tabs: (s.targets ?? []).map((t) => ({ id: t.id, url: t.url, title: t.title, current: t.current })),
    inspect: s.inspect, picked: s.picked ?? null, cdp: s.cdp, native: Boolean(s.native), error: s.error ?? null,
  };
}

async function waitLoaded(before, timeoutMs) {
  const end = Date.now() + timeoutMs;
  await sleep(250);
  for (;;) {
    const s = await state();
    if (!s.loading && (before == null || s.url !== before || Date.now() > end - timeoutMs + 1500)) return s;
    if (Date.now() > end) return { ...s, timedOut: true };
    await sleep(300);
  }
}

// ---- DevTools (CDP) for eval and screenshots ------------------------------------------------

async function withPage(fn) {
  const s = await state();
  const list = await (await fetch(`${s.cdp}/json/list`)).json();
  const page = list.find((t) => t.id === s.tab) ?? list.find((t) => t.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("No page to talk to");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error("DevTools connection failed")); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
    const w = d.id && waiting.get(d.id);
    if (!w) return;
    waiting.delete(d.id);
    d.error ? w.bad(new Error(d.error.message)) : w.ok(d.result);
  };
  const send = (method, params = {}) => new Promise((ok, bad) => { const n = ++id; waiting.set(n, { ok, bad }); ws.send(JSON.stringify({ id: n, method, params })); });
  try { return await fn(send); } finally { ws.close(); }
}

async function evaluate(expression) {
  return withPage(async (send) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: 20000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "exception");
    return r.result?.value ?? (r.result?.type === "undefined" ? null : r.result?.description ?? null);
  });
}

async function screenshot({ selector, full, file }) {
  return withPage(async (send) => {
    let clip;
    if (selector) {
      const r = await send("Runtime.evaluate", { returnByValue: true, expression:
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block: "center"});
          const b = e.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height }; })()` });
      clip = r.result?.value;
      if (!clip) throw new Error(`Nothing matches ${selector}`);
      clip = { ...clip, scale: 1 };
    }
    const r = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip, captureBeyondViewport: true } : {}), ...(full ? { captureBeyondViewport: true } : {}) });
    const dir = path.join(os.tmpdir(), "atrous-browser-shots");
    fs.mkdirSync(dir, { recursive: true });
    const p = file ? path.resolve(file) : path.join(dir, `shot-${Date.now()}.png`);
    fs.writeFileSync(p, Buffer.from(r.data, "base64"));
    return p;
  });
}

// ---- commands ------------------------------------------------------------------------------

const HELP = `bp: the Atrous Browser panel (shared with the person). JSON out.
  status                         url, title, tabs, what the person picked
  start                          open the Browser panel in Atrous if it isn't running
  open <url> [--new] [--no-wait] go there (in a new tab with --new) and wait for the load
  back | forward | reload [--hard]
  tabs | tab <id> | close [<id>]
  console [--errors] [--grep re] [--limit n]
  html [page|picked]             the page's HTML (without Atrous's own marks)
  eval <js|@file>                run JS in the page, print the result (awaits promises)
  shot [--selector css] [--full] [--out file.png]   screenshot, prints its path
  cdp                            the DevTools endpoint (Playwright connectOverCDP)
  net ...                        traffic, intercept rules, replay: see net.md
  dom ... | cookies ... | local ... | session ... | idb ...   live HTML and storage: see dom.md`;

async function main(argv) {
  const cmd = argv.shift();
  switch (cmd) {
    case undefined: case "help": case "-h": case "--help": return void process.stdout.write(`${HELP}\n`);
    case "status": return out(await state());
    case "start": {
      try { return out({ started: false, ...(await state()) }); } catch (e) { if (!(e instanceof NotRunning)) throw e; }
      const run = (c, a) => spawnSync("atrous", ["do", c, JSON.stringify(a)], { encoding: "utf8", shell: process.platform === "win32" });
      run("layout.select", { stack: "panel-body", child: "browser" });
      run("layout.show", { id: "panel" });
      for (let i = 0; i < 60; i++) {
        await sleep(500);
        try { const s = await state(); if (s.url) return out({ started: true, ...s }); } catch {}
      }
      throw new Error("The Browser panel didn't start in 30 s (is the Fedra layout shown in Atrous?)");
    }
    case "open": {
      const newTab = flag(argv, "--new"), noWait = flag(argv, "--no-wait");
      const timeout = Number(opt(argv, "--timeout", 20)) * 1000;
      let url = argv[0];
      if (!url) throw new Error("usage: bp open <url>");
      if (!/^[a-z][\w+.-]*:/i.test(url)) url = `https://${url}`;
      const before = (await state()).url;
      await api(newTab ? "/new" : "/navigate", { url });
      return out(noWait ? { ok: true } : await waitLoaded(newTab ? null : before, timeout));
    }
    case "back": case "forward": await api(`/${cmd}`, {}); return out(await waitLoaded(null, 10000));
    case "reload": await api("/reload", { hard: flag(argv, "--hard") }); return out(await waitLoaded(null, 20000));
    case "tabs": return out((await state()).tabs);
    case "tab": await api("/target", { id: argv[0] }); return out(await state());
    case "close": await api("/close-target", argv[0] ? { id: argv[0] } : {}); return out((await state()).tabs);
    case "console": {
      const errors = flag(argv, "--errors"), grep = opt(argv, "--grep"), limit = Number(opt(argv, "--limit", 50));
      let e = (await api("/debug?kind=console")).entries ?? [];
      if (errors) e = e.filter((x) => x.level === "error");
      if (grep) { const re = new RegExp(grep, "i"); e = e.filter((x) => re.test(x.text ?? "")); }
      return out(e.slice(-limit));
    }
    case "html": return void process.stdout.write(`${(await api(`/html?what=${argv[0] === "picked" ? "picked" : "page"}`)).html ?? ""}\n`);
    case "eval": {
      const src = textArg(argv.join(" "));
      if (!src) throw new Error("usage: bp eval <js|@file>");
      return out(await evaluate(src));
    }
    case "shot": return out({ path: await screenshot({ selector: opt(argv, "--selector"), full: flag(argv, "--full"), file: opt(argv, "--out") }) });
    case "cdp": return out({ cdp: (await state()).cdp, note: "Playwright: chromium.connectOverCDP(cdp). This is the person's browser: don't close it." });
    case "net": return group("net.mjs", [cmd, ...argv]);
    case "dom": case "cookies": case "local": case "session": case "idb": return group("dom.mjs", [cmd, ...argv]);
    default: throw new Error(`Unknown command: ${cmd}\n${HELP}`);
  }
}

async function group(file, argv) {
  const p = path.join(HERE, file);
  if (!fs.existsSync(p)) throw new Error(`${file} isn't installed yet (the Browser panel's devtools are still being built)`);
  const m = await import(pathToFileURL(p).href);
  return m.run(argv, api);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
