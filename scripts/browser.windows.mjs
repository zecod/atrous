// Real Windows browser regression check. Run after scripts/build.ps1 -DebugBuild:
// node scripts/browser.windows.mjs [path/to/atrous.exe] [path/to/atrous-core.exe]
// Own home, core session, profile and ports; never raises a window or touches existing tabs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";

if (process.platform !== "win32") throw new Error("This check exercises the Windows native browser");
const app = path.resolve(process.argv[2] || "target/debug/atrous.exe");
const core = path.resolve(process.argv[3] || "target/debug/atrous-core.exe");
await fs.access(app); await fs.access(core);
const home = await fs.mkdtemp(path.join(os.tmpdir(), "atrous-browser-test-"));
const session = `test-browser-${process.pid}-${Date.now()}`;
const env = { ...process.env, ATROUS_HOME: home, ATC_SESSION: session,
  ATROUS_BACKGROUND: "1", ATROUS_MIGRATE_FROM: path.join(home, "empty-migration") };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const apiPort = await freePort(), cdpPort = await freePort(), hostPort = await freePort();
const pages = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<title>${req.url}</title><p>${req.url}</p>`); });
await new Promise(resolve => pages.listen(0, "127.0.0.1", resolve));
const pageBase = `http://127.0.0.1:${pages.address().port}`;
function cli(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", error = "";
    child.stdout.on("data", b => out += b); child.stderr.on("data", b => error += b);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(error || out || `exit ${code}`)));
  });
}
async function api(port, url, body) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { signal: AbortSignal.timeout(5000),
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function until(f, ms = 15000) {
  const deadline = Date.now() + ms;
  let error;
  while (Date.now() < deadline) {
    try { const result = await f(); if (result) return result; } catch (e) { error = e; }
    await sleep(15);
  }
  throw new Error(`Timed out${error ? `: ${error.message}` : ""}`);
}
const command = (...args) => cli(app, ["do", ...args]);
const state = () => api(hostPort, "/state");
let child;
try {
  await fs.mkdir(path.join(home, "layouts"), { recursive: true });
  await fs.mkdir(path.join(home, "mods/fixture"), { recursive: true });
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ core, zoom: 1 }));
  await fs.writeFile(path.join(home, "shared.json"), JSON.stringify({ layout: "browser-test", "atrous.onboarded": true }));
  await fs.writeFile(path.join(home, "mods/fixture/main.js"), `import {View,div} from 'gpui-kit'; export default class extends View {render(){return div().size_full().child('Isolated browser test');}}`);
  await fs.writeFile(path.join(home, "layouts/browser-test.json"), JSON.stringify({ id: "root", type: "row", titlebar: "none", children: [
    { id: "filler", type: "block", content: { mod: "fixture" } },
    { id: "side", type: "column", size: { px: 800 }, children: [{ id: "browser", type: "block", content: {
      mod: "browser-panel", props: { apiPort, cdpPort, hostPort, url: "about:blank" } } }] },
  ] }));
  const started = performance.now();
  child = spawn(app, [], { env, windowsHide: true, stdio: "ignore" });
  child.on("error", error => console.error(error));
  await until(() => cli(app, ["status"]), 20000);
  const first = await until(async () => { const s = await state(); return s.shown && s.rect?.w > 100 ? s : null; }, 120000);
  const firstShownMs = Math.round(performance.now() - started);
  const right = first.rect.x + first.rect.w;
  const width = px => Math.round(first.rect.w + (px - 800) * first.scale);
  const verify = (s, px) => {
    assert.equal(s.shown, true);
    assert(Math.abs(s.rect.w - width(px)) <= 2, `width ${s.rect.w}, expected ${width(px)}`);
    assert(Math.abs(s.rect.x + s.rect.w - right) <= 2, `page overflowed the panel: ${JSON.stringify(s.rect)}`);
  };
  for (const px of [900, 740, 850, 780, 920, 800]) {
    await command("layout.resize", "--id", "side", "--px", String(px));
    await until(async () => {
      const s = await state();
      if (s.shown) assert(Math.abs(s.rect.x + s.rect.w - right) <= 2, "transient overflow while resizing");
      if (Math.abs((s.rect?.w ?? 0) - width(px)) > 2) return null;
      verify(s, px); return s;
    });
  }
  for (const px of [740, 900, 800]) {
    await command("layout.hide", "--id", "side");
    await until(async () => !(await state()).shown);
    await command("layout.resize", "--id", "side", "--px", String(px));
    await command("layout.show", "--id", "side");
    const reopened = await until(async () => { const s = await state(); return s.shown ? s : null; });
    verify(reopened, px); // the very first shown state must already have the new bounds
  }
  await command("browser-panel.debug:elements");
  await until(async () => { const s = await state(); return s.shown && s.rect.h < first.rect.h - 50; });
  const urls = ["First", "Second", "Third"].map(title => `${pageBase}/${title}`);
  await api(apiPort, "/navigate", { url: urls[0] });
  for (const url of urls.slice(1)) await api(apiPort, "/new", { url });
  const beforeRestart = await until(async () => { const s = await state(); return s.tabs.length === 3 ? s : null; });
  await api(apiPort, "/target", { id: beforeRestart.tabs[1].id });
  await until(async () => {
    const saved = JSON.parse(await fs.readFile(path.join(process.env.LOCALAPPDATA, "atrous-browser", `host-tabs-${hostPort}.json`), "utf8"));
    return saved.active === 1 && JSON.stringify(saved.tabs) === JSON.stringify(urls);
  }); // navigation and persistence finish after the new-controller response
  await command("browser-panel.stop");
  await sleep(4300); // Stop's cleanup has a four-second grace period
  const native = path.join(home, "mods/browser-panel/native/Host.cs");
  await fs.utimes(native, new Date(), new Date(Date.now() + 60000));
  const restart = performance.now();
  await command("browser-panel.start");
  await until(async () => (await state()).shown, 30000);
  const cachedStartMs = Math.round(performance.now() - restart);
  await until(async () => {
    const s = await state();
    if (s.tabs.length !== 3) return false;
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const restored = s.tabs.map(t => targets.find(target => target.id === t.id)?.url);
    if (restored.some(url => !url || url === "about:blank")) return false;
    assert.deepEqual(restored, urls, "restoring the active tab first changed tab order");
    assert.equal(s.active, s.tabs[1].id, "the previously active tab must remain selected");
    return true;
  });
  const log = await fs.readFile(path.join(process.env.LOCALAPPDATA, "atrous-browser", `helper-${apiPort}.log`), "utf8");
  assert(!log.includes("building the native host"), "unchanged sources with new timestamps rebuilt the native host");
  await command("browser-panel.debug:elements");
  await until(async () => { const s = await state(); return s.shown && s.rect.h < first.rect.h - 50; });
  await until(() => api(apiPort, "/ui-eval", { expr: `document.body.innerHTML = '<div id="large">' + '<p>Inspectable content</p>'.repeat(1000) + '</div>'; null` }));
  const selected = (await api(apiPort, "/dom/query", { selector: "#large" })).matches[0];
  await api(apiPort, "/dom/select", { id: selected.nodeId });
  await sleep(500);
  const status = JSON.parse(await cli(app, ["status"]));
  assert.deepEqual(status.errors ?? [], []);
  await cli(app, ["check", path.join(home, "mods/browser-panel")]);
  const shot = path.join(home, "browser-test.png");
  await cli(app, ["shot", shot]);
  console.log(JSON.stringify({ firstShownMs, cachedStartMs, resizes: 6, reopens: 3, inspector: true, home, shot, apiPort, hostPort }));
} finally {
  await api(apiPort, "/shutdown", {}).catch(() => {});
  if (child && child.exitCode === null) {
    await command("window.close").catch(() => {});
    await until(() => child.exitCode !== null, 5000).catch(() => { child.kill(); });
  }
  await cli(core, ["server", "stop"]).catch(() => {});
  pages.closeAllConnections(); pages.close();
  // Retain the screenshot and scratch home for inspection; its name is printed above.
}
