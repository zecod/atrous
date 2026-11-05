// The devtools drawer (</>): Console, Network, Elements and Intercept for the shown tab, mixed into
// the Browser view (main.js). The helper keeps the data per tab from the moment the tab exists
// (devtools-net.mjs: console with stacks, a network log with bodies, Edit and resend, Intercept);
// the drawer polls the shown tab once a second while it is open and on screen, and draws long
// lists with virtual lists, so a busy page costs only the rows on screen. Agents' intercept rules
// (the atrous-browser skill: bp net rule) show in the Intercept tab; while rules or held requests
// are active a red badge shows in the drawer's strip, or in the panel's toolbar when the drawer is
// closed (main.js hook). Files: devtools-ui.js (shared builders), devtools-network.js and
// devtools-intercept.js (tabs), devtools-net.mjs (the helper side, wired into helper.mjs by lines
// marked "devtools-net hook").
//
// ---- Adding a tab (the registry) -----------------------------------------------------------
// The drawer's tabs are plain objects in a list. To add one, or replace one, write it in its own
// file and add one import and one line in the "Registered tabs" block at the bottom of this file:
//
//   import { ApplicationTab } from "./devtools-application.js";
//   registerTab(ApplicationTab);            // a new id is added (at the end, or see before/after)
//   registerTab(MyElementsTab);             // id "elements": replaces today's Elements in place
//
// A tab:
//   {
//     id: "application",                  // unique; `browser-panel.debug:<id>` opens it
//     label: "Application",               // the strip's text
//     before?: "intercept", after?: "x",  // where a new tab goes (default: the end)
//     init?(dt, cx),                      // once, when the panel starts: make InputStates and
//                                         //   EditorStates here (render can't), keep state in dt.state[id]
//     render(t, dt) -> element,           // the body under the strip; t = theme(). Fill it with
//                                         //   v_flex().flex_1().min_h(0)...; nothing may draw outside it
//     toolbar?(t, dt) -> element,         // an optional row under the strip (filters, buttons)
//     onShow?(dt, cx), onHide?(dt, cx),   // shown (drawer opened on it, or picked) / hidden (other tab,
//                                         //   drawer closed, panel unloading)
//     poll?(dt, cx),                      // once a second while shown, on screen and connected
//     clear?(dt, cx), copy?(dt) -> string,  // when given, the strip shows Clear / Copy for this tab
//     command?(dt, arg, cx),              // `browser-panel.debug:<id> <arg>` (key bindings, tests)
//   }
// Never keep a cx: every callback gets its own. Do slow work in cx.spawn(async (cx) => ...).
//
// `dt`, the drawer's context, the same object for every tab:
//   dt.view            the Browser view (dt.view.st: the helper's state: url, targetId, targets...;
//                      dt.view.connected; dt.view.toast(text, null, cx))
//   dt.state           per-tab state: dt.state[tab.id] (made in init)
//   dt.base()          the helper's API, "http://127.0.0.1:<apiPort>" (panel props apiPort, default 9734)
//   dt.get(path), dt.post(path, body)   JSON from the helper (they throw on HTTP errors; .status)
//                      (the helper owns CDP: give a tab new data with routes in devtools-net.mjs, or
//                      a helper module of your own wired like it, and call them with dt.get/post)
//   dt.copy(text, cx)  to the clipboard, with a "Copied" note
//   dt.show(id, cx)    switch the drawer to tab id
//   dt.width(), dt.height()   the drawer's size in px (height: the body under the strip)
//   dt.mono()          the terminal font family, for code and tables
//   dt.legacy          true when the running helper predates /devtools (the drawer offers a restart)
//   dt.code(key, lang, text)   fill a read-only code view (json, html, css, js, text); call it from
//                              a handler or task, never from render
//   dt.codeView(key)   that view's element, for render (null until filled)
//   dt.ui(t)           builders in the drawer's look: chip, icon, button, toggle, segmented, tabs,
//                      empty, section, kv, tag (devtools-ui.js)
// Text the panel injects into pages should end with `//# sourceURL=atrous://<name>` (or run in an
// isolated world named "atrous..."): the Console then tags what it logs "atrous", not the site's.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { settings, theme, props } from "atrous";
import { ui, ICON, stop, wrap, mergeList } from "./devtools-ui.js";
import { NetworkTab } from "./devtools-network.js";
import { InterceptTab, releaseIntercept } from "./devtools-intercept.js";
import { DomElementsTab } from "./devtools-elements.js"; // devtools-dom: the Elements tab (tree, inspect, edit)
import { ApplicationTab } from "./devtools-app.js"; // devtools-dom: the Application tab (cookies, storage, IndexedDB, caches, workers)

const TABS = [];
export function registerTab(...list) {
  for (const tab of list) {
    const i = TABS.findIndex((x) => x.id === tab.id);
    if (i >= 0) { TABS[i] = tab; continue; }
    const at = tab.before ? TABS.findIndex((x) => x.id === tab.before) : tab.after ? TABS.findIndex((x) => x.id === tab.after) + 1 : -1;
    if (at >= 0 && at <= TABS.length && (tab.before || tab.after)) TABS.splice(at, 0, tab);
    else TABS.push(tab);
  }
}
export const devtoolsTabs = () => TABS;

const apiBase = () => `http://127.0.0.1:${Number(props()?.apiPort) || 9734}`;
const CODE_LANG = { json: "json", html: "html", xml: "html", css: "css", javascript: "js", js: "js", text: "txt", txt: "txt" };

// ---- Console ----------------------------------------------------------------------------------

const LEVEL = (t) => ({ error: [t.blocked, "✕"], warn: [t.ansi3, "▲"], nav: [t.dim, "→"], info: [t.ansi4, "i"], debug: [t.dim, "·"], log: [t.muted, "›"] });
const CHAR_W = 6.95; // JetBrains Mono at 11.5 px
const clock = (ms) => { const d = new Date(ms); return isNaN(d) ? "" : `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`; };

function consoleLines(e, cols) {
  if (e._wrap?.cols === cols) return e._wrap.lines;
  const out = wrap(e.text, cols, 300);
  const ownStack = /\n\s+at /.test(e.text); // an Error's text carries its own stack
  const st = ownStack ? [] : e.stack ?? [];
  if (st.length) for (const f of st) out.push(...wrap(`    at ${f.fn || "(anonymous)"} (${f.url || "<anonymous>"}:${f.line}:${f.col})`, cols, 4));
  else if (e.url && !ownStack) out.push(...wrap(`    at ${e.url}${e.line ? `:${e.line}${e.col ? `:${e.col}` : ""}` : ""}`, cols, 4));
  if (e.atrous) out.push("    (from the panel's own code in the page, not the site's)");
  e._wrap = { cols, lines: out };
  return out;
}

function consoleRefilter(s) {
  const f = s.filter.value().trim().toLowerCase();
  s.shown = s.list.filter((e) => {
    if (s.level === "errors" && e.level !== "error") return false;
    if (s.level === "warnings" && e.level !== "warn") return false;
    return !f || e.text.toLowerCase().includes(f) || (e.source ?? "").toLowerCase().includes(f) || (e.url ?? "").toLowerCase().includes(f);
  });
}

function consoleLoad(dt, cx) {
  const s = dt.state.console;
  if (s.busy) return;
  s.busy = true;
  cx.spawn(async (cx) => {
    try {
      if (dt.legacy) {
        const r = await dt.get(`/debug?kind=console&since=${s.lver ?? -1}`);
        if (!r.ok || r.same) return;
        s.lver = r.ver;
        mergeList(s, { reset: true, gen: "legacy", ver: r.ver, entries: (r.entries ?? []).map((e) => ({ ...e, stack: [], url: "" })) });
      } else {
        const r = await dt.get(`/devtools/console?gen=${encodeURIComponent(s.gen)}&since=${s.ver}`);
        dt.sawIntercept(r.icpt);
        if (!r.ok || r.same) return;
        if (r.reset) s.open.clear();
        mergeList(s, r);
      }
      const grew = s.list.length !== s.lastLen;
      s.lastLen = s.list.length;
      consoleRefilter(s);
      // follows the newest message, as DevTools does, unless one is open for reading
      if (grew && !s.open.size && s.shown.length) s.scroll.scroll_to_bottom();
      cx.notify();
    } catch {} finally { s.busy = false; }
  });
}

const ConsoleTab = {
  id: "console",
  label: "Console",
  init(dt) {
    const s = dt.state.console = { list: [], byN: new Map(), gen: "", ver: -1, shown: [], level: "all", open: new Set(), busy: false };
    s.filter = InputState.new({ placeholder: "Filter" });
    s.filter.on("change", (_e, cx) => { consoleRefilter(s); cx.notify(); });
    s.scroll = VirtualListScrollHandle.new();
  },
  onShow: consoleLoad,
  poll: consoleLoad,
  clear(dt, cx) {
    const s = dt.state.console;
    Object.assign(s, { list: [], byN: new Map(), shown: [] });
    s.open.clear();
    dt.post(dt.legacy ? "/debug-clear" : "/devtools/console/clear", { kind: "console" }).catch(() => {});
    cx.notify();
  },
  copy(dt) {
    const s = dt.state.console, open = s.shown.filter((e) => s.open.has(e.n));
    return (open.length ? open : s.shown).map((e) => `[${e.level}] ${e.text}${e.source ? `  (${e.source})` : ""}${(e.stack ?? []).length > 1 && s.open.has(e.n) ? `\n${e.stack.map((f) => `    at ${f.fn || "(anonymous)"} (${f.url}:${f.line}:${f.col})`).join("\n")}` : ""}`).join("\n");
  },
  copyTip: "Copy the open messages (or all shown)",
  toolbar(t, dt) {
    const s = dt.state.console, U = ui(t);
    const level = (id, label, v) => U.chip(`bp-con-${id}`, label, s.level === v, (_e, cx) => { s.level = v; consoleRefilter(s); cx.notify(); });
    return h_flex().h(30).px(8).gap(6).flex_none().items_center().border_b(1).border_color(t.border)
      .child(Input.new(s.filter).w(170).h(24).px(7).rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(11.5))
      .child(level("all", "All", "all")).child(level("err", "Errors", "errors")).child(level("warn", "Warnings", "warnings"))
      .child(div().flex_1())
      .child(div().text_size(10.5).text_color(t.dim).child("Click a message for all of it"));
  },
  render(t, dt) {
    const s = dt.state.console, U = ui(t), rows = s.shown, mono = dt.mono(), L = LEVEL(t);
    if (!rows.length) return U.empty(s.list.length ? "Nothing matches the filter" : "No console messages yet");
    const cols = Math.max(24, Math.floor((dt.width() - 44) / CHAR_W));
    const heights = rows.map((e) => (s.open.has(e.n) ? 24 + consoleLines(e, cols).length * 16 + 6 : 22));
    const row = (e) => {
      const [c, g] = L[e.level] ?? L.log, open = s.open.has(e.n);
      const color = e.level === "nav" ? t.dim : e.level === "error" ? t.blocked : e.level === "warn" ? t.ansi3 : t.foreground;
      const head = h_flex().h(open ? 24 : 22).px(8).gap(7).flex_none().items_center()
        .child(div().w(10).flex_none().text_color(c).child(g))
        .child(open
          ? div().flex_1().min_w(0).truncate().text_color(t.dim).text_size(10.5).child(`${clock(e.t)}${e.kind ? ` · ${e.kind}` : ""}${e.url ? ` · ${e.url}${e.line ? `:${e.line}` : ""}` : ""}`)
          : div().flex_1().min_w(0).truncate().text_color(color).child(e.text.split("\n")[0]))
        .when(Boolean(e.atrous), (el) => el.child(U.tag("atrous")))
        .child(div().max_w(170).flex_none().truncate().text_color(t.dim).child(e.source ?? ""));
      let el = v_flex().border_b(1).border_color(t.border).text_size(11.5).font_family(mono)
        .bg(e.level === "error" ? `${t.blocked}14` : e.level === "warn" ? `${t.ansi3}10` : open ? t.surface : t.background).child(head);
      if (open) {
        const lines = consoleLines(e, cols), textN = wrap(e.text, cols, 300).length;
        el = el.child(v_flex().pl(25).pr(8).pb(6).children(lines.map((l, i) => div().h(16).whitespace_nowrap()
          .text_color(i < textN ? color : t.dim).child(l || " "))));
      }
      return el;
    };
    return v_flex().relative().flex_1().min_h(0)
      .child(v_virtual_list("bp-con-rows", rows.length, heights, (i) => String(rows[i].n), (range) => rows.slice(range.start, range.end).map(row))
        .track_scroll(s.scroll).size_full().on_item_click((key, cx) => { const n = Number(key); if (s.open.has(n)) s.open.delete(n); else s.open.add(n); cx.notify(); }))
      .child(Scrollbar.vertical("bp-con-rows").absolute().inset_0());
  },
  command(dt, arg, cx) {
    const s = dt.state.console, [what, val] = String(arg).split(" ");
    if (what === "open") {
      const e = val === "last" ? s.shown[s.shown.length - 1] : val === "error" ? [...s.shown].reverse().find((x) => x.level === "error") : s.byN.get(Number(val));
      if (e) { s.open.add(e.n); const i = s.shown.indexOf(e); if (i >= 0) s.scroll.scroll_to_item(i, "center"); }
    }
    else if (what === "level") { s.level = val; consoleRefilter(s); }
  },
};

// ---- Elements (the page's HTML, read-only; another agent's Elements tab replaces it) ----------

function htmlLoad(dt, what, cx) {
  const s = dt.state.elements;
  s.what = what;
  s.busy = true;
  cx.spawn(async (cx) => {
    try {
      const r = await dt.get(`/html?what=${what}`);
      const html = r.ok ? r.html : `<!-- ${r.error ?? "no HTML"} -->`;
      dt.code("elements", "html", html);
      s.chars = html.length;
      cx.notify();
    } catch {} finally { s.busy = false; }
  });
}

const ElementsTab = {
  id: "elements",
  label: "Elements",
  init(dt) { dt.state.elements = { what: "page", chars: 0, busy: false }; },
  onShow(dt, cx) { htmlLoad(dt, dt.state.elements.what, cx); },
  copy(dt) { return dt.view.dbgEditors?.[dt.view.dbgEditorFor?.elements]?.value() ?? ""; },
  copyTip: "Copy the HTML",
  toolbar(t, dt) {
    const s = dt.state.elements, U = ui(t);
    return h_flex().h(30).px(8).gap(6).flex_none().items_center().border_b(1).border_color(t.border)
      .child(U.chip("bp-el-page", "Page", s.what === "page", (_e, cx) => htmlLoad(dt, "page", cx)))
      .child(U.chip("bp-el-picked", "Picked element", s.what === "picked", (_e, cx) => htmlLoad(dt, "picked", cx)))
      .child(U.icon("bp-el-reload", "rotate-cw", "Reload the HTML", (_e, cx) => htmlLoad(dt, s.what, cx)));
  },
  render(t, dt) {
    const s = dt.state.elements, view = dt.codeView("elements");
    if (!view) return ui(t).empty("Loading…");
    return v_flex().flex_1().min_h(0).child(view.flex_1().min_h(0))
      .child(div().h(20).px(8).text_size(10.5).text_color(t.dim).child(`${(s.chars ?? 0).toLocaleString("en-US")} characters${s.what === "picked" ? " · the last element you picked or annotated" : ""}`));
  },
};

// ---- Registered tabs: add yours here (one import above, one line below) ----------------------
registerTab(ConsoleTab, NetworkTab, ElementsTab, InterceptTab);
registerTab(DomElementsTab, ApplicationTab); // devtools-dom: replaces Elements, adds Application after it

// ---- the drawer, mixed into the Browser view ------------------------------------------------

export const Debug = {
  initDebug(cx) {
    this.dbg = { open: false, tab: "console", tall: false, icpt: { on: false, n: 0, rules: 0 } };
    this.dbgTicks = 0;
    this.dbgEditors = {}; // EditorStates by `${key}:${language}`
    this.dbgEditorFor = {}; // key -> the one shown
    const view = this;
    const req = async (path, init) => {
      const r = await fetch(`${apiBase()}${path}`, init);
      let j = null;
      try { j = await r.json(); } catch {}
      if (!r.ok) throw Object.assign(new Error(j?.error ?? `HTTP ${r.status}`), { status: r.status });
      return j;
    };
    this.dt = {
      view, state: {}, legacy: undefined,
      base: apiBase,
      get: (path) => req(path),
      post: (path, body) => req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
      copy: (text, cx) => { view.call("/clipboard", { text: String(text ?? "") }, cx); view.toast("Copied", null, cx, 1500); },
      show: (id, cx) => view.dbgTab(id, cx),
      width: () => Math.max(200, (view.rootW || 600) - 2),
      height: () => view.dbgHeight() - 32,
      mono: () => settings()?.font_family || "JetBrains Mono",
      ui,
      code: (key, lang, text) => view.dbgSetCode(key, lang, text),
      codeView: (key) => { const st = view.dbgEditors[view.dbgEditorFor[key]]; return st ? Editor.new(st) : null; },
      sawIntercept: (i) => {
        const c = view.dbg.icpt;
        if (i && (Boolean(i.on) !== c.on || (i.n ?? 0) !== c.n || (i.rules ?? 0) !== c.rules)) view.dbg.icpt = { on: Boolean(i.on), n: i.n ?? 0, rules: i.rules ?? 0 };
      },
    };
    for (const tab of TABS) { try { tab.init?.(this.dt, cx); } catch (e) { console.log(`devtools tab ${tab.id}: ${e?.message ?? e}`); } }
    cx.timer.every(1000, (cx) => this.dbgPoll(cx));
  },

  dbgSetCode(key, lang, text) {
    const L = CODE_LANG[lang] ?? "txt", k = `${key}:${L}`;
    let st = this.dbgEditors[k];
    if (!st) {
      const t = theme();
      st = EditorState.new({ language: L, readonly: true, value: text ?? "", font_family: settings().font_family, font_size: 12, soft_wrap: true,
        syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi1 } });
      this.dbgEditors[k] = st;
    } else st.set_value(text ?? "");
    this.dbgEditorFor[key] = k;
  },

  dbgCurrent() {
    return TABS.find((x) => x.id === this.dbg.tab) ?? TABS[0];
  },

  dbgHeight() {
    const H = this.rootH ?? 600;
    const normal = Math.max(150, Math.min(H * 0.42, H - 200));
    return this.dbg?.tall ? Math.max(normal, Math.min(H * 0.78, H - 150)) : normal;
  },

  toggleDebug(cx) {
    const d = this.dbg;
    d.open = !d.open;
    const tab = this.dbgCurrent();
    if (d.open) { this.dbgHello(cx); tab?.onShow?.(this.dt, cx); }
    else {
      tab?.onHide?.(this.dt, cx);
      // Closing the drawer lets every request Intercept holds go on.
      if (d.icpt.on || this.dt.state.intercept?.on) cx.spawn(async () => { await releaseIntercept(this.dt); });
      d.icpt = { ...d.icpt, on: false }; // agents' rules stay: the toolbar badge shows them
    }
    cx.notify();
  },

  // `debug:<tab>` and `debug:<tab> <arg>` (main.js passes the argument here)
  dbgTab(arg, cx) {
    const s = String(arg ?? ""), sp = s.indexOf(" ");
    const id = sp < 0 ? s : s.slice(0, sp), rest = sp < 0 ? "" : s.slice(sp + 1);
    const tab = TABS.find((x) => x.id === id);
    if (!tab) return;
    if (this.dbg.tab !== id) {
      this.dbgCurrent()?.onHide?.(this.dt, cx);
      this.dbg.tab = id;
      if (this.dbg.open) tab.onShow?.(this.dt, cx);
    }
    if (rest === "tall" || rest === "short") this.dbg.tall = rest === "tall";
    else if (rest) tab.command?.(this.dt, rest, cx);
    cx.notify();
  },

  // Is the helper new enough for /devtools? (An older one is still running until restarted.)
  dbgHello(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await fetch(`${apiBase()}/devtools/hello`);
        const legacy = !r.ok;
        if (legacy !== this.dt.legacy) {
          this.dt.legacy = legacy;
          for (const tab of TABS) { const s = this.dt.state[tab.id]; if (s && "gen" in s) Object.assign(s, { gen: "", ver: -1, lver: -1 }); }
          if (this.dbg.open) this.dbgCurrent()?.onShow?.(this.dt, cx);
          cx.notify();
        }
      } catch {}
    });
  },

  dbgPoll(cx) {
    const d = this.dbg;
    if (!this.connected || !this.visible) return;
    if (!d.open) {
      // drawer closed: agents' rules and holds still show, as a badge in the toolbar (every 3 s)
      if (++this.dbgTicks % 3 || this.dbgIcptBusy) return;
      if (this.dt.legacy) { if (this.dbgTicks % 30 === 0) this.dbgHello(cx); return; } // an old helper: ask again now and then
      this.dbgIcptBusy = true;
      cx.spawn(async (cx) => {
        try { const before = JSON.stringify(d.icpt); this.dt.sawIntercept(await this.dt.get("/devtools/intercept?summary=1&passive=1")); if (JSON.stringify(d.icpt) !== before) cx.notify(); }
        catch (e) { if (e?.status === 404 || e?.status === 405) this.dt.legacy = true; } finally { this.dbgIcptBusy = false; }
      });
      return;
    }
    // unknown, or an old helper that may have been restarted meanwhile (every 5 s)
    if (this.dt.legacy === undefined || (this.dt.legacy && ++this.dbgTicks % 5 === 0)) this.dbgHello(cx);
    const tab = this.dbgCurrent();
    tab?.poll?.(this.dt, cx);
    // the badge (and Intercept's "someone is watching") while another tab shows
    if ((d.icpt.on || d.icpt.rules || d.icpt.n || !tab?.poll) && tab?.id !== "intercept" && !this.dbgIcptBusy && !this.dt.legacy) {
      this.dbgIcptBusy = true;
      cx.spawn(async (cx) => {
        try { const before = JSON.stringify(d.icpt); this.dt.sawIntercept(await this.dt.get("/devtools/intercept?summary=1")); if (JSON.stringify(d.icpt) !== before) cx.notify(); }
        catch {} finally { this.dbgIcptBusy = false; }
      });
    }
  },

  // What the badge says: the drawer's Intercept, agents' rules, held requests.
  dbgBadgeText(short) {
    const i = this.dbg.icpt, parts = [];
    if (i.n) parts.push(`${i.n} held`);
    if (i.rules) parts.push(`${i.rules} rule${i.rules === 1 ? "" : "s"}`);
    if (short) return String(i.n || i.rules || "");
    return `${i.on ? "Intercepting" : "Intercept"}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
  },

  // main.js header (hook): a badge in the toolbar while the drawer is closed and agents' rules
  // or held requests are active. [] or [element].
  dbgToolbarBadge(t) {
    const i = this.dbg?.icpt;
    if (!i || this.dbg.open || !(i.on || i.rules || i.n) || !this.connected) return [];
    const short = (this.rootW ?? 0) < 620;
    return [h_flex().id("bp-icpt-toolbar").h(24).px(7).gap(5).ml(2).flex_none().items_center().rounded(12)
      .bg(`${t.blocked}26`).border_1().border_color(t.blocked).text_size(11).font_semibold().text_color(t.blocked)
      .cursor_pointer().hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { if (!this.dbg.open) this.toggleDebug(cx); this.dbgTab("intercept", cx); })
      .tooltip("Agents' intercept rules are active in this browser: matching traffic is rewritten or held. Click to see them.")
      .child(div().size(7).rounded(4).bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1100 }))
      .when(!short || this.dbgBadgeText(true), (el) => el.child(this.dbgBadgeText(short)))];
  },

  // main.js close(): the panel goes, so nothing may stay held.
  async dbgUnload() {
    if (this.dbg?.icpt?.on || this.dt?.state?.intercept?.on) await releaseIntercept(this.dt);
  },

  restartHelper(cx) {
    // The helper exits (the browser and its tabs stay); the panel starts a fresh one.
    this.dt.legacy = undefined;
    this.call("/detach", {}, cx);
    this.toast("Restarting the browser helper…", null, cx, 2500);
  },

  drawer(t) {
    const d = this.dbg, dt = this.dt, U = ui(t), cur = this.dbgCurrent();
    const H = this.dbgHeight();
    const tabEl = (tab) => h_flex().id(`bp-dbg-${tab.id}`).h(31).px(10).items_center().text_size(12)
      .border_b(2).border_color(d.tab === tab.id ? t.accent : t.background).text_color(d.tab === tab.id ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.dbgTab(tab.id, cx)).child(tab.label);
    const badge = h_flex().id("bp-dbg-icpt-badge").h(22).px(8).gap(6).flex_none().items_center().rounded(11)
      .bg(`${t.blocked}26`).border_1().border_color(t.blocked).text_size(11).font_semibold().text_color(t.blocked)
      .cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => this.dbgTab("intercept", cx))
      .tooltip(d.icpt.on ? "Intercept is on: matching requests (agents' too) wait for you. Click to see them." : "Agents' intercept rules are rewriting or holding traffic. Click to see them.")
      .child(div().size(7).rounded(4).bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1100 }))
      .child(this.dbgBadgeText(false));
    const head = h_flex().h(32).flex_none().px(4).gap(2).items_center().border_b(1).border_color(t.border)
      .children(TABS.map(tabEl))
      .child(div().flex_1().min_w(4))
      .when(d.icpt.on || d.icpt.rules > 0 || d.icpt.n > 0, (el) => el.child(badge).child(div().w(4)))
      .when(Boolean(cur?.clear), (el) => el.child(U.icon("bp-dbg-clear", "trash", "Clear", (_e, cx) => cur.clear(dt, cx))))
      .when(Boolean(cur?.copy), (el) => el.child(U.icon("bp-dbg-copy", "copy", cur.copyTip ?? "Copy", (_e, cx) => { const text = cur.copy(dt); if (text) dt.copy(text, cx); })))
      .child(U.icon("bp-dbg-size", d.tall ? "dt-minimize" : "dt-maximize", d.tall ? "Smaller drawer" : "Taller drawer", (_e, cx) => { d.tall = !d.tall; cx.notify(); }))
      .child(U.icon("bp-dbg-close", "x", d.icpt.on ? "Close (Intercept turns off: held requests go on)" : "Close", (_e, cx) => this.toggleDebug(cx)));
    let body = v_flex().flex_1().min_h(0);
    if (dt.legacy) {
      body = body.child(h_flex().px(8).py(5).gap(8).flex_none().items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(11.5)
        .child(div().flex_1().min_w(0).text_color(t.muted).child("This browser helper started before the devtools update, so bodies, stacks, Edit and resend and Intercept aren't there yet. Restarting it keeps the browser and its tabs."))
        .child(U.button("bp-dbg-restart", "Restart helper", (_e, cx) => this.restartHelper(cx), { primary: true })));
    }
    if (cur?.toolbar) { const tb = cur.toolbar(t, dt); if (tb) body = body.child(tb); }
    body = body.child(cur ? cur.render(t, dt) : U.empty("No tabs"));
    return v_flex().id("bp-drawer").h(H).flex_none().border_t(1).border_color(t.border).bg(t.background)
      .on_mouse_down("left", stop).on_scroll_wheel(stop)
      .child(head).child(body);
  },
};
