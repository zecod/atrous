import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeBuildInputs } from "../fedra/home/mods/browser-panel/native-build.mjs";
import { registerDevtools } from "../fedra/home/mods/browser-panel/devtools-dom.mjs";

test("native host cache survives timestamp changes but invalidates changed and removed sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atrous-browser-build-"));
  try {
    const file = join(dir, "Host.cs");
    await writeFile(file, "source");
    await writeFile(join(dir, "global.json"), "{}");
    const initial = nativeBuildInputs(dir).key;
    await utimes(file, new Date(), new Date(Date.now() + 60_000));
    expect(nativeBuildInputs(dir).key).toBe(initial);
    await writeFile(file, "changed");
    const changed = nativeBuildInputs(dir).key;
    expect(changed).not.toBe(initial);
    await rm(join(dir, "global.json"));
    expect(nativeBuildInputs(dir).key).not.toBe(changed);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function domFixture(html: string, fail = false) {
  const calls: { method: string; params: any }[] = [];
  const node = (id: number, name: string, children?: any[]) => ({ nodeId: id, backendNodeId: id, nodeType: 1,
    nodeName: name.toUpperCase(), localName: name, childNodeCount: children?.length ?? 0, children });
  const cdp = {
    listeners: [] as Function[], closed: false,
    async send(method: string, params: any) {
      calls.push({ method, params });
      if (method === "Target.attachToTarget") return { sessionId: "test" };
      if (method === "DOM.getDocument") return { root: { ...node(1, "#document", [node(2, "html", [node(3, "body", [])])]), nodeType: 9 } };
      if (method === "DOM.resolveNode") return { object: { objectId: "body" } };
      if (method === "Runtime.callFunctionOn") {
        if (fail) return { exceptionDetails: {} };
        const f = new Function(`return (${params.functionDeclaration})`)();
        return { result: { value: f.call({ outerHTML: html }, ...params.arguments.map((a: any) => a.value)) } };
      }
      return {};
    },
  };
  const tools = registerDevtools({ S: { targetId: "page", url: "http://localhost", inspect: "off" }, cdp: () => cdp, log() {} });
  return { calls, get: (path: string, query = "") => tools.route("GET", path, new URLSearchParams(query), {}) };
}

test("Elements previews slice multi-megabyte HTML in Chromium and release the remote object", async () => {
  const html = `<body>${"<p>content</p>".repeat(300_000)}<div data-atrous="notes"></div></body>`;
  const fixture = domFixture(html);
  const preview = await fixture.get("/dom/html", "id=3&max=12000");
  expect(preview.ok).toBe(true);
  expect(preview.html.length).toBe(12_000);
  expect(preview.total).toBe(html.replace('<div data-atrous="notes"></div>', "").length);
  expect(preview.truncated).toBe(true);
  expect(fixture.calls.some(c => c.method === "DOM.getOuterHTML")).toBe(false);
  expect(fixture.calls.at(-1)?.method).toBe("Runtime.releaseObject");
});

test("Elements returns complete small selections for editing and releases failed previews", async () => {
  const html = '<body><p class="example">Hello &amp; world</p></body>';
  const fixture = domFixture(html);
  expect(await fixture.get("/dom/html", "id=3&max=12000")).toMatchObject({ html, total: html.length, truncated: false, kind: 1 });
  const failed = domFixture(html, true);
  await expect(failed.get("/dom/html", "id=3")).rejects.toThrow("Couldn't read");
  expect(failed.calls.at(-1)?.method).toBe("Runtime.releaseObject");
});

test("Elements coalesces hover changes, keeps large selections bounded and loads full HTML on demand", async () => {
  const source = (await readFile(new URL("../fedra/home/mods/browser-panel/devtools-elements.js", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "").replaceAll("export const ", "const ");
  const queries: string[] = [], tasks: Promise<void>[] = [], timers: Function[] = [];
  const html = "<div>" + "content".repeat(4000) + "</div>";
  const Elements = new Function("apiGet", `${source}; return Elements;`)(async (query: string) => {
    queries.push(query);
    const max = Number(new URL(query, "http://localhost").searchParams.get("max"));
    return { ok: true, html: html.slice(0, max), total: html.length, truncated: html.length > max, kind: 1, label: "div" };
  });
  let editor = "", replacements = 0;
  const view = { ...Elements, dte: { focus: 1, inspecting: true, hover: 1, html: {} },
    dteShown: () => true, dteEd: { value: () => editor, set_value: (text: string) => { editor = text; replacements++; } } };
  const cx = { notify() {}, timer: { after: (_ms: number, f: Function) => timers.push(f) },
    spawn: (f: Function) => tasks.push(f(cx)) };
  for (let i = 0; i < 5; i++) view.dteWantHtml(cx);
  expect(timers.length).toBe(1); // DOM mutations with the same focus must not postpone the preview forever
  view.dte.focus = 2; view.dte.hover = 2;
  view.dteWantHtml(cx);
  for (const f of timers.splice(0)) f(cx);
  await Promise.all(tasks.splice(0));
  expect(queries).toEqual(["/dom/html?id=2&max=12000"]);
  expect(editor.length).toBeLessThan(12_100);
  expect(view.dte.html.truncated).toBe(true);
  view.dte.inspecting = false;
  view.dteLoadHtml(cx, false, true);
  await Promise.all(tasks.splice(0));
  expect(queries.at(-1)).toBe("/dom/html?id=2&max=250000");
  expect(editor).toBe(html);
  expect(view.dte.html.truncated).toBe(false);
  expect(replacements).toBe(2);
  view.dte.html.dirty = true; view.dte.focus = 3;
  view.dteWantHtml(cx);
  expect(timers.length).toBe(0); // pointing elsewhere preserves unsaved HTML
});
