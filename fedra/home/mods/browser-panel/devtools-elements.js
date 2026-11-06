// The debug drawer's Elements tab: the page's DOM as a tree you open as you go, Chrome's inspect
// mode (point at an element in the page: Chrome highlights it there and the tree follows; click
// locks it), and the selected node's outerHTML in an editor with Apply and Revert.
//
// A tab of the drawer's registry (debug.js: registerTab(DomElementsTab), which replaces the
// read-only Elements); its methods (dte*) and state (this.dte) live on the Browser view. The helper
// side is devtools-dom.mjs. The tree comes as rows from the helper, a window of a few hundred
// around what shows, and only the rows on screen are built, so a page of tens of thousands of
// elements draws like a small one.

import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, h_resizable, v_resizable, resizable_panel } from "gpui-base";
import { theme } from "atrous";
import { apiGet, apiPost, iconBtn, textBtn, notice, windowed, scrollInto, mono, syntax, mixin } from "./devtools-dom-ui.js";

const RH = 20; // tree row height
const WIN = 400, MARGIN = 120; // rows fetched around the view, and how close to its edge before fetching more
const PREVIEW_MAX = 12_000, EDIT_MAX = 250_000;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

// One tree row as colored pieces: <tag attr="value">…</tag>, "text", <!-- comment -->.
function pieces(r, t) {
  const out = [];
  let n = 0;
  const put = (s, c) => { if (n > 200) return; out.push([n + s.length > 200 ? `${s.slice(0, 200 - n)}…` : s, c]); n += s.length; };
  const tag = t.ansi4, name = t.ansi6, value = t.ansi3, punct = t.dim;
  switch (r.k) {
    case "e":
      put("<", punct); put(r.n, tag);
      for (let i = 0; i < r.a.length; i += 2) { put(` ${r.a[i]}`, name); if (r.a[i + 1] !== "") put(`="${r.a[i + 1]}"`, value); }
      if (r.m) put(" …", punct);
      put(">", punct);
      if (r.x !== undefined) { put(r.x, t.foreground); put(`</${r.n}>`, tag); }
      else if (r.e && !r.o) { put("…", t.muted); put(`</${r.n}>`, tag); }
      else if (!r.e && !VOID.has(r.n) && !r.n.startsWith("::")) put(`</${r.n}>`, tag);
      break;
    case "/": put(`</${r.n}>`, tag); break;
    case "t": put(`"${r.x}"`, t.foreground); break;
    case "c": put(`<!--${r.x}-->`, t.dim); break;
    case "dt": put(r.x, t.dim); break;
    default: put(r.x ?? "", t.muted);
  }
  return out;
}

export const Elements = {
  dteInit(cx) {
    if (this.dte) return;
    this.dte = {
      active: false, looping: false, gen: 0, ver: -1, tver: -1, total: 0, win: { from: 0, rows: [] }, scroll: { top: 0, viewH: 200 },
      sel: null, hover: null, focus: null, focusLabel: "", selIndex: -1, focusIndex: -1, reveal: 0, locked: 0, crumbs: [],
      inspecting: false, loaded: false, error: null, old: false, rowHover: null, hoverBusy: false, fetchingWin: false, wantWin: false,
      html: { id: null, original: "", label: "", kind: 0, total: 0, truncated: false, preview: false, dirty: false, error: null, applying: false, loadingFor: null },
    };
    this.dteFocus = cx.focus_handle();
    this.dteEd = EditorState.new({ language: "html", value: "", font_family: mono(), font_size: 12, soft_wrap: false, syntax: syntax(theme()) });
    this.dteEd.on("change", (_e, cx) => {
      const h = this.dte.html;
      const dirty = this.dteEd.value() !== h.original;
      if (dirty !== h.dirty) { h.dirty = dirty; cx.notify(); }
    });
    cx.timer.every(300, (cx) => this.dteTick(cx));
  },

  dteShown() {
    return Boolean(this.dbg?.open && this.dbg.tab === "elements" && this.connected && this.visible !== false);
  },

  // Starts the tab's long poll when it shows; when it stops showing, inspect mode and the
  // in-page highlight go and the helper forgets the tree (it keeps what was open for next time).
  dteTick(cx) {
    const d = this.dte, shown = this.dteShown();
    if (shown && !d.looping && !d.old && !this.dt?.legacy) { d.active = true; this.dteLoop(cx); }
    else if (!shown && d.active) this.dteHide(cx);
  },

  dteHide(cx) {
    const d = this.dte;
    if (!d.active) return;
    d.active = false; d.gen++; d.looping = false;
    d.htmlRequest = (d.htmlRequest ?? 0) + 1;
    d.html.scheduledFor = null;
    d.inspecting = false; d.hover = null; d.ver = -1; d.tver = -1;
    cx.spawn(async () => { await apiPost("/dom/close"); });
  },

  // `browser-panel.debug:elements <arg>`: inspect [on|off], picked, refresh, copy-page
  dteCommand(arg, cx) {
    const [what, v] = String(arg ?? "").split(" ");
    if (what === "inspect") this.dteInspect(v === "on" ? true : v === "off" ? false : !this.dte.inspecting, cx);
    else if (what === "picked") cx.spawn(async (cx) => { const r = await apiPost("/dom/select", { picked: true }); if (!r.ok) { this.dte.error = r.error; cx.notify(); } });
    else if (what === "refresh") this.dteRefresh(cx);
    else if (what === "copy-page") this.dteCopy(cx, true);
  },

  dteWindowAt() {
    const d = this.dte;
    return { from: Math.max(0, Math.floor(d.scroll.top / RH) - MARGIN), count: WIN };
  },

  dteLoop(cx) {
    const d = this.dte;
    d.looping = true;
    const gen = ++d.gen;
    cx.spawn(async (cx) => {
      try {
        while (gen === d.gen && this.dteShown()) {
          const w = this.dteWindowAt();
          const r = await apiGet(`/dom/state?since=${d.ver}&tree=${d.tver}&from=${w.from}&count=${w.count}&wait=6000`);
          if (gen !== d.gen) break;
          if (r.old) { d.old = true; cx.notify(); break; }
          if (!r.ok) {
            if (d.error !== r.error) { d.error = r.error; cx.notify(); }
            await cx.sleep(1200);
            continue;
          }
          this.dteState(r, cx);
        }
      } finally { if (gen === d.gen) d.looping = false; }
    });
  },

  dteState(r, cx) {
    const d = this.dte;
    const wasInspecting = d.inspecting;
    Object.assign(d, { ver: r.ver, total: r.total, loaded: r.loaded, error: r.error, sel: r.sel, hover: r.hover, focus: r.focus,
      focusLabel: r.focusLabel, selIndex: r.selIndex, focusIndex: r.focusIndex, crumbs: r.crumbs ?? [], inspecting: r.inspecting });
    if (r.rows) { d.tver = r.tver; d.win = { from: r.from, rows: r.rows }; }
    if (r.reveal !== d.reveal) { d.reveal = r.reveal; scrollInto(d.scroll, r.focusIndex, RH); }
    const locked = r.locked !== d.locked;
    d.locked = r.locked;
    if (locked && wasInspecting) this.dteFocus.focus();
    // The page's HTML was changed through the API (an agent, or Apply): show the new HTML.
    if (r.edits !== d.edits) { const first = d.edits === undefined; d.edits = r.edits; if (!first && !d.html.dirty) d.html.id = null; }
    this.dteWantHtml(cx);
    this.dteEnsureWindow(cx);
    cx.notify();
  },

  // Rows for what is on screen: fetched when the view nears the edge of the window it has.
  dteEnsureWindow(cx) {
    const d = this.dte, w = d.win;
    if (!d.total) return;
    const first = Math.floor(d.scroll.top / RH), last = Math.min(d.total, first + Math.ceil((d.scroll.viewH || 200) / RH) + 1);
    const end = w.from + w.rows.length;
    if (w.rows.length && first >= w.from && (last <= end || end >= d.total)) return;
    if (d.fetchingWin) { d.wantWin = true; return; }
    d.fetchingWin = true;
    cx.spawn(async (cx) => {
      try {
        do {
          d.wantWin = false;
          const at = this.dteWindowAt();
          const r = await apiGet(`/dom/rows?from=${at.from}&count=${at.count}`);
          if (r.ok) { d.win = { from: r.from, rows: r.rows }; d.tver = r.tver; d.total = r.total; cx.notify(); }
        } while (d.wantWin);
      } finally { d.fetchingWin = false; }
    });
  },

  // The editor shows the focused node: the one under the pointer while inspecting, else the
  // selected one. Unsaved edits are never replaced.
  dteWantHtml(cx) {
    const d = this.dte, h = d.html;
    if (!d.focus || h.dirty) return;
    const preview = d.inspecting && d.hover === d.focus;
    if (d.focus === h.id && (preview || !h.preview)) return;
    if (h.scheduledFor === d.focus && h.scheduledPreview === preview) return;
    const request = d.htmlRequest = (d.htmlRequest ?? 0) + 1;
    const id = d.focus;
    h.scheduledFor = id; h.scheduledPreview = preview;
    // Pointing across a page should load only the node the pointer settles on.
    cx.timer.after(preview ? 120 : 40, (cx) => {
      if (request === d.htmlRequest) h.scheduledFor = null;
      if (request === d.htmlRequest && id === d.focus && !h.dirty && this.dteShown()) this.dteLoadHtml(cx);
    });
  },

  dteLoadHtml(cx, force, full = false) {
    const d = this.dte, h = d.html;
    if (h.loadingFor) { h.again = true; return; }
    const id = d.focus;
    if (!id) return;
    const preview = d.inspecting && d.hover === id;
    h.loadingFor = id;
    cx.spawn(async (cx) => {
      try {
        const r = await apiGet(`/dom/html?id=${id}&max=${full ? EDIT_MAX : PREVIEW_MAX}`);
        if ((h.dirty && !force) || d.focus !== id) return;
        if (!r.ok) { h.error = r.error; h.id = id; h.preview = preview; cx.notify(); return; }
        const more = r.total - r.html.length;
        const text = r.truncated ? `${r.html}\n<!-- … ${more.toLocaleString("en-US")} more characters -->` : r.html;
        Object.assign(h, { id, original: text, label: r.label, kind: r.kind, total: r.total, truncated: r.truncated, preview, dirty: false, error: null });
        if (this.dteEd.value() !== text) this.dteEd.set_value(text);
        cx.notify();
      } finally {
        h.loadingFor = null;
        if (h.again || (d.focus && d.focus !== h.id && !h.dirty)) { h.again = false; this.dteWantHtml(cx); }
      }
    });
  },

  dteApply(cx) {
    const d = this.dte, h = d.html;
    if (!h.dirty || h.truncated || h.applying || !h.id) return;
    h.applying = true; h.error = null;
    const html = this.dteEd.value();
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await apiPost("/dom/set-html", { id: h.id, html });
      h.applying = false;
      if (!r.ok) { h.error = r.error || "The page didn't take this HTML"; cx.notify(); return; }
      h.dirty = false; h.id = null; h.original = "";
      if (r.sel) { d.sel = r.sel; if (!d.inspecting) d.focus = r.sel; }
      this.toast?.("Applied to the page", null, cx, 1600);
      this.dteLoadHtml(cx, true);
      cx.notify();
    });
  },

  dteRevert(cx) {
    const h = this.dte.html;
    this.dteEd.set_value(h.original);
    h.dirty = false; h.error = null;
    this.dteWantHtml(cx);
    cx.notify();
  },

  dteSelect(id, index, cx, reveal) {
    const d = this.dte;
    if (!id) return;
    d.sel = id;
    if (!d.inspecting) d.focus = id;
    if (index !== undefined && index >= 0) { d.selIndex = index; if (!d.inspecting) d.focusIndex = index; scrollInto(d.scroll, index, RH); }
    this.dteWantHtml(cx);
    cx.spawn(async (cx) => {
      const r = await apiPost("/dom/select", { id, reveal: Boolean(reveal) });
      if (!r.ok && r.error) { d.error = r.error; cx.notify(); }
    });
    cx.notify();
  },

  dteToggle(r, deep, cx) {
    const d = this.dte, row = d.win.rows[d.win.rows.findIndex((x) => x.i === r.i && x.k !== "/")];
    const open = !(row?.o);
    if (row) row.o = open ? 1 : 0; // shown at once; the rows follow from the helper
    cx.spawn(async (cx) => {
      const res = await apiPost("/dom/expand", { id: r.i, open, deep: Boolean(deep) });
      if (!res.ok && res.error) { d.error = res.error; cx.notify(); }
    });
    cx.notify();
  },

  dteRowClick(r, index, e, cx) {
    this.dteFocus.focus();
    if (r.k === "/") { const k = this.dte.win.rows.findIndex((x) => x.i === r.i && x.k !== "/"); return this.dteSelect(r.i, k < 0 ? undefined : k + this.dte.win.from, cx); }
    this.dteSelect(r.i, index, cx);
    if (e?.click_count === 2 && r.e) this.dteToggle(r, e.modifiers?.alt, cx);
  },

  // Hovering a row highlights its node in the page (Chrome draws it); one request at a time,
  // the newest wins.
  dteRowHover(id, leaving, cx) {
    const d = this.dte;
    if (d.inspecting) return;
    if (leaving !== null && leaving !== undefined) { if (d.rowHover !== leaving) return; id = null; }
    d.rowHover = id;
    if (d.hoverBusy) return;
    d.hoverBusy = true;
    cx.spawn(async () => {
      try {
        let sent;
        do { sent = d.rowHover; await apiPost("/dom/hover", { id: sent }); } while (sent !== d.rowHover);
      } finally { d.hoverBusy = false; }
    });
  },

  dteInspect(on, cx) {
    const d = this.dte;
    d.inspecting = on;
    if (!on) d.hover = null;
    if (on && this.st && this.st.inspect !== "off") { this.st.inspect = "off"; this.draft = null; } // the helper ends pick / annotate
    this.dteFocus.focus(); // Esc here stops it too
    cx.spawn(async (cx) => {
      const r = await apiPost("/dom/inspect", { on });
      if (!r.ok) { d.inspecting = false; d.error = r.error; }
      cx.notify();
    });
    cx.notify();
  },

  dteCopy(cx, page) {
    const d = this.dte, h = d.html;
    cx.spawn(async (cx) => {
      let r, what;
      if (page) { r = await apiPost("/dom/copy", { page: true }); what = "the page's HTML"; }
      else if (h.dirty) { const text = this.dteEd.value(); r = await apiPost("/clipboard", { text }); r.chars = text.length; what = "your edited HTML"; }
      else { r = await apiPost("/dom/copy", { id: h.id ?? d.sel }); what = `<${h.label || "element"}> HTML`; }
      this.toast?.(r.ok ? `Copied ${what} (${Number(r.chars ?? 0).toLocaleString("en-US")} characters)` : (r.error || "Couldn't copy"), null, cx, 1800);
    });
  },

  dteKey(e, cx) {
    const d = this.dte, k = String(e.key ?? "").toLowerCase();
    if (k === "escape" && d.inspecting) { cx.stop_propagation(); this.dteInspect(false, cx); return; }
    if (!["up", "down", "left", "right", "home", "end"].includes(k)) return;
    cx.stop_propagation();
    const at = (i) => d.win.rows[i - d.win.from];
    const cur = d.selIndex, row = at(cur);
    const step = (dir) => {
      for (let i = cur + dir; i >= 0 && i < d.total; i += dir) {
        const r = at(i);
        if (!r) return;
        if (r.k !== "/") return this.dteSelect(r.i, i, cx);
      }
    };
    if (k === "up") step(-1);
    else if (k === "down") step(1);
    else if (k === "home") { const r = at(0); if (r) this.dteSelect(r.i, 0, cx); }
    else if (k === "end") { for (let i = d.total - 1; i >= d.win.from; i--) { const r = at(i); if (r && r.k !== "/") { this.dteSelect(r.i, i, cx); break; } } }
    else if (k === "left") {
      if (row?.e && row.o) this.dteToggle(row, e.modifiers?.alt, cx);
      else { const p = d.crumbs[d.crumbs.length - 2]; if (p) this.dteSelect(p.i, undefined, cx, true); }
    } else if (k === "right") {
      if (row?.e && !row.o) this.dteToggle(row, e.modifiers?.alt, cx);
      else step(1);
    }
  },

  dteRefresh(cx) {
    const d = this.dte;
    d.ver = -1; d.tver = -1;
    cx.spawn(async (cx) => { const r = await apiPost("/dom/refresh"); if (!r.ok) d.error = r.error; cx.notify(); });
  },

  dteRestartHelper(cx) {
    this.dte.old = false;
    if (this.restartHelper) this.restartHelper(cx); // debug.js: the helper exits, the panel starts a new one; pages stay
    else cx.spawn(async () => { await apiPost("/detach"); });
    cx.notify();
  },

  // ---- drawing ----

  dteTools(t) {
    const d = this.dte, st = this.st;
    const picked = st?.picked && st.picked.targetId === st.targetId ? st.picked : null;
    const out = [
      iconBtn("dte-inspect", "dom-inspect", d.inspecting ? "Stop inspecting (Esc)" : "Inspect: point at an element in the page to see its HTML here; click to lock it",
        (_e, cx) => this.dteInspect(!d.inspecting, cx), t, { active: d.inspecting, size: 14 }),
    ];
    if (picked) out.push(iconBtn("dte-picked", "crosshair", `Show the element you picked (<${picked.tag}>)`, (_e, cx) => {
      cx.spawn(async (cx) => { const r = await apiPost("/dom/select", { picked: true }); if (!r.ok) { d.error = r.error; cx.notify(); } });
    }, t));
    out.push(textBtn("dte-copy-page", "Page HTML", (_e, cx) => this.dteCopy(cx, true), t, { icon: "copy", tip: "Copy the whole page's HTML" }));
    out.push(iconBtn("dte-refresh", "rotate-cw", "Reload the tree", (_e, cx) => this.dteRefresh(cx), t));
    return out;
  },

  // The row under the drawer's strip.
  dteToolbar(t) {
    const d = this.dte;
    const hint = d.inspecting ? "Point at an element in the page: it shows here. Click locks it, Esc stops."
      : "Click a row to edit its HTML · double-click opens it · Alt opens all below";
    return h_flex().id("dte-toolbar").h(30).px(8).gap(6).flex_none().items_center().border_b(1).border_color(t.border)
      .children(this.dteTools(t))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(d.inspecting ? t.accent : t.dim).text_right().child(hint));
  },

  dteRow(i, t, font) {
    const d = this.dte, r = d.win.rows[i - d.win.from];
    if (!r) return div().h(RH).flex_none();
    const key = r.k === "/" ? `${r.i}c` : `${r.i}`;
    const sel = r.i === d.sel, hov = d.inspecting && r.i === d.hover;
    const bg = sel ? (r.k === "/" ? `${t.selected}` : t.selected) : hov ? `${t.accent}2e` : t.background;
    return h_flex().id(`dte-r-${key}`).h(RH).flex_none().w_full().pl(4 + r.d * 12).pr(10).items_center().overflow_hidden().whitespace_nowrap()
      .text_size(11.5).font_family(font).bg(bg).cursor_default()
      .when(!sel, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((e, cx) => this.dteRowClick(r, i, e, cx))
      .on_hover((h, cx) => this.dteRowHover(h ? r.i : null, h ? null : r.i, cx))
      .child(r.e
        ? div().id(`dte-tw-${key}`).w(13).h(RH).flex_none().flex().items_center().justify_center().text_size(9).text_color(t.dim)
          .hover((s) => s.text_color(t.foreground))
          .on_click((e, cx) => { cx.stop_propagation(); this.dteToggle(r, e.modifiers?.alt, cx); })
          .child(r.o ? "▼" : "▶")
        : div().w(13).flex_none())
      .children(pieces(r, t).map(([s, c]) => div().flex_none().text_color(c).child(s)));
  },

  dteCrumbs(t) {
    const d = this.dte, list = d.crumbs;
    const shown = list.slice(-6);
    // aligned to the end: when the path is wider than the tree, its start is what gets cut
    return h_flex().id("dte-crumbs").h(22).flex_none().px(6).gap(2).items_center().justify_end().border_t(1).border_color(t.border).bg(t.surface)
      .overflow_hidden().whitespace_nowrap().text_size(11).font_family(mono())
      .when(list.length > shown.length, (el) => el.child(div().flex_none().text_color(t.dim).child("… ›")))
      .children(shown.flatMap((c, k) => {
        const last = k === shown.length - 1;
        const crumb = div().id(`dte-cr-${c.i}`).flex_none().px(4).rounded(4).text_color(last ? t.foreground : t.muted)
          .bg(last ? t.selected : t.surface).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.dteSelect(c.i, undefined, cx, true))
          .on_hover((h, cx) => this.dteRowHover(h ? c.i : null, h ? null : c.i, cx))
          .child(c.l.length > 34 ? `${c.l.slice(0, 33)}…` : c.l);
        return last ? [crumb] : [crumb, div().flex_none().text_color(t.dim).child("›")];
      }));
  },

  dteEditorPane(t) {
    const d = this.dte, h = d.html;
    const editable = [1, 3, 8].includes(h.kind) && !h.truncated;
    const canApply = h.dirty && editable && !h.applying;
    const title = !h.id ? "" : h.kind === 1 ? `<${h.label}>` : h.label;
    let status;
    if (h.preview && d.inspecting) status = "Pointing: click the element in the page to lock it and edit";
    else if (h.truncated) status = h.total <= EDIT_MAX
      ? `${h.total.toLocaleString("en-US")} characters: preview shown; load HTML to edit`
      : `${h.total.toLocaleString("en-US")} characters: preview shown; select something smaller to edit`;
    else if (h.dirty) status = d.focus !== h.id ? "Unsaved edits to the node shown here: Apply or Revert" : "Edited: Apply changes the page (Ctrl+Z in the page won't undo it)";
    else if (h.id) status = `${h.total.toLocaleString("en-US")} characters`;
    else status = "Select a node";
    return v_flex().size_full().min_w(0).min_h(0)
      .child(h_flex().h(28).flex_none().pl(8).pr(4).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_family(mono()).text_color(h.preview && d.inspecting ? t.muted : t.ansi4).child(title))
        .when(h.dirty, (el) => el.child(textBtn("dte-revert", "Revert", (_e, cx) => this.dteRevert(cx), t, { tip: "Put the HTML back as the page has it" })))
        .when(h.truncated && h.total <= EDIT_MAX && !d.inspecting, (el) => el.child(textBtn("dte-load-html", "Load HTML", (_e, cx) => this.dteLoadHtml(cx, false, true), t,
          { disabled: Boolean(h.loadingFor) || h.dirty, tip: "Load this element's complete HTML for editing" })))
        .child(textBtn("dte-apply", h.applying ? "Applying…" : "Apply", (_e, cx) => this.dteApply(cx), t,
          { primary: canApply, disabled: !canApply, tip: editable ? "Replace this node in the page with the HTML here" : "This node can't be edited here" }))
        .child(iconBtn("dte-copy", "copy", h.dirty ? "Copy the edited HTML" : "Copy this node's HTML", (_e, cx) => this.dteCopy(cx, false), t, { disabled: !h.id })))
      .when(Boolean(h.error), (el) => el.child(notice(t, h.error, "error")))
      .child(Editor.new(this.dteEd).flex_1().min_h(0))
      .child(div().h(20).flex_none().px(8).pt(3).truncate().text_size(10.5).text_color(h.dirty ? t.ansi3 : t.dim).border_t(1).border_color(t.border).child(status));
  },

  dteBody(t) {
    const d = this.dte;
    if (d.old || this.dt?.legacy) {
      // an older helper (the drawer shows its own Restart helper above when it's older than the devtools)
      return v_flex().flex_1().min_h(0).items_center().justify_center().gap(10).p(20).text_size(12).text_color(t.muted)
        .child(div().child("This tab needs the newer browser helper."))
        .when(!this.dt?.legacy, (el) => el.child(textBtn("dte-restart", "Restart the helper", (_e, cx) => this.dteRestartHelper(cx), t, { primary: true, h: 26, px: 12,
          tip: "Restarts the panel's helper process; your pages and tabs stay open" })));
    }
    const font = mono();
    const tree = !d.total
      ? div().flex_1().p(12).text_size(12).text_color(d.error ? t.blocked : t.dim).child(d.error ?? "Loading the page's elements…")
      : windowed("dte-tree", d.total, RH, d.scroll, (i) => this.dteRow(i, t, font), t, (cx) => this.dteEnsureWindow(cx))
        .on_hover((h, cx) => { if (!h) this.dteRowHover(null, this.dte.rowHover, cx); });
    const left = v_flex().size_full().min_w(0).min_h(0)
      .when(Boolean(d.error && d.total), (el) => el.child(notice(t, d.error, "error")))
      .child(tree)
      .child(this.dteCrumbs(t));
    const W = this.rootW || 700, wide = W >= 560;
    const split = (wide ? h_resizable("dte-split") : v_resizable("dte-split-v")).flex_1().min_h(0).min_w(0)
      .child(resizable_panel().child(left))
      .child(resizable_panel().size(wide ? Math.round(W * 0.46) : 150).size_range(wide ? 200 : 80, 4000).child(this.dteEditorPane(t)));
    return v_flex().id("dte-body").flex_1().min_h(0).min_w(0).track_focus(this.dteFocus).on_key_down((e, cx) => this.dteKey(e, cx))
      .child(split);
  },
};

// The drawer's registry (debug.js): replaces the read-only Elements tab.
export const DomElementsTab = {
  id: "elements",
  label: "Elements",
  init(dt, cx) { mixin(dt.view, Elements); dt.view.dteInit(cx); },
  onShow(dt, cx) { dt.view.dteTick(cx); },
  onHide(dt, cx) { dt.view.dteHide(cx); },
  toolbar(t, dt) { return dt.view.dteToolbar(t); },
  render(t, dt) { return dt.view.dteBody(t); },
  command(dt, arg, cx) { dt.view.dteCommand(arg, cx); },
};
