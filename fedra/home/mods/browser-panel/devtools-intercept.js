// The drawer's Intercept tab (a proxy, like Burp's): with it on, requests matching a URL pattern
// (and resource types) wait in a queue; edit the method, URL, headers and body, then Forward or
// Drop. With "Responses too" they wait again with the answer: edit status, headers and body.
// Built on CDP's Fetch domain in the helper (devtools-net.mjs). Turning it off, closing the
// drawer or the panel, or the helper exiting lets every held request go on; so does a drawer
// that stops looking for 20 s (hidden panel), so pages never hang.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, v_virtual_list, Scrollbar } from "gpui-base";
import { ui, nameOf } from "./devtools-ui.js";
import { parseHeaders } from "./devtools-network.js";

const KINDS = [["Document", "Doc"], ["XHR", "XHR"], ["Fetch", "Fetch"], ["Script", "JS"], ["Stylesheet", "CSS"], ["Image", "Img"], ["Media", "Media"], ["Font", "Font"], ["Other", "Other"]];
const lines = (pairs) => (pairs ?? []).map(([k, v]) => `${k}: ${v}`).join("\n");
const host = (u) => { try { return new URL(u).host; } catch { return ""; } };

function apply(dt, cfg, cx) {
  const s = dt.state.intercept;
  s.applying = true;
  s.err = "";
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const r = await dt.post("/devtools/intercept", { pattern: s.pat.value(), types: s.types, response: s.response, scope: s.scope, ...cfg });
      take(dt, r);
    } catch (x) { s.err = String(x.message ?? x); }
    finally { s.applying = false; cx.notify(); }
  });
}

function take(dt, r) {
  const s = dt.state.intercept;
  if (!r?.ok) return;
  Object.assign(s, { on: r.on, response: r.response, scope: r.scope, types: r.types ?? s.types, n: r.n, note: r.note ?? "", ver: r.ver, tab: r.tab });
  if (r.ruleList) s.rules = r.ruleList;
  s.pattern = r.pattern;
  // a fresh drawer (panel reloaded) shows the pattern the helper is using
  if (!s.patLoaded && r.pattern !== undefined) { s.patLoaded = true; if (!s.pat.value().trim() && r.pattern !== "*") s.pat.set_value(r.pattern); }
  if (r.items) {
    s.items = r.items;
    if (s.sel && !s.items.some((x) => x.id === s.sel)) { s.sel = null; s.item = null; }
  }
  dt.sawIntercept({ on: r.on, n: r.n, rules: typeof r.rules === "number" ? r.rules : s.rules.length });
}

function load(dt, cx) {
  const s = dt.state.intercept;
  if (s.busy || dt.legacy) return;
  s.busy = true;
  cx.spawn(async (cx) => {
    try {
      take(dt, await dt.get("/devtools/intercept"));
      if (!s.sel && s.items.length) pick(dt, s.items[0].id, cx);
      cx.notify();
    } catch {} finally { s.busy = false; }
  });
}

function pick(dt, id, cx) {
  const s = dt.state.intercept;
  s.sel = id;
  s.item = null;
  s.body = null;
  cx.spawn(async (cx) => {
    try {
      const r = await dt.get(`/devtools/intercept/item?id=${encodeURIComponent(id)}`);
      if (s.sel !== id) return;
      if (!r.ok) { s.sel = null; cx.notify(); return; }
      const it = r.item;
      s.item = it;
      s.body = r.body;
      s.bodyError = r.bodyError;
      const text = it.stage === "response" ? (r.body && r.body.kind !== "binary" ? r.body.text ?? "" : "") : it.postData ?? "";
      s.orig = { method: it.method, url: it.url, headers: lines(it.stage === "response" ? it.resHeaders : it.headers), body: text,
        status: String(it.status ?? ""), statusText: it.statusText ?? "" };
      s.iMethod.set_value(s.orig.method ?? "");
      s.iUrl.set_value(s.orig.url ?? "");
      s.iStatus.set_value(s.orig.status);
      s.iStatusText.set_value(s.orig.statusText);
      s.iHeaders.set_value(s.orig.headers);
      s.iBody.set_value(text);
    } catch {}
    cx.notify();
  });
  cx.notify();
}

function next(dt, cx) {
  const s = dt.state.intercept;
  s.items = s.items.filter((x) => x.id !== s.sel);
  s.sel = null; s.item = null;
  if (s.items.length) pick(dt, s.items[0].id, cx);
}

function forward(dt, cx) {
  const s = dt.state.intercept, it = s.item;
  if (!it) return;
  const o = s.orig, edits = {};
  const hdr = s.iHeaders.value(), body = s.iBody.value();
  if (it.stage === "request") {
    if (s.iMethod.value().trim() && s.iMethod.value().trim().toUpperCase() !== o.method) edits.method = s.iMethod.value().trim();
    if (s.iUrl.value().trim() && s.iUrl.value().trim() !== o.url) edits.url = s.iUrl.value().trim();
  } else {
    if (s.iStatus.value().trim() !== o.status) edits.status = Number(s.iStatus.value().trim()) || undefined;
    if (s.iStatusText.value() !== o.statusText) edits.statusText = s.iStatusText.value();
  }
  if (hdr !== o.headers) edits.headers = parseHeaders(hdr);
  const binary = it.stage === "response" && s.body?.kind === "binary";
  if (!binary && body !== o.body) edits.body = body;
  const id = it.id, changed = Object.keys(edits).length > 0;
  cx.spawn(async (cx) => {
    try { await dt.post("/devtools/intercept/forward", changed ? { id, edits } : { id }); s.err = ""; if (s.sel === id) next(dt, cx); }
    catch (x) { s.err = `Couldn't forward it: ${String(x.message ?? x)}`; }
    cx.notify();
  });
}

function drop(dt, cx) {
  const s = dt.state.intercept, id = s.sel;
  if (!id) return;
  cx.spawn(async (cx) => {
    try { await dt.post("/devtools/intercept/drop", { id }); s.err = ""; if (s.sel === id) next(dt, cx); }
    catch (x) { s.err = `Couldn't drop it: ${String(x.message ?? x)}`; }
    cx.notify();
  });
}

function forwardAll(dt, cx) {
  const s = dt.state.intercept;
  cx.spawn(async (cx) => {
    try { await dt.post("/devtools/intercept/forward-all", {}); } catch {}
    s.items = []; s.sel = null; s.item = null;
    cx.notify();
  });
}

// ---- drawing ----

function settingsBar(t, dt) {
  const s = dt.state.intercept, U = ui(t);
  const sw = h_flex().id("bp-icpt-switch").h(24).pl(4).pr(9).gap(6).flex_none().items_center().rounded(12).border_1()
    .border_color(s.on ? t.blocked : t.input).bg(s.on ? `${t.blocked}22` : t.raised).text_size(11.5).font_semibold()
    .text_color(s.on ? t.blocked : t.foreground).cursor_pointer().hover((st) => st.opacity(0.85))
    .on_click((_e, cx) => apply(dt, { on: !s.on }, cx))
    .tooltip(s.on ? "Turn Intercept off: every held request goes on" : "Hold matching requests here until you forward or drop them")
    .child(div().size(16).rounded(8).bg(s.on ? t.blocked : t.dim).when(s.on, (el) => el.loop("opacity", { from: 0.45, to: 1, period: 1100 })))
    .child(s.applying ? "…" : s.on ? "Intercepting" : "Intercept off");
  const row1 = h_flex().h(30).gap(6).items_center()
    .child(sw)
    .child(Input.new(s.pat).flex_1().min_w(80).h(24).px(7).rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(11.5).font_family(dt.mono()))
    .child(U.toggle("bp-icpt-resp", "Responses too", s.response, (_e, cx) => { s.response = !s.response; if (s.on) apply(dt, {}, cx); else cx.notify(); },
      "Also hold the answer, to edit its status, headers and body"))
    .child(U.segmented("bp-icpt-scope", [["tab", "This tab"], ["all", "All tabs"]], s.scope, (v, cx) => { s.scope = v; if (s.on) apply(dt, { scope: v }, cx); else cx.notify(); }));
  const kinds = h_flex().gap(2).flex_wrap().items_center()
    .child(div().text_size(11).text_color(t.dim).mr(4).child("Types"))
    .child(U.chip("bp-icpt-k-any", "Any", !s.types.length, (_e, cx) => { s.types = []; if (s.on) apply(dt, {}, cx); else cx.notify(); }))
    .children(KINDS.map(([v, label]) => U.chip(`bp-icpt-k-${v}`, label, s.types.includes(v), (_e, cx) => {
      s.types = s.types.includes(v) ? s.types.filter((x) => x !== v) : [...s.types, v];
      if (s.on) apply(dt, {}, cx); else cx.notify();
    })));
  const pat = (s.on ? s.pattern : s.pat.value().trim()) || "*";
  const eff = /[*?]/.test(pat) ? pat : `*${pat}*`;
  const warn = s.on
    ? `Holding ${s.types.length ? s.types.join(", ") : "every"} request${s.response ? " and response" : ""} whose URL matches ${eff} in ${s.scope === "all" ? "every tab of this browser" : "this tab"}. Agents using this browser over CDP are held too. Off, closing this drawer or the panel lets everything go on.`
    : "URL pattern: * matches anything, ? one character; without either it means \"contains\". Pressing Enter in the pattern applies it. While on, agents' requests over CDP are held too.";
  return v_flex().px(8).py(4).gap(3).border_b(1).border_color(t.border)
    .child(row1).child(kinds)
    .child(div().text_size(10.5).text_color(s.on ? t.ansi3 : t.dim).child(warn))
    .when(Boolean(s.note), (el) => el.child(div().text_size(10.5).text_color(t.ansi3).child(s.note)))
    .when(Boolean(s.err), (el) => el.child(div().text_size(10.5).text_color(t.blocked).child(s.err)));
}

// What a rule changes, in a few words.
function setText(r) {
  const s = r.set ?? {}, h = s.headers ?? {}, parts = [];
  for (const k of Object.keys(h.set ?? {})) parts.push(`+${k}`);
  for (const k of h.remove ?? []) parts.push(`-${k}`);
  if (s.url) parts.push(`url → ${s.url}`);
  if (s.method) parts.push(`method → ${s.method}`);
  if (s.status) parts.push(`status → ${s.status}`);
  if (s.body != null) parts.push(`body (${String(s.body).length} chars)`);
  return r.action === "pause" ? "holds them here" : parts.join(", ") || "nothing";
}
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

function removeRule(dt, id, cx) {
  const s = dt.state.intercept;
  s.rules = id === "all" ? [] : s.rules.filter((r) => r.id !== id);
  cx.spawn(async (cx) => {
    try { await dt.post("/devtools/rules/remove", id === "all" ? { all: true } : { id }); } catch {}
    load(dt, cx);
  });
  cx.notify();
}

function rulesView(t, dt) {
  const s = dt.state.intercept, U = ui(t), mono = dt.mono();
  if (!s.rules.length) return null;
  return v_flex().px(8).py(4).gap(2).flex_none().border_b(1).border_color(t.border)
    .child(h_flex().h(20).gap(8).items_center()
      .child(div().text_size(11.5).font_semibold().child(`Rules (${s.rules.length})`))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child("Agents add these with bp net rule; they rewrite or hold matching traffic until they expire."))
      .child(U.button("bp-icpt-rules-all", "Remove all", (_e, cx) => removeRule(dt, "all", cx), { h: 20, px: 7, danger: true })))
    .children(s.rules.slice(0, 8).map((r) => h_flex().id(`bp-rule-${r.id}`).h(22).gap(6).items_center().text_size(11)
      .child(U.tag(r.by === "agent" ? `agent ${r.id}` : "you", r.by === "agent" ? t.ansi5 : t.dim))
      .child(div().w(62).flex_none().text_color(r.action === "pause" ? t.ansi3 : t.ansi4).child(`${r.action} ${r.stage === "response" ? "res" : "req"}`))
      .child(div().flex_1().min_w(0).truncate().font_family(mono).text_color(t.foreground)
        .child(`${r.method ? `${r.method} ` : ""}${r.pattern}${r.resourceType ? ` (${r.resourceType})` : ""}  ·  ${setText(r)}`))
      .child(div().flex_none().text_color(t.dim).child(`${r.hits} hit${r.hits === 1 ? "" : "s"}${r.left != null ? ` · ${r.left} left` : ""} · ${mmss(r.expiresIn)}`))
      .child(U.icon(`bp-rule-x-${r.id}`, "x", "Remove this rule (what it holds goes on)", (_e, cx) => removeRule(dt, r.id, cx), { size: 20, icon: 11 }))));
}

function queue(t, dt) {
  const s = dt.state.intercept, U = ui(t), items = s.items, mono = dt.mono();
  if (!items.length) return U.empty(s.on ? "Nothing held yet" : "Intercept is off", s.on ? "Matching requests wait here as the page makes them." : s.rules.length ? "Requests a pause rule holds wait here too." : "Turn it on to hold requests here before they leave the browser.");
  const row = (it) => h_flex().h(34).px(8).gap(7).items_center().border_b(1).border_color(t.border).text_size(11.5).font_family(mono)
    .bg(it.id === s.sel ? t.selected : t.background)
    .child(div().w(30).flex_none().text_size(10).font_semibold().text_color(it.stage === "response" ? t.ansi4 : t.ansi3).child(it.stage === "response" ? "RES" : "REQ"))
    .child(div().w(44).flex_none().text_color(t.muted).child(it.stage === "response" ? String(it.status) : it.method))
    .child(v_flex().flex_1().min_w(0).child(div().truncate().text_color(t.foreground).child(nameOf(it.url)))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${host(it.url)} · ${String(it.type || "").toLowerCase()}`)))
    .child(U.tag(it.by === "you" ? "you" : `agent ${it.by}`, it.by === "you" ? t.dim : t.ansi5));
  return v_flex().relative().flex_1().min_h(0)
    .child(v_virtual_list("bp-icpt-rows", items.length, 34, (i) => items[i].id, (range) => items.slice(range.start, range.end).map(row))
      .size_full().on_item_click((key, cx) => pick(dt, key, cx)))
    .child(Scrollbar.vertical("bp-icpt-rows").absolute().inset_0());
}

function editor(t, dt) {
  const s = dt.state.intercept, U = ui(t), it = s.item, mono = dt.mono();
  if (!s.items.length) return div().flex_1().h_full();
  if (!it) return U.empty("Loading…");
  const field = (el) => el.rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(11.5).font_family(mono);
  const binary = it.stage === "response" && s.body?.kind === "binary";
  const top = it.stage === "request"
    ? h_flex().h(28).gap(6).items_center().child(field(Input.new(s.iMethod).w(70).h(24).px(6))).child(field(Input.new(s.iUrl).flex_1().min_w(0).h(24).px(6)))
    : h_flex().h(28).gap(6).items_center().child(field(Input.new(s.iStatus).w(56).h(24).px(6))).child(field(Input.new(s.iStatusText).w(140).h(24).px(6)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${it.method} ${it.url}`));
  return v_flex().id("bp-icpt-edit").flex_1().min_w(0).min_h(0).h_full().overflow_y_scrollbar().px(8).py(5).gap(4)
    .child(h_flex().gap(6).items_center().text_size(11)
      .child(div().font_semibold().text_color(it.stage === "response" ? t.ansi4 : t.ansi3).child(`${it.stage === "response" ? "Response" : "Request"} held${it.by && it.by !== "you" ? ` by agent rule ${it.by}` : ""}`))
      .child(div().text_color(t.dim).child(`${String(it.type || "").toLowerCase()} · ${Math.max(0, Math.round((Date.now() - it.at) / 1000))} s · forwarded as it was unless you edit it`)))
    .child(h_flex().gap(6).items_center()
      .child(U.button("bp-icpt-fwd", "Forward", (_e, cx) => forward(dt, cx), { primary: true, icon: "dt-forward" }))
      .child(U.button("bp-icpt-drop", "Drop", (_e, cx) => drop(dt, cx), { danger: true, icon: "dt-ban", tip: "Fail this request (the page sees a network error)" }))
      .child(div().flex_1())
      .child(U.button("bp-icpt-all", `Forward all (${s.items.length})`, (_e, cx) => forwardAll(dt, cx), { tip: "Let every held request go on unchanged" })))
    .child(top)
    .child(div().text_size(11.5).font_semibold().child("Headers"))
    .child(field(Textarea.new(s.iHeaders).w_full().h(112).p(6)))
    .child(div().text_size(11.5).font_semibold().child("Body"))
    .child(binary
      ? div().text_size(11.5).text_color(t.dim).child(`${s.body.note} (sent back as it is)`)
      : field(Textarea.new(s.iBody).w_full().h(90).p(6)))
    .when(Boolean(s.bodyError), (el) => el.child(div().text_size(11).text_color(t.dim).child(`Body not readable: ${s.bodyError}`)));
}

export const InterceptTab = {
  id: "intercept",
  label: "Intercept",
  init(dt) {
    const s = dt.state.intercept = { on: false, response: false, scope: "tab", types: [], n: 0, items: [], rules: [], ver: -1, note: "", err: "", sel: null, item: null, body: null, orig: {} };
    s.pat = InputState.new({ placeholder: "URL pattern, e.g. *httpbin.org/post* or api.example.com" });
    s.pat.on("submit", (_e, cx) => apply(dt, {}, cx));
    s.iMethod = InputState.new({ placeholder: "GET" });
    s.iUrl = InputState.new({ placeholder: "https://…" });
    s.iStatus = InputState.new({ placeholder: "200" });
    s.iStatusText = InputState.new({ placeholder: "OK" });
    s.iHeaders = TextareaState.new({ placeholder: "Name: value", rows: 6 });
    s.iBody = TextareaState.new({ placeholder: "Body", rows: 4 });
  },
  onShow(dt, cx) { load(dt, cx); },
  poll(dt, cx) { load(dt, cx); },
  toolbar: settingsBar,
  render(t, dt) {
    const s = dt.state.intercept, U = ui(t);
    if (dt.legacy) return U.empty("Restart the browser helper to use Intercept", "This helper started before the devtools update.");
    const rules = rulesView(t, dt);
    const body = dt.width() >= 780
      ? h_flex().flex_1().min_h(0)
        .child(v_flex().w(Math.round(dt.width() * 0.38)).flex_none().h_full().border_r(1).border_color(t.border).child(queue(t, dt)))
        .child(editor(t, dt))
      : v_flex().flex_1().min_h(0)
        .child(v_flex().h(Math.min(4, Math.max(1, s.items.length)) * 34 + (s.items.length ? 0 : 30)).flex_none().border_b(1).border_color(t.border).child(queue(t, dt)))
        .child(editor(t, dt));
    return v_flex().flex_1().min_h(0).when(Boolean(rules), (el) => el.child(rules)).child(body);
  },
  // `debug:intercept on|off|forward|drop|pattern <p>|response|scope <tab|all>` (tests, key bindings)
  command(dt, arg, cx) {
    const s = dt.state.intercept, [what, ...rest] = String(arg).split(" "), val = rest.join(" ");
    if (what === "on" || what === "off") apply(dt, { on: what === "on" }, cx);
    else if (what === "pattern") { s.pat.set_value(val); if (s.on) apply(dt, {}, cx); }
    else if (what === "response") { s.response = val !== "off"; if (s.on) apply(dt, {}, cx); }
    else if (what === "scope") { s.scope = val === "all" ? "all" : "tab"; if (s.on) apply(dt, {}, cx); }
    else if (what === "types") { s.types = val ? val.split(",") : []; if (s.on) apply(dt, {}, cx); }
    else if (what === "forward") forward(dt, cx);
    else if (what === "drop") drop(dt, cx);
    else if (what === "set") {
      // set <field> <value>: method, url, status, body, header (Name: value appended)
      const [field, ...v] = rest, value = v.join(" ");
      if (field === "method") s.iMethod.set_value(value);
      else if (field === "url") s.iUrl.set_value(value);
      else if (field === "status") s.iStatus.set_value(value);
      else if (field === "body") s.iBody.set_value(value);
      else if (field === "header") s.iHeaders.set_value(`${s.iHeaders.value()}\n${value}`);
    }
  },
};

// Lets every held request go (drawer closed, panel unloading).
export async function releaseIntercept(dt) {
  const s = dt.state.intercept;
  if (!s?.on && !dt.view.dbg?.icpt?.on) return;
  s.on = false;
  try { await dt.post("/devtools/intercept", { on: false }); } catch {}
}
