// The debug drawer's Application tab: what the shown page's site keeps in this browser. Cookies,
// Local and Session Storage (edit in place or in the detail pane, add, delete, clear), IndexedDB
// (read only), Cache Storage (entries, a response's body, delete), service workers (unregister)
// and the storage summary (usage, quota, Clear site data). Destructive actions ask first, here.
//
// A tab of the drawer's registry (debug.js: registerTab(ApplicationTab)); its methods (dta*) and
// state (this.dta) live on the Browser view. The helper side is devtools-dom.mjs.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Editor, EditorState } from "gpui-base";
import { theme } from "herdr";
import { I, apiGet, apiPost, iconBtn, textBtn, notice, windowed, mono, clip, bytes, syntax, mixin } from "./devtools-dom-ui.js";

const RH = 22;
const SECTIONS = [
  ["cookies", "Cookies", "dom-cookie"], ["local", "Local Storage", "dom-list"], ["session", "Session Storage", "dom-list"],
  ["idb", "IndexedDB", "dom-database"], ["cache", "Cache Storage", "dom-archive"], ["workers", "Service Workers", "dom-cog"],
  ["storage", "Storage", "dom-hard-drive"],
];
const PATH = { cookies: "/app/cookies", local: "/app/storage?kind=local", session: "/app/storage?kind=session", idb: "/app/idb",
  cache: "/app/caches", workers: "/app/workers", storage: "/app/usage" };
const SAME_SITE = [["", "Unset"], ["Lax", "Lax"], ["Strict", "Strict"], ["None", "None"]];
const ck = (c) => `${c.name}\u0001${c.domain}\u0001${c.path}`;
const when = (s) => { if (!(s > 0)) return "Session"; const d = new Date(s * 1000); return isNaN(d) ? String(s) : d.toISOString().slice(0, 16).replace("T", " "); };
const LANGS = { json: "json", javascript: "js", ecmascript: "js", html: "html", css: "css", xml: "html", svg: "html" };
const langOf = (type) => { const m = /(json|javascript|ecmascript|html|css|xml|svg)/i.exec(type ?? ""); return m ? LANGS[m[1].toLowerCase()] : "txt"; };

export const App = {
  dtaInit(cx) {
    if (this.dta) return;
    this.dta = {
      section: "cookies", active: false, looping: false, gen: 0, ver: -1, old: false,
      data: {}, sig: {}, loading: {}, error: {}, sel: {}, scroll: {}, filter: "",
      confirm: null, edit: null, inline: null, form: {}, busy: false, msg: null,
      idb: null, cache: null, view: null,
    };
    const F = (placeholder) => InputState.new({ placeholder });
    this.dtaF = { filter: F("Filter"), name: F("Name"), domain: F("Domain"), path: F("/"), expires: F("Session"), key: F("Key"), inline: F(""),
      value: TextareaState.new({ placeholder: "Value", rows: 4 }), svalue: TextareaState.new({ placeholder: "Value", rows: 6 }) };
    this.dtaF.value.set_auto_grow(3, 8);
    this.dtaF.filter.on("change", (_e, cx) => { this.dta.filter = this.dtaF.filter.value(); for (const s of Object.values(this.dta.scroll)) s.top = 0; cx.notify(); });
    this.dtaF.inline.on("submit", (_e, cx) => this.dtaInlineSave(cx));
    this.dtaF.inline.on("blur", (_e, cx) => { if (this.dta.inline && !this.dta.inline.saving) { this.dta.inline = null; cx.notify(); } });
    this.dtaFocus = cx.focus_handle();
    cx.timer.every(300, (cx) => this.dtaTick(cx));
  },

  dtaShown() {
    return Boolean(this.dbg?.open && this.dbg.tab === "application" && this.connected && this.visible !== false);
  },

  dtaTick(cx) {
    const a = this.dta, shown = this.dtaShown();
    if (shown && !a.looping && !a.old && !this.dt?.legacy) { a.active = true; this.dtaLoop(cx); }
    else if (!shown && a.active) this.dtaHide(cx);
  },

  dtaHide() {
    const a = this.dta;
    a.active = false; a.gen++; a.looping = false; a.confirm = null; a.inline = null;
  },

  // Refreshes the shown section whenever the helper says something changed (storage events,
  // navigation, an edit) and, for cookies (which have no events), every few seconds.
  dtaLoop(cx) {
    const a = this.dta;
    a.looping = true;
    const gen = ++a.gen;
    this.dtaFetch(cx, a.section);
    cx.spawn(async (cx) => {
      try {
        while (gen === a.gen && this.dtaShown()) {
          const r = await apiGet(`/app/watch?since=${a.ver}&wait=4000`);
          if (gen !== a.gen) break;
          if (r.old) { a.old = true; cx.notify(); break; }
          if (!r.ok) { await cx.sleep(1500); continue; }
          const changed = r.ver !== a.ver;
          const navigated = a.url !== undefined && r.url !== a.url;
          a.ver = r.ver; a.url = r.url;
          if (navigated) { a.sel = {}; a.edit = null; a.inline = null; a.confirm = null; a.idb = null; a.cache = null; a.view = null; }
          if (changed) {
            for (const k of Object.keys(a.data)) a.data[k].stale = true;
            this.dtaFetch(cx, a.section, true);
            if (a.section === "cache" && a.cache) this.dtaCacheEntries(cx);
            if (a.section === "idb" && a.idb && !a.view) this.dtaIdbOpen(a.idb.db, a.idb.store, cx);
          } else if (a.section === "cookies" || a.section === "workers") this.dtaFetch(cx, a.section, true);
        }
      } finally { if (gen === a.gen) a.looping = false; }
    });
  },

  dtaFetch(cx, section, quiet) {
    const a = this.dta;
    if (a.loading[section]) return;
    a.loading[section] = true;
    if (!quiet) cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await apiGet(PATH[section]);
        if (r.old) { a.old = true; return; }
        a.error[section] = r.ok ? null : r.error;
        if (!r.ok) return;
        const sig = JSON.stringify(r);
        if (sig === a.sig[section] && a.data[section]) { a.data[section].stale = false; return; }
        a.sig[section] = sig;
        a.data[section] = r;
        // a selection whose item went away goes too (an item being added stays)
        const sel = a.sel[section];
        if (sel !== undefined && sel !== null && !this.dtaItems(section).some((x) => x.key === sel)) {
          a.sel[section] = null;
          if (a.edit?.section === section && !a.edit.isNew) a.edit = null;
        }
      } finally { a.loading[section] = false; cx.notify(); }
    });
  },

  dtaSection(section, cx) {
    const a = this.dta;
    if (a.section === section) return;
    a.section = section; a.confirm = null; a.inline = null; a.edit = null; a.view = null;
    this.dtaF.filter.set_value(""); a.filter = "";
    if (!a.data[section] || a.data[section].stale) this.dtaFetch(cx, section);
    cx.notify();
  },

  // The shown section's rows, filtered: { key, ...item }.
  dtaItems(section = this.dta.section) {
    const a = this.dta, d = a.data[section], f = a.filter.trim().toLowerCase();
    if (!d) return [];
    let list = [];
    if (section === "cookies") list = (d.cookies ?? []).map((c) => ({ key: ck(c), ...c }));
    else if (section === "local" || section === "session") list = (d.items ?? []).map(([k, v]) => ({ key: k, k, v }));
    if (!f) return list;
    return list.filter((x) => (x.name ?? x.k ?? "").toLowerCase().includes(f) || String(x.value ?? x.v ?? "").toLowerCase().includes(f) || (x.domain ?? "").toLowerCase().includes(f));
  },

  dtaSelect(key, cx) {
    const a = this.dta, s = a.section;
    a.sel[s] = key; a.inline = null; a.msg = null;
    const item = this.dtaItems(s).find((x) => x.key === key);
    if (item) { a.edit = { section: s, isNew: false, item, error: null }; this.dtaFill(item); }
    this.dtaFocus.focus();
    cx.notify();
  },

  dtaFill(item) {
    const f = this.dtaF, a = this.dta;
    if (a.section === "cookies") {
      f.name.set_value(item.name ?? ""); f.value.set_value(item.value ?? ""); f.domain.set_value(item.domain ?? "");
      f.path.set_value(item.path ?? "/"); f.expires.set_value(item.expires > 0 ? new Date(item.expires * 1000).toISOString() : "");
      a.form = { httpOnly: Boolean(item.httpOnly), secure: Boolean(item.secure), sameSite: item.sameSite ?? "", priority: item.priority || undefined, partitionKey: item.partitionKey ?? null };
    } else { f.key.set_value(item.k ?? ""); f.svalue.set_value(item.v ?? ""); }
  },

  dtaAdd(cx) {
    const a = this.dta, s = a.section, d = a.data[s] ?? {};
    a.sel[s] = null; a.inline = null; a.confirm = null;
    if (s === "cookies") {
      this.dtaFill({ name: "", value: "", domain: d.host ?? "", path: "/", expires: -1, httpOnly: false, secure: /^https:/.test(d.url ?? ""), sameSite: "Lax" });
      this.dtaF.name.focus();
    } else { this.dtaFill({ k: "", v: "" }); this.dtaF.key.focus(); }
    a.edit = { section: s, isNew: true, item: null, error: null };
    cx.notify();
  },

  async dtaRun(cx, path, body, done) {
    const a = this.dta;
    a.busy = true; cx.notify();
    const r = await apiPost(path, body);
    a.busy = false;
    if (!r.ok) { if (a.edit) a.edit.error = r.error; else a.msg = { text: r.error, kind: "error" }; cx.notify(); return null; }
    done?.(r);
    this.dtaFetch(cx, a.section, true);
    cx.notify();
    return r;
  },

  dtaSave(cx) {
    const a = this.dta, e = a.edit, f = this.dtaF;
    if (!e) return;
    cx.spawn(async (cx) => {
      if (e.section === "cookies") {
        const exp = f.expires.value().trim();
        let expires = -1;
        if (exp && !/^session$/i.test(exp)) {
          const ms = Date.parse(exp);
          if (isNaN(ms)) { e.error = "Expires: a date like 2027-01-31 or 2027-01-31T12:00:00Z, or empty for a session cookie"; cx.notify(); return; }
          expires = ms / 1000;
        }
        const cookie = { name: f.name.value().trim(), value: f.value.value(), domain: f.domain.value().trim(), path: f.path.value().trim() || "/", expires, ...a.form };
        const old = e.isNew ? null : { name: e.item.name, domain: e.item.domain, path: e.item.path, partitionKey: e.item.partitionKey };
        await this.dtaRun(cx, "/app/cookie-set", { cookie, old }, () => {
          const d = (cookie.domain || a.data.cookies?.host || "").toLowerCase();
          a.sel.cookies = ck({ name: cookie.name, domain: d, path: cookie.path });
          a.edit = { ...e, isNew: false, item: { ...e.item, ...cookie, domain: d }, error: null };
          this.toast?.("Cookie saved", null, cx, 1400);
        });
      } else {
        const key = f.key.value();
        await this.dtaRun(cx, "/app/storage-set", { kind: e.section, key, value: f.svalue.value(), oldKey: e.isNew ? null : e.item.k }, () => {
          a.sel[e.section] = key;
          a.edit = { ...e, isNew: false, item: { key, k: key, v: f.svalue.value() }, error: null };
          this.toast?.("Saved", null, cx, 1400);
        });
      }
    });
  },

  dtaDelete(item, cx) {
    const a = this.dta, s = a.section;
    if (!item) return;
    cx.spawn(async (cx) => {
      const ok = s === "cookies"
        ? await this.dtaRun(cx, "/app/cookie-delete", { cookie: { name: item.name, domain: item.domain, path: item.path, partitionKey: item.partitionKey } })
        : await this.dtaRun(cx, "/app/storage-remove", { kind: s, key: item.k });
      if (ok) { a.sel[s] = null; a.edit = null; }
      cx.notify();
    });
  },

  dtaClearAll(cx) {
    const a = this.dta, s = a.section, n = (s === "cookies" ? a.data.cookies?.cookies : a.data[s]?.items)?.length ?? 0;
    const site = a.data[s]?.host || a.data[s]?.origin || "this site";
    a.confirm = {
      text: s === "cookies" ? `Delete all ${n} cookie${n === 1 ? "" : "s"} this page can see (${site} and its parent domains)?` : `Delete all ${n} item${n === 1 ? "" : "s"} in ${s === "local" ? "Local" : "Session"} Storage for ${site}?`,
      label: "Delete all",
      run: (cx) => this.dtaRun(cx, s === "cookies" ? "/app/cookie-clear" : "/app/storage-clear", { kind: s }, () => { a.sel[s] = null; a.edit = null; }),
    };
    cx.notify();
  },

  dtaInlineStart(item, cx) {
    const a = this.dta;
    a.inline = { section: a.section, key: item.key, item };
    this.dtaF.inline.set_value(String(item.value ?? item.v ?? ""));
    this.dtaF.inline.focus();
    cx.notify();
  },

  dtaInlineSave(cx) {
    const a = this.dta, i = a.inline;
    if (!i) return;
    i.saving = true;
    const value = this.dtaF.inline.value();
    cx.spawn(async (cx) => {
      const r = i.section === "cookies"
        ? await this.dtaRun(cx, "/app/cookie-set", { cookie: { ...i.item, value, expires: i.item.expires } })
        : await this.dtaRun(cx, "/app/storage-set", { kind: i.section, key: i.item.k, value });
      a.inline = null;
      if (r && a.edit && a.edit.item?.key === i.key) this.dtaFill({ ...a.edit.item, value, v: value });
      cx.notify();
    });
  },

  // IndexedDB: a store's first entries (read only).
  dtaIdbOpen(db, store, cx, skip = 0) {
    const a = this.dta;
    a.idb = { db, store, skip, entries: skip ? a.idb?.entries ?? [] : [], loading: true, sel: null, hasMore: false, error: null };
    a.view = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await apiGet(`/app/idb-data?db=${encodeURIComponent(db)}&store=${encodeURIComponent(store)}&skip=${skip}`);
      if (a.idb?.db !== db || a.idb.store !== store) return;
      a.idb.loading = false;
      if (!r.ok) a.idb.error = r.error;
      else { a.idb.entries = [...a.idb.entries, ...r.entries]; a.idb.hasMore = r.hasMore; }
      cx.notify();
    });
  },

  // A read-only code view (an IndexedDB value, a cached response).
  dtaShow(title, text, lang, cx) {
    const a = this.dta;
    let pretty = text;
    if (lang === "json") { try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    const old = a.view?.state;
    a.view = { title, state: EditorState.new({ language: lang, readonly: true, value: pretty, font_family: mono(), font_size: 12, soft_wrap: true, syntax: syntax(theme()) }) };
    try { old?.release(); } catch {}
    cx.notify();
  },

  dtaCacheOpen(c, cx) {
    const a = this.dta;
    a.cache = { id: c.id, name: c.name, entries: [], loading: true, sel: null, error: null, total: null };
    a.view = null;
    this.dtaCacheEntries(cx);
    cx.notify();
  },

  dtaCacheEntries(cx) {
    const a = this.dta, c = a.cache;
    if (!c) return;
    cx.spawn(async (cx) => {
      const r = await apiGet(`/app/cache-entries?cache=${encodeURIComponent(c.id)}&skip=0`);
      if (a.cache !== c) return;
      c.loading = false;
      if (!r.ok) c.error = r.error; else { c.entries = r.entries; c.total = r.total; c.error = null; }
      if (c.sel && !c.entries.some((e) => e.url === c.sel)) { c.sel = null; a.view = null; }
      cx.notify();
    });
  },

  dtaCacheSelect(e, cx) {
    const a = this.dta, c = a.cache;
    c.sel = e.url;
    a.view = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await apiGet(`/app/cache-response?cache=${encodeURIComponent(c.id)}&url=${encodeURIComponent(e.url)}`);
      if (a.cache !== c || c.sel !== e.url) return;
      if (!r.ok) { c.error = r.error; cx.notify(); return; }
      if (r.text === null) { a.view = { title: e.url, binary: `${r.type || "binary"} · ${bytes(r.size)}: no text to show` }; cx.notify(); return; }
      this.dtaShow(e.url, r.truncated ? `${r.text}\n… (cut at 200,000 characters)` : r.text, langOf(r.type), cx);
    });
  },

  // ---- drawing ----

  dtaTools(t) {
    return [iconBtn("dta-refresh", "rotate-cw", "Refresh", (_e, cx) => {
      const a = this.dta;
      this.dtaFetch(cx, a.section);
      if (a.section === "cache" && a.cache) this.dtaCacheEntries(cx);
      if (a.section === "idb" && a.idb) this.dtaIdbOpen(a.idb.db, a.idb.store, cx);
    }, t)];
  },

  dtaNav(t) {
    const a = this.dta;
    return v_flex().id("dta-nav").w(this.rootW && this.rootW < 520 ? 40 : 134).flex_none().py(4).gap(1).border_r(1).border_color(t.border).bg(t.surface)
      .children(SECTIONS.map(([id, label, icon]) => {
        const on = a.section === id;
        return h_flex().id(`dta-nav-${id}`).h(24).mx(4).px(6).gap(7).items_center().rounded(5).text_size(11.5)
          .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(label)
          .on_click((_e, cx) => this.dtaSection(id, cx))
          .child(svg(I(icon)).size(12).flex_none())
          .when(!(this.rootW && this.rootW < 520), (el) => el.child(div().flex_1().min_w(0).truncate().child(label)));
      }));
  },

  // A labeled field; `w`: a fixed width, "grow": shares a row with others.
  field(label, el, t, w) {
    return v_flex().gap(3).flex_none().when(typeof w === "number", (x) => x.w(w)).when(w === "grow", (x) => x.flex_1().min_w(0))
      .child(div().text_size(10.5).text_color(t.dim).child(label)).child(el);
  },

  input(state, t, o = {}) {
    return Input.new(state).h(24).px(6).rounded(5).border_1().border_color(t.input).bg(t.surface).text_size(11.5)
      .when(Boolean(o.mono), (el) => el.font_family(mono()));
  },

  dtaHead(t, title, extra) {
    const a = this.dta, d = a.data[a.section];
    return h_flex().h(30).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(12).font_semibold().text_color(t.foreground).child(title))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(a.section === "cache" && a.cache ? "" : d?.origin ?? d?.url ?? ""))
      .children(extra ?? [])
      .children(this.dtaTools(t));
  },

  dtaFilterBox(t) {
    return this.input(this.dtaF.filter, t).w(130);
  },

  dtaConfirmBar(t) {
    const a = this.dta, c = a.confirm;
    if (!c) return null;
    return notice(t, c.text, "warn", [
      textBtn("dta-confirm-no", "Cancel", (_e, cx) => { a.confirm = null; cx.notify(); }, t),
      textBtn("dta-confirm-yes", c.label, (_e, cx) => { a.confirm = null; c.run(cx); cx.notify(); }, t, { danger: true }),
    ]);
  },

  // The table of cookies or storage items, with the detail pane beside it when one is open.
  dtaTable(t) {
    const a = this.dta, s = a.section, items = this.dtaItems(s);
    const sc = a.scroll[s] ?? (a.scroll[s] = { top: 0, viewH: 200 });
    const cookies = s === "cookies";
    const open = Boolean(a.edit && a.edit.section === s);
    // as wide as the table allows: all nine columns, or the main ones with the flags in one
    const W = sc.viewW || 400, wide = cookies && W >= 720, mid = cookies && !wide && W >= 470;
    const flags = (x) => [x.httpOnly ? "H" : "", x.secure ? "S" : "", x.sameSite || ""].filter(Boolean).join(" ");
    const col = (w, text, c, o = {}) => div().when(Boolean(w), (el) => el.w(w).flex_none()).when(!w, (el) => el.flex_1().min_w(0))
      .truncate().when(Boolean(c), (el) => el.text_color(c)).when(Boolean(o.center), (el) => el.text_center()).child(text ?? "");
    const head = h_flex().h(RH).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(10.5).text_color(t.dim)
      .children(cookies
        ? [col(null, "Name"), col(null, "Value"), col(wide ? 120 : 96, "Domain"),
          ...(wide ? [col(54, "Path"), col(104, "Expires"), col(40, "Size"), col(18, "H", null, { center: true }), col(18, "S", null, { center: true }), col(46, "SameSite")]
            : mid ? [col(84, "Expires"), div().id("dta-flags-h").w(62).flex_none().truncate().tooltip("H: HttpOnly · S: Secure · SameSite").child("Flags")] : [])]
        : [col(null, "Key"), col(null, "Value")]);
    const font = mono();
    const row = (i) => {
      const x = items[i], sel = a.sel[s] === x.key, inl = a.inline?.key === x.key && a.inline.section === s;
      const valueCell = inl
        ? div().id("dta-inline").flex_1().min_w(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => cx.stop_propagation())
          .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); a.inline = null; cx.notify(); } })
          .child(Input.new(this.dtaF.inline).h(RH - 3).px(4).rounded(3).border_1().border_color(t.accent).bg(t.surface).text_size(11).font_family(font))
        : div().id(`dta-v-${i}`).flex_1().min_w(0).truncate().text_color(t.foreground).tooltip("Double-click to edit")
          .on_click((e, cx) => { if (e.click_count === 2) { cx.stop_propagation(); this.dtaInlineStart(x, cx); } })
          .child(clip((cookies ? x.value : x.v) || "", 300));
      return h_flex().id(`dta-row-${s}-${i}`).h(RH).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border)
        .text_size(11).font_family(font).bg(sel ? t.selected : t.background).cursor_default()
        .when(!sel, (el) => el.hover((st) => st.bg(t.hover)))
        .on_click((_e, cx) => this.dtaSelect(x.key, cx))
        .children(cookies
          ? [col(null, x.name, t.ansi6), valueCell, col(wide ? 120 : 96, x.domain, t.muted),
            ...(wide ? [col(54, x.path, t.muted), col(104, when(x.expires), t.muted), col(40, String(x.size), t.dim),
              col(18, x.httpOnly ? "✓" : "", t.ansi2, { center: true }), col(18, x.secure ? "✓" : "", t.ansi2, { center: true }), col(46, x.sameSite, t.muted)]
              : mid ? [col(84, when(x.expires).slice(0, 10), t.muted), col(62, flags(x), t.dim)] : [])]
          : [col(null, x.k, t.ansi6), valueCell]);
    };
    const d = a.data[s];
    const empty = !d ? (a.error[s] ?? "Loading…") : d.none ? d.none : a.filter ? "Nothing matches the filter" : cookies ? "No cookies for this page" : "No items";
    const list = v_flex().flex_1().min_w(0).min_h(0)
      .child(head)
      .child(items.length ? windowed(`dta-list-${s}`, items.length, RH, sc, row, t) : div().flex_1().p(12).text_size(12).text_color(a.error[s] ? t.blocked : t.dim).child(empty));
    return h_flex().flex_1().min_h(0).min_w(0).items_stretch().child(list).when(open, (el) => el.child(this.dtaDetail(t)));
  },

  dtaDetail(t) {
    const a = this.dta, e = a.edit, cookies = e.section === "cookies", f = this.dtaF;
    const W = this.rootW || 700;
    const flag = (id, label, on, tip, set) => textBtn(`dta-f-${id}`, label, (_e, cx) => { set(); cx.notify(); }, t, { on, tip, h: 20, px: 7, size: 11 });
    let fields;
    if (cookies) {
      const form = a.form;
      fields = v_flex().gap(7)
        .child(this.field("Name", this.input(f.name, t, { mono: true }), t))
        .child(this.field("Value", Textarea.new(f.value).px(6).py(4).rounded(5).border_1().border_color(t.input).bg(t.surface).text_size(11.5).font_family(mono()), t))
        .child(h_flex().gap(6).items_start().child(this.field("Domain", this.input(f.domain, t, { mono: true }), t, "grow")).child(this.field("Path", this.input(f.path, t, { mono: true }), t, 70)))
        .child(this.field("Expires (empty: when the browser closes)", this.input(f.expires, t, { mono: true }), t))
        .child(h_flex().gap(5).flex_wrap().items_center()
          .child(flag("http", "HttpOnly", form.httpOnly, "Hidden from the page's scripts", () => { form.httpOnly = !form.httpOnly; }))
          .child(flag("secure", "Secure", form.secure, "Sent over HTTPS only", () => { form.secure = !form.secure; }))
          .child(div().w(4))
          .children(SAME_SITE.map(([v, l]) => flag(`ss-${l}`, l, (form.sameSite ?? "") === v, `SameSite=${l}`, () => { form.sameSite = v; }))))
        .when(Boolean(e.item), (el) => el.child(div().text_size(10.5).text_color(t.dim)
          .child(`${e.item.size ?? 0} bytes · priority ${e.item.priority || "Medium"}${e.item.partitionKey ? " · partitioned" : ""}${e.item.sourceScheme ? ` · set over ${e.item.sourceScheme}` : ""}`)));
    } else {
      fields = v_flex().gap(7).flex_1().min_h(0)
        .child(this.field("Key", this.input(f.key, t, { mono: true }), t))
        .child(v_flex().gap(3).flex_1().min_h(0).child(div().text_size(10.5).text_color(t.dim).child("Value"))
          .child(Textarea.new(f.svalue).flex_1().min_h(60).px(6).py(4).rounded(5).border_1().border_color(t.input).bg(t.surface).text_size(11.5).font_family(mono())));
    }
    return v_flex().id("dta-detail").w(Math.max(230, Math.min(380, W * 0.44))).flex_none().min_h(0).border_l(1).border_color(t.border).bg(t.background)
      .child(h_flex().h(26).flex_none().pl(8).pr(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.foreground).child(e.isNew ? (cookies ? "New cookie" : "New item") : cookies ? "Cookie" : "Item"))
        .child(iconBtn("dta-detail-x", "x", "Close", (_e, cx) => { a.edit = null; a.sel[e.section] = null; cx.notify(); }, t, { size: 11 })))
      .when(Boolean(e.error), (el) => el.child(notice(t, e.error, "error")))
      .child(v_flex().id("dta-detail-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(8).child(fields))
      .child(h_flex().h(34).flex_none().px(8).gap(6).items_center().border_t(1).border_color(t.border)
        .when(!e.isNew, (el) => el.child(textBtn("dta-del", "Delete", (_e, cx) => this.dtaDelete(e.item, cx), t, { danger: true, icon: "trash" })))
        .child(div().flex_1())
        .when(!e.isNew, (el) => el.child(textBtn("dta-revert", "Revert", (_e, cx) => { this.dtaFill(e.item); e.error = null; cx.notify(); }, t)))
        .child(textBtn("dta-save", a.busy ? "Saving…" : e.isNew ? "Add" : "Save", (_e, cx) => this.dtaSave(cx), t, { primary: true, disabled: a.busy })));
  },

  dtaIdbView(t) {
    const a = this.dta, d = a.data.idb, dbs = d?.dbs ?? [];
    const rows = [];
    for (const db of dbs) {
      rows.push(h_flex().id(`dta-idb-${db.name}`).h(RH).flex_none().px(8).gap(6).items_center().text_size(11.5)
        .child(svg(I("dom-database")).size(11).text_color(t.dim)).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(db.name))
        .child(div().text_size(10.5).text_color(t.dim).child(db.error ? db.error : `v${db.version}`)));
      for (const st of db.stores) {
        const on = a.idb?.db === db.name && a.idb.store === st.name;
        rows.push(h_flex().id(`dta-idb-${db.name}-${st.name}`).h(RH).flex_none().pl(26).pr(8).gap(6).items_center().text_size(11.5).font_family(mono())
          .bg(on ? t.selected : t.background).cursor_pointer().when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => this.dtaIdbOpen(db.name, st.name, cx))
          .child(div().flex_1().min_w(0).truncate().text_color(t.ansi6).child(st.name))
          .child(div().text_size(10.5).text_color(t.dim).child(st.count == null ? "" : `${st.count.toLocaleString("en-US")}`)));
      }
    }
    const left = v_flex().id("dta-idb-list").when(Boolean(a.idb), (el) => el.w(200).flex_none()).when(!a.idb, (el) => el.flex_1()).min_h(0).overflow_y_scrollbar()
      .children(rows.length ? rows : [div().p(12).text_size(12).text_color(a.error.idb ? t.blocked : t.dim).child(a.error.idb ?? (d ? "No IndexedDB databases for this site" : "Loading…"))]);
    if (!a.idb) return h_flex().flex_1().min_h(0).items_stretch().child(left);
    const x = a.idb;
    const store = dbs.find((b) => b.name === x.db)?.stores.find((s) => s.name === x.store);
    const meta = store ? `key path: ${store.keyPath || "(none)"}${store.autoIncrement ? " · auto-increment" : ""}${store.indexes.length ? ` · indexes: ${store.indexes.map((i) => `${i.name} (${i.keyPath}${i.unique ? ", unique" : ""})`).join(", ")}` : ""}` : "";
    const sc = a.scroll.idbData ?? (a.scroll.idbData = { top: 0, viewH: 200 });
    const font = mono();
    const right = a.view
      ? this.dtaViewer(t, () => { a.view = null; })
      : v_flex().flex_1().min_w(0).min_h(0)
        .child(div().px(8).py(4).flex_none().truncate().text_size(10.5).text_color(t.dim).border_b(1).border_color(t.border).child(meta))
        .child(h_flex().h(RH).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(10.5).text_color(t.dim)
          .child(div().w(120).flex_none().child("Key")).child(div().flex_1().child("Value")))
        .child(x.entries.length
          ? windowed("dta-idb-data", x.entries.length + (x.hasMore ? 1 : 0), RH, sc, (i) => {
            if (i === x.entries.length) {
              return h_flex().id("dta-idb-more").h(RH).flex_none().px(8).items_center().text_size(11).text_color(t.accent).cursor_pointer()
                .on_click((_e, cx) => this.dtaIdbOpen(x.db, x.store, cx, x.entries.length)).child(x.loading ? "Loading…" : "Load 50 more");
            }
            const en = x.entries[i];
            return h_flex().id(`dta-idb-e-${i}`).h(RH).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).font_family(font)
              .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.dtaShow(`${x.store} · ${en.primaryKey}`, en.value, "json", cx))
              .child(div().w(120).flex_none().truncate().text_color(t.ansi6).child(en.primaryKey)).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(clip(en.value, 300)));
          }, t)
          : div().p(12).text_size(12).text_color(x.error ? t.blocked : t.dim).child(x.error ?? (x.loading ? "Loading…" : "This store is empty")));
    return h_flex().flex_1().min_h(0).items_stretch().child(left.border_r(1).border_color(t.border)).child(right);
  },

  dtaViewer(t, back) {
    const a = this.dta, v = a.view;
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(h_flex().h(24).flex_none().px(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(textBtn("dta-view-back", "‹ Back", (_e, cx) => { back(); cx.notify(); }, t, { h: 18, px: 6, size: 11 }))
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_family(mono()).text_color(t.muted).child(v.title)))
      .child(v.binary ? div().p(12).text_size(12).text_color(t.dim).child(v.binary) : Editor.new(v.state).flex_1().min_h(0));
  },

  dtaCacheView(t) {
    const a = this.dta, d = a.data.cache, c = a.cache, font = mono();
    if (!c) {
      const caches = d?.caches ?? [];
      return v_flex().flex_1().min_h(0).overflow_y_scrollbar().id("dta-caches")
        .children(caches.length ? caches.map((x, i) => h_flex().id(`dta-cache-${i}`).h(26).flex_none().px(8).gap(7).items_center().border_b(1).border_color(t.border)
          .text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.dtaCacheOpen(x, cx))
          .child(svg(I("dom-archive")).size(12).text_color(t.dim)).child(div().flex_1().min_w(0).truncate().font_family(font).text_color(t.foreground).child(x.name)))
          : [div().p(12).text_size(12).text_color(a.error.cache ? t.blocked : t.dim).child(a.error.cache ?? (d ? "No caches for this site" : "Loading…"))]);
    }
    const f = a.filter.trim().toLowerCase();
    const entries = f ? c.entries.filter((e) => e.url.toLowerCase().includes(f)) : c.entries;
    const sel = entries.find((e) => e.url === c.sel);
    const sc = a.scroll.cache ?? (a.scroll.cache = { top: 0, viewH: 200 });
    const path = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
    const narrow = Boolean(sel); // an entry is open beside the list: URL and size only
    const list = v_flex().flex_1().min_w(0).min_h(0)
      .child(h_flex().h(RH).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(10.5).text_color(t.dim)
        .child(div().flex_1().child("URL")).when(!narrow, (el) => el.child(div().w(70).flex_none().child("Type")).child(div().w(34).flex_none().child("Status")))
        .child(div().w(54).flex_none().child("Size")))
      .child(entries.length
        ? windowed("dta-cache-list", entries.length, RH, sc, (i) => {
          const e = entries[i], on = e.url === c.sel;
          return h_flex().id(`dta-ce-${i}`).h(RH).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).font_family(font)
            .bg(on ? t.selected : t.background).cursor_default().when(!on, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => this.dtaCacheSelect(e, cx)).tooltip(e.url)
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(path(e.url)))
            .when(!narrow, (el) => el.child(div().w(70).flex_none().truncate().text_color(t.muted).child((e.contentType || e.type).split(";")[0]))
              .child(div().w(34).flex_none().text_color(e.status >= 400 ? t.blocked : t.muted).child(String(e.status))))
            .child(div().w(54).flex_none().text_color(t.dim).child(bytes(e.size)));
        }, t)
        : div().p(12).text_size(12).text_color(c.error ? t.blocked : t.dim).child(c.error ?? (c.loading ? "Loading…" : "This cache is empty")));
    if (!sel) return list;
    const head = (hs) => hs.slice(0, 40).map((h) => `${h.name}: ${h.value}`).join("\n");
    const detail = v_flex().w(Math.max(240, Math.min(420, (this.rootW || 700) * 0.48))).flex_none().min_h(0).border_l(1).border_color(t.border)
      .child(h_flex().h(26).flex_none().pl(8).pr(4).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_family(font).text_color(t.foreground).child(sel.url))
        .child(textBtn("dta-ce-del", "Delete", (_e, cx) => cx.spawn(async (cx) => {
          const r = await this.dtaRun(cx, "/app/cache-delete", { cache: c.id, url: sel.url });
          if (r) { c.sel = null; a.view = null; this.dtaCacheEntries(cx); }
        }), t, { danger: true, icon: "trash", h: 20 }))
        .child(iconBtn("dta-ce-x", "x", "Close", (_e, cx) => { c.sel = null; a.view = null; cx.notify(); }, t, { size: 11 })))
      .child(v_flex().id("dta-ce-meta").max_h(90).flex_none().overflow_y_scrollbar().px(8).py(4).text_size(10.5).font_family(font).text_color(t.dim).border_b(1).border_color(t.border)
        .children(`${sel.method} · ${sel.status} ${sel.statusText} · ${sel.type}${sel.time ? ` · cached ${new Date(sel.time * 1000).toISOString().slice(0, 19).replace("T", " ")}` : ""}\n${head(sel.responseHeaders)}`
          .split("\n").map((l) => div().flex_none().truncate().child(l || " "))))
      .child(a.view ? (a.view.binary ? div().p(10).text_size(11.5).text_color(t.dim).child(a.view.binary) : Editor.new(a.view.state).flex_1().min_h(0))
        : div().p(10).text_size(11.5).text_color(t.dim).child("Loading the response…"));
    return h_flex().flex_1().min_h(0).min_w(0).items_stretch().child(list).child(detail);
  },

  dtaWorkersView(t) {
    const a = this.dta, d = a.data.workers, list = d?.workers ?? [];
    const font = mono();
    return v_flex().id("dta-workers").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(8)
      .children(list.length ? list.map((w, i) => {
        const v = w.versions[0];
        const color = v?.running === "running" ? t.ansi2 : t.dim;
        return v_flex().id(`dta-sw-${i}`).p(8).gap(4).rounded(6).border_1().border_color(t.border).bg(t.surface).text_size(11.5)
          .child(h_flex().gap(8).items_center()
            .child(div().size(7).rounded(4).bg(color))
            .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(w.scope))
            .child(textBtn(`dta-sw-un-${i}`, "Unregister", (_e, cx) => cx.spawn(async (cx) => { await this.dtaRun(cx, "/app/worker-unregister", { scope: w.scope }); }), t, { danger: true, h: 20 })))
          .children(w.versions.slice(0, 3).map((x, k) => div().text_size(11).font_family(font).text_color(k ? t.dim : t.muted).truncate()
            .child(`#${x.id} ${x.status} · ${x.running}${x.clients ? ` · ${x.clients} client${x.clients === 1 ? "" : "s"}` : ""} · ${x.script}`)));
      }) : [div().text_size(12).text_color(a.error.workers ? t.blocked : t.dim).child(a.error.workers ?? (d ? "No service workers for this site" : "Loading…"))])
      .when(Boolean(d?.errors?.length), (el) => el.children(d.errors.map((m, i) => div().id(`dta-sw-err-${i}`).text_size(11).text_color(t.blocked).child(m))));
  },

  dtaStorageView(t) {
    const a = this.dta, d = a.data.storage;
    if (!d) return div().p(12).text_size(12).text_color(a.error.storage ? t.blocked : t.dim).child(a.error.storage ?? "Loading…");
    const pct = d.quota ? Math.min(100, (d.usage / d.quota) * 100) : 0;
    const names = { indexeddb: "IndexedDB", cache_storage: "Cache Storage", service_workers: "Service workers", local_storage: "Local Storage",
      file_systems: "File systems", websql: "Web SQL", shader_cache: "Shader cache", interest_groups: "Interest groups", shared_storage: "Shared storage", storage_buckets: "Storage buckets", cookies: "Cookies" };
    return v_flex().id("dta-storage").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10).text_size(12)
      .child(div().text_color(t.foreground).child(`${bytes(d.usage)} used of ${bytes(d.quota)} (${pct < 0.01 && d.usage ? "<0.01" : pct.toFixed(2)}%)`))
      .child(div().h(6).w_full().rounded(3).bg(t.raised).child(div().h(6).rounded(3).bg(t.accent).w(Math.max(d.usage ? 2 : 0, ((this.rootW || 600) - 190) * (pct / 100)))))
      .child(v_flex().gap(3).children((d.breakdown ?? []).map((b) => h_flex().gap(8).text_size(11.5)
        .child(div().w(140).flex_none().text_color(t.muted).child(names[b.type] ?? b.type)).child(div().text_color(t.foreground).child(bytes(b.usage))))))
      .child(div().text_size(11).text_color(t.dim).child(d.overrideActive ? "A quota override is active." : "Cookies and Local Storage aren't counted in usage."))
      .child(h_flex().pt(4).child(textBtn("dta-clear-site", "Clear site data…", (_e, cx) => {
        a.confirm = { text: `Clear everything ${d.origin} keeps here: cookies, Local and Session Storage, IndexedDB, caches and service workers? You'll likely be signed out of this site.`,
          label: "Clear site data", run: (cx) => this.dtaRun(cx, "/app/clear-site", {}, () => { a.data = {}; a.sig = {}; a.sel = {}; this.toast?.("Site data cleared", null, cx, 1800); }) };
        cx.notify();
      }, t, { danger: true, icon: "trash", h: 26, px: 10 })));
  },

  dtaKey(e, cx) {
    const a = this.dta, k = String(e.key ?? "").toLowerCase();
    if (a.inline || !["cookies", "local", "session"].includes(a.section)) return;
    const items = this.dtaItems(), at = items.findIndex((x) => x.key === a.sel[a.section]);
    if (k === "delete" && at >= 0 && !a.edit?.isNew) { cx.stop_propagation(); a.confirm = { text: `Delete ${a.section === "cookies" ? `the cookie ${items[at].name}` : `"${clip(items[at].k, 60)}"`}?`, label: "Delete", run: (cx) => this.dtaDelete(items[at], cx) }; cx.notify(); }
    else if ((k === "down" || k === "up") && items.length) {
      cx.stop_propagation();
      const n = Math.max(0, Math.min(items.length - 1, at + (k === "down" ? 1 : -1)));
      this.dtaSelect(items[n].key, cx);
      const sc = a.scroll[a.section];
      if (sc && (n * RH < sc.top || (n + 1) * RH > sc.top + (sc.viewH || 200))) sc.top = Math.max(0, n * RH - (sc.viewH || 200) / 2);
    }
  },

  dtaBody(t) {
    const a = this.dta, s = a.section;
    if (a.old || this.dt?.legacy) {
      // an older helper (the drawer shows its own Restart helper above when it's older than the devtools)
      return v_flex().flex_1().min_h(0).items_center().justify_center().gap(10).p(20).text_size(12).text_color(t.muted)
        .child(div().child("This tab needs the newer browser helper."))
        .when(!this.dt?.legacy, (el) => el.child(textBtn("dta-restart", "Restart the helper", (_e, cx) => {
          a.old = false;
          if (this.restartHelper) this.restartHelper(cx); else cx.spawn(async () => { await apiPost("/detach"); });
          cx.notify();
        }, t, { primary: true, h: 26, px: 12, tip: "Restarts the panel's helper process; your pages and tabs stay open" })));
    }
    const label = SECTIONS.find((x) => x[0] === s)[1];
    let head, main;
    if (s === "cookies" || s === "local" || s === "session") {
      head = this.dtaHead(t, label, [this.dtaFilterBox(t),
        textBtn("dta-add", "Add", (_e, cx) => this.dtaAdd(cx), t, { icon: "plus", tip: s === "cookies" ? "Add a cookie" : "Add an item" }),
        textBtn("dta-clear", "Clear all", (_e, cx) => this.dtaClearAll(cx), t, { icon: "trash", danger: true, disabled: !this.dtaItems(s).length && !a.filter })]);
      main = this.dtaTable(t);
    } else if (s === "idb") { head = this.dtaHead(t, label, [div().text_size(10.5).text_color(t.dim).child("read only")]); main = this.dtaIdbView(t); }
    else if (s === "cache") {
      head = a.cache
        ? this.dtaHead(t, label, [textBtn("dta-cache-back", "‹ Caches", (_e, cx) => { a.cache = null; a.view = null; cx.notify(); }, t, { tip: a.cache.name }),
          div().flex_shrink(1).min_w(0).truncate().text_size(11).font_family(mono()).text_color(t.muted).child(clip(a.cache.name, 28)), this.dtaFilterBox(t),
          textBtn("dta-cache-del", "Delete", (_e, cx) => {
            const c = a.cache;
            a.confirm = { text: `Delete the cache "${c.name}" and its ${c.entries.length} entries?`, label: "Delete cache",
              run: (cx) => this.dtaRun(cx, "/app/cache-delete", { cache: c.id }, () => { a.cache = null; a.view = null; }) };
            cx.notify();
          }, t, { danger: true, icon: "trash" })])
        : this.dtaHead(t, label, []);
      main = this.dtaCacheView(t);
    } else if (s === "workers") { head = this.dtaHead(t, label, []); main = this.dtaWorkersView(t); }
    else { head = this.dtaHead(t, label, []); main = this.dtaStorageView(t); }
    const bar = this.dtaConfirmBar(t);
    return h_flex().id("dta-body").flex_1().min_h(0).min_w(0).items_stretch().track_focus(this.dtaFocus).on_key_down((e, cx) => this.dtaKey(e, cx))
      .child(this.dtaNav(t))
      .child(v_flex().flex_1().min_w(0).min_h(0)
        .child(head)
        .when(Boolean(bar), (el) => el.child(bar))
        .when(Boolean(a.msg), (el) => el.child(notice(t, a.msg.text, a.msg.kind, [iconBtn("dta-msg-x", "x", "Dismiss", (_e, cx) => { a.msg = null; cx.notify(); }, t, { size: 10 })])))
        .child(main));
  },

  // `browser-panel.debug:application <section>` (cookies, local, session, idb, cache, workers, storage) or refresh
  dtaCommand(arg, cx) {
    const v = String(arg ?? "").trim();
    if (SECTIONS.some((x) => x[0] === v)) this.dtaSection(v, cx);
    else if (v === "refresh") this.dtaFetch(cx, this.dta.section);
  },
};

// The drawer's registry (debug.js): a new tab after Elements.
export const ApplicationTab = {
  id: "application",
  label: "Application",
  after: "elements",
  init(dt, cx) { mixin(dt.view, App); dt.view.dtaInit(cx); },
  onShow(dt, cx) { dt.view.dtaTick(cx); },
  onHide(dt) { dt.view.dtaHide(); },
  render(t, dt) { return dt.view.dtaBody(t); },
  command(dt, arg, cx) { dt.view.dtaCommand(arg, cx); },
};
