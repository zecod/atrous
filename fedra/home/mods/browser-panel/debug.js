// The debug drawer (</>): Console, Network and Elements for the shown tab, mixed into the
// Browser view (main.js). The helper keeps bounded buffers per tab from the moment the tab
// exists (500 console entries, 300 requests); the drawer polls them once a second while it is
// open and draws them with virtual lists, so a busy page costs only the rows on screen.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState, v_virtual_list, Scrollbar } from "gpui-base";
import { settings, theme } from "herdr";

const I = (name) => `mods/browser-panel/icons/${name}.svg`;
const stop = (_e, cx) => cx.stop_propagation();
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`);
const nameOf = (url) => { try { const u = new URL(url); return (u.pathname.split("/").filter(Boolean).pop() || u.host) + (u.search ? u.search.slice(0, 30) : ""); } catch { return url; } };

export const Debug = {
  initDebug(cx) {
    this.dbg = { open: false, tab: "console", ver: -1, kind: null, list: [], shown: [], filter: "", level: "all", sel: null, detail: null, htmlWhat: "page", htmlFor: null };
    this.dbgFilter = InputState.new({ placeholder: "Filter" });
    this.dbgFilter.on("change", (_e, cx) => { this.dbg.filter = this.dbgFilter.value(); this.dbgRefilter(); cx.notify(); });
    this.dbgCode = null; // EditorState for Elements, made on first use
    cx.timer.every(1000, (cx) => this.dbgPoll(cx));
  },

  toggleDebug(cx) {
    this.dbg.open = !this.dbg.open;
    this.dbg.ver = -1;
    if (this.dbg.open) this.dbgLoad(cx);
    cx.notify();
  },

  dbgTab(tab, cx) {
    if (this.dbg.tab === tab) return;
    Object.assign(this.dbg, { tab, ver: -1, list: [], shown: [], sel: null, detail: null, level: "all" });
    this.dbgLoad(cx);
    cx.notify();
  },

  dbgPoll(cx) {
    if (this.dbg.open && this.connected && this.visible && this.dbg.tab !== "elements") this.dbgLoad(cx);
  },

  dbgLoad(cx) {
    if (this.dbgBusy || !this.connected) return;
    const d = this.dbg;
    if (d.tab === "elements") return this.dbgHtml(d.htmlWhat, cx);
    this.dbgBusy = true;
    const kind = d.tab;
    cx.spawn(async (cx) => {
      try {
        const r = await (await fetch(`http://127.0.0.1:9334/debug?kind=${kind}&since=${d.kind === kind ? d.ver : -1}`)).json();
        if (!r.ok || r.same || this.dbg.tab !== kind) return;
        d.ver = r.ver; d.kind = kind; d.list = r.entries ?? [];
        this.dbgRefilter();
        cx.notify();
      } catch {} finally { this.dbgBusy = false; }
    });
  },

  dbgRefilter() {
    const d = this.dbg, f = d.filter.trim().toLowerCase();
    d.shown = d.list.filter((e) => {
      if (d.tab === "console") {
        if (d.level === "errors" && e.level !== "error") return false;
        if (d.level === "warnings" && e.level !== "warn") return false;
        return !f || e.text.toLowerCase().includes(f) || e.source.toLowerCase().includes(f);
      }
      if (d.level === "errors" && !(e.failed || e.status >= 400)) return false;
      return !f || e.url.toLowerCase().includes(f) || String(e.status).includes(f) || e.type.toLowerCase().includes(f);
    });
  },

  dbgSelect(key, cx) {
    const d = this.dbg;
    d.sel = key;
    if (d.tab === "console") { d.detail = d.list.find((e) => String(e.n) === key) ?? null; cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const r = await (await fetch(`http://127.0.0.1:9334/debug-request?id=${encodeURIComponent(key)}`)).json();
        if (d.sel === key) { d.detail = r.ok ? r : null; cx.notify(); }
      } catch {}
    });
  },

  dbgClear(cx) {
    const kind = this.dbg.tab;
    Object.assign(this.dbg, { list: [], shown: [], sel: null, detail: null, ver: -1 });
    this.call("/debug-clear", { kind }, cx);
    cx.notify();
  },

  dbgHtml(what, cx) {
    this.dbg.htmlWhat = what;
    this.dbgBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await (await fetch(`http://127.0.0.1:9334/html?what=${what}`)).json();
        const html = r.ok ? r.html : `<!-- ${r.error ?? "no HTML"} -->`;
        if (!this.dbgCode) {
          const t = theme();
          this.dbgCode = EditorState.new({ language: "html", readonly: true, value: html, font_family: settings().font_family, font_size: 12,
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        } else this.dbgCode.set_value(html);
        this.dbg.htmlFor = `${what}|${this.st?.url}`;
        this.dbg.htmlChars = html.length;
        cx.notify();
      } catch {} finally { this.dbgBusy = false; }
    });
  },

  dbgCopy(cx) {
    const d = this.dbg;
    let text = "";
    if (d.tab === "elements") text = this.dbgCode?.value() ?? "";
    else if (d.tab === "console") text = (d.detail ? [d.detail] : d.shown).map((e) => `[${e.level}] ${e.text}${e.source ? `  (${e.source})` : ""}`).join("\n");
    else if (d.detail) text = this.netText(d.detail);
    else text = d.shown.map((e) => `${e.method} ${e.status || e.error} ${e.url}`).join("\n");
    if (!text) return;
    this.call("/clipboard", { text }, cx);
    this.toast("Copied", null, cx, 1500);
  },

  netText(e) {
    const h = (o) => Object.entries(o ?? {}).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    return `${e.method} ${e.url}\nStatus: ${e.failed ? `failed (${e.error})` : e.status}  Type: ${e.type}  Size: ${kb(e.size)}  Time: ${e.time} ms\n\nRequest headers\n${h(e.reqHeaders)}\n\nResponse headers\n${h(e.resHeaders)}`;
  },

  // ---- drawing ----

  drawer(t) {
    const d = this.dbg, mono = settings()?.font_family || "JetBrains Mono";
    const tab = (id, label) => h_flex().id(`bp-dbg-${id}`).h(30).px(10).items_center().text_size(12)
      .border_b(2).border_color(d.tab === id ? t.accent : t.background).text_color(d.tab === id ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.dbgTab(id, cx)).child(label);
    const chip = (id, label, value) => h_flex().id(`bp-dbg-lv-${id}`).h(22).px(7).items_center().rounded(5).text_size(11)
      .bg(d.level === value ? t.selected : t.background).text_color(d.level === value ? t.foreground : t.muted)
      .cursor_pointer().on_click((_e, cx) => { d.level = value; this.dbgRefilter(); cx.notify(); }).child(label);
    const pick = (what, label) => h_flex().id(`bp-dbg-html-${what}`).h(22).px(7).items_center().rounded(5).text_size(11)
      .bg(d.htmlWhat === what ? t.selected : t.background).text_color(d.htmlWhat === what ? t.foreground : t.muted)
      .cursor_pointer().on_click((_e, cx) => this.dbgHtml(what, cx)).child(label);
    const icon = (id, name, tip, action) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action)
      .child(svg(I(name)).size(13));
    const H = Math.max(150, Math.min((this.rootH ?? 600) * 0.42, (this.rootH ?? 600) - 200));
    const head = h_flex().h(32).flex_none().px(4).gap(2).items_center().border_b(1).border_color(t.border)
      .child(tab("console", "Console")).child(tab("network", "Network")).child(tab("elements", "Elements"))
      .child(div().flex_1())
      .when(d.tab !== "elements", (el) => el
        .child(Input.new(this.dbgFilter).w(120).h(24).px(7).rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(11.5))
        .child(chip("all", "All", "all"))
        .child(chip("err", "Errors", "errors"))
        .when(d.tab === "console", (e) => e.child(chip("warn", "Warnings", "warnings")))
        .child(icon("bp-dbg-clear", "trash", "Clear", (_e, cx) => this.dbgClear(cx))))
      .when(d.tab === "elements", (el) => el
        .child(pick("page", "Page"))
        .child(pick("picked", "Picked element"))
        .child(icon("bp-dbg-reload", "rotate-cw", "Reload the HTML", (_e, cx) => this.dbgHtml(d.htmlWhat, cx))))
      .child(icon("bp-dbg-copy", "copy", "Copy", (_e, cx) => this.dbgCopy(cx)))
      .child(icon("bp-dbg-close", "x", "Close", (_e, cx) => this.toggleDebug(cx)));

    let body;
    if (d.tab === "elements") {
      body = this.dbgCode
        ? v_flex().flex_1().min_h(0).child(Editor.new(this.dbgCode).flex_1().min_h(0))
          .child(div().h(20).px(8).text_size(10.5).text_color(t.dim).child(`${(d.htmlChars ?? 0).toLocaleString("en-US")} characters${d.htmlWhat === "picked" ? " · the last element you picked or annotated" : ""}`))
        : div().p(12).text_color(t.dim).text_size(12).child("Loading…");
    } else {
      const rows = d.shown;
      const level = { error: [t.blocked, "✕"], warn: [t.ansi3, "▲"], nav: [t.dim, "→"], info: [t.ansi4, "i"], debug: [t.dim, "·"], log: [t.muted, "›"] };
      const row = d.tab === "console"
        ? (e) => {
          const [c, g] = level[e.level] ?? level.log;
          return h_flex().h(22).px(8).gap(7).items_center().border_b(1).border_color(t.border).text_size(11.5).font_family(mono)
            .bg(String(e.n) === d.sel ? t.selected : e.level === "error" ? `${t.blocked}14` : t.background)
            .child(div().w(10).flex_none().text_color(c).child(g))
            .child(div().flex_1().min_w(0).truncate().text_color(e.level === "nav" ? t.dim : e.level === "error" ? t.blocked : t.foreground).child(e.text.split("\n")[0]))
            .child(div().max_w(150).flex_none().truncate().text_color(t.dim).child(e.source));
        }
        : (e) => {
          const bad = e.failed || e.status >= 400;
          return h_flex().h(22).px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5).font_family(mono)
            .bg(e.id === d.sel ? t.selected : bad ? `${t.blocked}14` : t.background).text_color(bad ? t.blocked : t.foreground)
            .child(div().w(34).flex_none().child(e.failed ? "✕" : e.status ? String(e.status) : e.done ? "–" : "…"))
            .child(div().w(42).flex_none().text_color(t.muted).child(e.method))
            .child(div().flex_1().min_w(0).truncate().child(nameOf(e.url)))
            .child(div().w(62).flex_none().truncate().text_color(t.dim).child(e.type))
            .child(div().w(54).flex_none().text_color(t.dim).child(e.done ? kb(e.size) : ""))
            .child(div().w(52).flex_none().text_color(t.dim).child(e.time ? `${e.time} ms` : ""));
        };
      const list = rows.length
        ? v_flex().relative().flex_1().min_h(0)
          .child(v_virtual_list("bp-dbg-rows", rows.length, 22, (i) => String(d.tab === "console" ? rows[i].n : rows[i].id),
            (range) => rows.slice(range.start, range.end).map(row)).size_full()
            .on_item_click((key, cx) => this.dbgSelect(key, cx)))
          .child(Scrollbar.vertical("bp-dbg-rows").absolute().inset_0())
        : div().flex_1().p(12).text_size(12).text_color(t.dim).child(d.list.length ? "Nothing matches the filter" : d.tab === "console" ? "No console messages yet" : "No requests yet");
      const detail = d.detail && (d.tab === "console" ? String(d.detail.n) === d.sel : d.detail.rid === d.sel)
        ? div().id("bp-dbg-detail-box").h(Math.min(150, H * 0.45)).flex_none().border_t(1).border_color(t.border).bg(t.surface)
          .child(v_flex().id("bp-dbg-detail").size_full().overflow_y_scrollbar().p(8).text_size(11.5).font_family(mono).text_color(t.foreground)
            .children((d.tab === "console" ? `${d.detail.text}${d.detail.source ? `\n\n${d.detail.source}` : ""}` : this.netText(d.detail))
              .split("\n").slice(0, 400).map((l) => div().child(l || " "))))
        : null;
      body = v_flex().flex_1().min_h(0).child(list).when(Boolean(detail), (el) => el.child(detail));
    }
    return v_flex().id("bp-drawer").h(H).flex_none().border_t(1).border_color(t.border).bg(t.background)
      .on_mouse_down("left", stop).on_scroll_wheel(stop)
      .child(head).child(body);
  },
};
