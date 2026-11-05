// The drawer's Network tab: requests like Chrome's (name and domain, type chips, Preserve log),
// a request's Headers / Payload / Response / Timing, Copy as cURL / fetch / response, and
// Edit and resend (a Repeater). Data comes from the helper's /devtools/* routes (devtools-net.mjs).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, v_virtual_list, Scrollbar } from "gpui-base";
import { ui, ICON, kb, ms, nameOf, mergeList } from "./devtools-ui.js";

const TYPES = [["all", "All"], ["xhr", "Fetch/XHR"], ["doc", "Doc"], ["js", "JS"], ["css", "CSS"], ["img", "Img"], ["media", "Media"],
  ["font", "Font"], ["ws", "WS"], ["other", "Other"]];
const GROUP = { XHR: "xhr", Fetch: "xhr", EventSource: "xhr", Preflight: "xhr", Document: "doc", Script: "js", Stylesheet: "css",
  Image: "img", Media: "media", Font: "font", WebSocket: "ws" };
const groupOf = (type) => GROUP[type] ?? "other";
const ROW = 34; // two lines: name over domain
const SUBS = [["headers", "Headers"], ["payload", "Payload"], ["response", "Response"], ["timing", "Timing"], ["resend", "Edit and resend"]];

const bad = (e) => e.failed || e.status >= 400;
const typeLabel = (e) => ({ XHR: "xhr", Fetch: "fetch", Document: "document", Script: "script", Stylesheet: "stylesheet", Image: "image",
  Media: "media", Font: "font", WebSocket: "websocket", EventSource: "eventsource", Preflight: "preflight", Ping: "ping", Manifest: "manifest" }[e.type] ?? String(e.type || "other").toLowerCase());
function statusText(e) {
  if (e.paused) return ["(paused)", `held by Intercept at the ${e.paused} stage`];
  if (e.failed) return [e.status ? String(e.status) : e.error === "canceled" ? "(canceled)" : "(failed)", e.error];
  if (!e.done && !e.status) return ["(pending)", ""];
  if (e.type === "WebSocket") return [String(e.status || "(pending)"), e.done ? "closed" : e.status ? `open · ${e.nframes ?? 0} messages` : ""];
  return [String(e.status || "–"), e.statusText || (e.redirect ? "redirect" : "")];
}
const sizeText = (e) => (e.cache ? `(${e.cache})` : e.done || e.size ? kb(e.size) : "");
const headerLines = (pairs) => (pairs ?? []).filter(([k]) => !String(k).startsWith(":")).map(([k, v]) => `${k}: ${v}`).join("\n");
export function parseHeaders(text) {
  return String(text ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim())
    .map((l) => { const i = l.indexOf(":", l.startsWith(":") ? 1 : 0); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l.trim(), ""]; });
}

function refilter(s) {
  const f = s.filter.value().trim().toLowerCase();
  s.shown = s.list.filter((e) => (s.type === "all" || groupOf(e.type) === s.type)
    && (!f || e.url.toLowerCase().includes(f) || (e.host ?? "").toLowerCase().includes(f) || String(e.status).startsWith(f) || e.method.toLowerCase() === f));
}

function load(dt, cx) {
  const s = dt.state.network;
  if (s.busy) return;
  s.busy = true;
  cx.spawn(async (cx) => {
    try {
      if (dt.legacy) {
        const r = await dt.get(`/debug?kind=network&since=${s.lver ?? -1}`);
        if (!r.ok || r.same) return;
        s.lver = r.ver;
        mergeList(s, { reset: true, gen: "legacy", ver: r.ver, entries: (r.entries ?? []).map((e) => ({ ...e, n: e.n, legacyId: e.id, host: (() => { try { return new URL(e.url).host; } catch { return ""; } })() })) });
      } else {
        const r = await dt.get(`/devtools/net?gen=${encodeURIComponent(s.gen)}&since=${s.ver}`);
        dt.sawIntercept(r.icpt);
        if (!r.ok || r.same) return;
        const selBefore = s.sel != null ? s.byN.get(s.sel) : null;
        mergeList(s, r);
        s.preserve = Boolean(r.preserve);
        if (s.sel != null && !s.byN.has(s.sel)) { s.sel = null; s.detail = null; }
        else if (s.sel != null && s.byN.get(s.sel) !== selBefore && s.detail) refreshDetail(dt, cx);
      }
      refilter(s);
      cx.notify();
    } catch {} finally { s.busy = false; }
  });
}

function select(dt, n, cx) {
  const s = dt.state.network;
  n = Number(n);
  if (s.sel !== n) { s.body = null; s.bodyFor = null; s.detail = null; s.bodyPretty = true; }
  s.sel = n;
  refreshDetail(dt, cx);
  cx.notify();
}

function refreshDetail(dt, cx) {
  const s = dt.state.network, n = s.sel;
  if (n == null) return;
  cx.spawn(async (cx) => {
    try {
      const e = s.byN.get(n);
      const r = dt.legacy ? await dt.get(`/debug-request?id=${encodeURIComponent(e?.legacyId ?? "")}`) : await dt.get(`/devtools/request?key=${n}`);
      if (s.sel !== n) return;
      s.detail = r.ok ? (dt.legacy ? legacyDetail(r) : r) : { error: r.error ?? "This request is gone" };
      if (s.sub === "response") loadBody(dt, cx, false);
      if (s.sub === "resend") fillRepeater(dt, false);
      cx.notify();
    } catch (x) { if (s.sel === n) { s.detail = { error: String(x.message ?? x) }; cx.notify(); } }
  });
}

function legacyDetail(e) {
  const pairs = (o) => Object.entries(o ?? {});
  return { ok: true, legacy: true, e: { ...e, resolvedReqHeaders: pairs(e.reqHeaders), resolvedResHeaders: pairs(e.resHeaders) }, payload: null, timing: { phases: [], total: e.time } };
}

// The response body (Response tab, Copy response). `quiet`: only when it's cheap to have.
function loadBody(dt, cx, quiet, then) {
  const s = dt.state.network, n = s.sel;
  if (n == null || dt.legacy) return;
  const e = s.byN.get(n);
  const sig = `${n}:${e?.v}`;
  if (s.bodyFor === sig && s.body) { then?.(s.body, cx); return; }
  if (quiet) return;
  s.bodyFor = sig;
  s.body = { loading: true };
  cx.spawn(async (cx) => {
    try {
      const r = await dt.get(`/devtools/body?key=${n}`);
      if (s.sel !== n) return;
      s.body = r;
      if (r.kind === "frames") dt.code("net-body", "text", framesText(r.frames));
      else if (r.kind === "json" || r.kind === "text") dt.code("net-body", r.lang, (s.bodyPretty && r.pretty) || r.text || "");
      then?.(r, cx);
    } catch (x) { s.body = { kind: "none", note: String(x.message ?? x) }; }
    cx.notify();
  });
}

function framesText(frames) {
  const time = (ms) => { const d = new Date(ms); return isNaN(d) ? "" : `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`; };
  return (frames ?? []).map((f) => `${f.dir === "out" ? "↑" : f.dir === "in" ? "↓" : "✕"} ${time(f.at)}  ${f.data}`).join("\n") || "No messages yet";
}

function pickSub(dt, v, cx) {
  const s = dt.state.network;
  s.sub = v;
  if (v === "response") loadBody(dt, cx, false);
  if (v === "resend") fillRepeater(dt, false);
  cx.notify();
}

function fillRepeater(dt, force) {
  const s = dt.state.network, e = s.detail?.e;
  if (!e || (!force && s.rep.forN === s.sel)) return;
  s.rep.forN = s.sel;
  s.rep.result = null;
  s.rMethod.set_value(e.method ?? "GET");
  s.rUrl.set_value(e.url ?? "");
  s.rHeaders.set_value(headerLines(e.resolvedReqHeaders));
  s.rBody.set_value(e.postData ?? "");
}

function send(dt, cx) {
  const s = dt.state.network, rep = s.rep;
  if (rep.sending) return;
  rep.sending = true;
  rep.result = null;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const r = await dt.post("/devtools/send", { method: s.rMethod.value().trim() || "GET", url: s.rUrl.value().trim(), headers: parseHeaders(s.rHeaders.value()),
        body: s.rBody.value(), mode: rep.mode, cookies: rep.cookies });
      rep.result = r;
      if (r.kind === "json" || r.kind === "text") dt.code("net-rep", r.lang, r.pretty || r.text || "");
    } catch (x) { rep.result = { ok: false, error: String(x.message ?? x) }; }
    finally { rep.sending = false; cx.notify(); }
  });
}

function copyBody(dt, cx) {
  const s = dt.state.network;
  loadBody(dt, cx, false, (r, cx) => {
    if (r.kind === "json" || r.kind === "text") dt.copy(r.text ?? "", cx);
    else if (r.kind === "frames") dt.copy(framesText(r.frames), cx);
    else dt.view.toast(r.note ?? "Nothing to copy", null, cx, 2600);
  });
  if (!s.body || s.body.loading) cx.notify();
}

// ---- drawing ----

function toolbar(t, dt) {
  const s = dt.state.network, U = ui(t), W = dt.width();
  const chips = h_flex().gap(2).flex_none().children(TYPES.map(([v, label]) => U.chip(`bp-net-type-${v}`, label, s.type === v, (_e, cx) => { s.type = v; refilter(s); cx.notify(); })));
  const left = h_flex().gap(6).flex_none().items_center()
    .child(Input.new(s.filter).w(W < 620 ? 150 : 190).h(24).px(7).rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(11.5))
    .child(U.toggle("bp-net-preserve", "Preserve log", s.preserve, (_e, cx) => {
      s.preserve = !s.preserve;
      dt.post("/devtools/net/preserve", { on: s.preserve }).catch(() => {});
      cx.notify();
    }, "Keep the list when the page navigates"));
  if (W >= 900) return h_flex().h(30).px(8).gap(10).items_center().border_b(1).border_color(t.border).child(left).child(chips);
  return v_flex().px(8).py(3).gap(3).border_b(1).border_color(t.border).child(left).child(chips);
}

function row(t, dt, e, compact, mono) {
  const s = dt.state.network, sel = e.n === s.sel, red = bad(e);
  const [st, sub] = statusText(e);
  const fg = red ? t.blocked : e.paused ? t.ansi3 : t.foreground;
  const two = (a, b, w, opts = {}) => v_flex().w(w).flex_none().min_w(0).justify_center()
    .child(div().truncate().text_color(opts.c1 ?? (red ? t.blocked : t.muted)).when(Boolean(opts.right), (el) => el.text_right()).child(a || " "))
    .child(div().truncate().text_size(10.5).text_color(t.dim).when(Boolean(opts.right), (el) => el.text_right()).child(b || " "));
  return h_flex().h(ROW).px(8).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5).font_family(mono)
    .bg(sel ? t.selected : red ? `${t.blocked}14` : t.background)
    .child(two(st, compact ? "" : sub, compact ? 54 : 74, { c1: red ? t.blocked : e.paused ? t.ansi3 : !e.done && !e.status ? t.muted : t.foreground }))
    .when(!compact, (el) => el.child(two(e.method, "", 48)))
    .child(v_flex().flex_1().min_w(0).justify_center()
      .child(h_flex().gap(5).min_w(0).child(div().flex_1().min_w(0).truncate().text_color(fg).child(nameOf(e.url)))
        .when(Boolean(e.atrous), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("atrous")))
        .when(Boolean(e.edited), (el) => el.child(div().flex_none().text_size(10).text_color(t.ansi3).child("edited"))))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(e.host || e.url.split(":")[0])))
    .when(!compact, (el) => el
      .child(two(typeLabel(e), "", 76))
      .child(two(sizeText(e), "", 76, { right: true }))
      .child(two(e.time ? ms(e.time) : e.done ? "" : "", "", 60, { right: true })));
}

function list(t, dt, compact) {
  const s = dt.state.network, U = ui(t), mono = dt.mono(), rows = s.shown;
  if (!rows.length) return U.empty(s.list.length ? "Nothing matches the filter" : "No requests yet",
    s.list.length ? null : "Requests show up here as the page makes them. Reload the page to see everything it loads.");
  return v_flex().relative().flex_1().min_h(0)
    .child(v_virtual_list("bp-net-rows", rows.length, ROW, (i) => String(rows[i].n), (range) => rows.slice(range.start, range.end).map((e) => row(t, dt, e, compact, mono)))
      .size_full().on_item_click((key, cx) => select(dt, key, cx)))
    .child(Scrollbar.vertical("bp-net-rows").absolute().inset_0());
}

function footer(t, dt) {
  const s = dt.state.network;
  const bytes = s.shown.reduce((a, e) => a + (e.cache ? 0 : e.size || 0), 0);
  const failed = s.shown.filter(bad).length;
  return h_flex().h(20).px(8).gap(12).flex_none().items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
    .child(div().child(`${s.shown.length}${s.shown.length !== s.list.length ? ` / ${s.list.length}` : ""} requests`))
    .child(div().child(`${kb(bytes)} transferred`))
    .when(failed > 0, (el) => el.child(div().text_color(t.blocked).child(`${failed} failed`)))
    .when(s.preserve, (el) => el.child(div().child("log preserved")));
}

function headersView(t, dt, d) {
  const U = ui(t), e = d.e, mono = dt.mono();
  const general = [["Request URL", e.url], ["Request Method", e.method],
    ["Status Code", e.failed ? `(failed) ${e.error}` : e.status ? `${e.status}${e.statusText ? ` ${e.statusText}` : ""}` : "(pending)"]];
  if (e.remote) general.push(["Remote Address", e.remote]);
  if (e.protocol) general.push(["Protocol", e.protocol]);
  if (e.referrerPolicy) general.push(["Referrer Policy", e.referrerPolicy]);
  general.push(["Domain", e.host || ""], ["Type", `${typeLabel(e)}${e.mime ? ` · ${e.mime}` : ""}`]);
  if (e.initiator) general.push(["Initiator", `${e.initiator.type}${e.initiator.url ? ` · ${e.initiator.url}${e.initiator.line != null ? `:${e.initiator.line + 1}` : ""}` : ""}`]);
  if (e.cache) general.push(["Served from", e.cache]);
  if (e.edited) general.push(["Intercept", `edited at the ${e.edited} stage`]);
  if (e.dropped) general.push(["Intercept", "dropped"]);
  if (e.atrous) general.push(["Sent by", "the panel (Edit and resend)"]);
  const res = e.resolvedResHeaders ?? [], req = (e.resolvedReqHeaders ?? []), keyW = dt.width() >= 1000 ? 230 : 170;
  return v_flex().id("bp-net-headers").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(6).gap(2)
    .child(U.section("General")).child(U.kv(general, mono, keyW))
    .child(U.section(`Response headers (${res.length})`)).child(res.length ? U.kv(res, mono, keyW) : div().text_size(11.5).text_color(t.dim).child(e.done ? "None" : "Not received yet"))
    .child(U.section(`Request headers (${req.length})`, e.rawRequest || d.legacy ? null : "Provisional: what the page asked for; the network stack may add more (cookies)."))
    .child(U.kv(req, mono, keyW))
    .child(div().h(8));
}

function payloadView(t, dt, d) {
  const U = ui(t), p = d.payload, e = d.e, mono = dt.mono();
  if (d.legacy) return U.empty("Restart the browser helper to see request bodies", "This helper started before the devtools update.");
  const box = v_flex().id("bp-net-payload").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(6).gap(2);
  let out = box;
  if (p?.query?.length) out = out.child(U.section(`Query string parameters (${p.query.length})`)).child(U.kv(p.query, mono));
  if (p?.form) out = out.child(U.section(`Form data (${p.form.length})`, p.contentType)).child(U.kv(p.form, mono));
  if (p?.multipart) out = out.child(U.section(`Multipart parts (${p.multipart.length})`, p.contentType))
    .child(U.kv(p.multipart.map((x) => [x.filename ? `${x.name} (file ${x.filename}, ${x.type || "?"}, ${kb(x.size)})` : x.name, x.filename ? "" : x.value]), mono, 220));
  if (p?.json) out = out.child(U.section("JSON body", p.contentType)).child(div().text_size(11.5).font_family(mono).text_color(t.foreground).children(p.json.split("\n").slice(0, 800).map((l, i) => div().id(`bp-pj-${i}`).child(l || " "))));
  else if (p?.raw != null && !p.form && !p.multipart) out = out.child(U.section("Body", `${p.contentType || "no content-type"} · ${kb(p.raw.length)}`))
    .child(div().text_size(11.5).font_family(mono).text_color(t.foreground).children(p.raw.slice(0, 60000).split("\n").slice(0, 800).map((l, i) => div().id(`bp-pr-${i}`).child(l || " "))));
  if (e.postDataGone) out = out.child(div().text_size(11.5).text_color(t.dim).child("The request had a body, but the browser no longer has it."));
  if (!p?.query?.length && p?.raw == null && !e.postDataGone) out = out.child(div().pt(6).text_size(12).text_color(t.dim).child("No payload: no query string and no request body."));
  return out;
}

function responseView(t, dt, d) {
  const s = dt.state.network, U = ui(t), b = s.body;
  if (d.legacy) return U.empty("Restart the browser helper to see response bodies", "This helper started before the devtools update.");
  if (!b || b.loading) return U.empty("Loading the body…");
  if (b.kind === "none" || b.kind === "binary") return U.empty(b.note ?? "No body", b.gone ? null : b.kind === "binary" ? "Not text: Copy response and the editor are for text bodies." : null);
  const info = b.kind === "frames" ? `${(b.frames ?? []).length} messages (newest last; up to 300 kept)` : `${b.kind === "json" ? "JSON" : b.lang || "text"} · ${kb(b.size ?? 0)}${b.truncated ? " · cut for display" : ""}`;
  return v_flex().flex_1().min_h(0)
    .child(h_flex().h(24).px(8).gap(8).flex_none().items_center().text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().child(info))
      .when(b.kind === "json" && Boolean(b.pretty), (el) => el.child(U.segmented("bp-net-pretty", [["pretty", "Pretty"], ["raw", "Raw"]], s.bodyPretty ? "pretty" : "raw", (v, cx) => {
        s.bodyPretty = v === "pretty";
        dt.code("net-body", "json", s.bodyPretty ? b.pretty : b.text);
        cx.notify();
      }))))
    .child(b.size === 0 && b.kind !== "frames" ? U.empty("Empty body (0 bytes)") : (dt.codeView("net-body")?.flex_1().min_h(0) ?? U.empty("…")));
}

function timingView(t, dt, d) {
  const U = ui(t), tm = d.timing ?? { phases: [] }, e = d.e;
  if (!tm.phases.length) return U.empty(e.done ? `Total ${ms(e.time || tm.total || 0)}` : "Still loading", e.cache ? `Served from ${e.cache}: no network timing.` : "No detailed timing for this request.");
  const total = Math.max(tm.total ?? 0, ...tm.phases.map((p) => p.start + p.dur), 1);
  const barW = Math.max(80, dt.width() * (dt.state.network.sel != null && dt.width() >= 780 ? 0.62 : 1) - 170 - 90 - 30);
  const color = { Queueing: t.dim, Stalled: t.dim, "DNS lookup": t.ansi6, "Initial connection": t.ansi3, SSL: t.ansi5, "Request sent": t.ansi2,
    "Waiting for server response": t.ansi2, "Content download": t.ansi4, "Proxy negotiation": t.ansi3 };
  return v_flex().id("bp-net-timing").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(8).gap(5)
    .children(tm.phases.map((p, i) => h_flex().id(`bp-tm-${i}`).h(18).gap(8).items_center().text_size(11.5)
      .child(div().w(170).flex_none().truncate().text_color(t.muted).child(p.label))
      .child(div().w(barW).h(10).flex_none().relative()
        .child(div().absolute().top(0).left((p.start / total) * barW).w(Math.max(1.5, (p.dur / total) * barW)).h(10).rounded(2).bg(color[p.label] ?? t.accent)))
      .child(div().w(80).flex_none().text_right().text_color(t.foreground).child(ms(p.dur)))))
    .child(h_flex().h(22).mt(4).gap(8).items_center().border_t(1).border_color(t.border).text_size(11.5)
      .child(div().w(170).flex_none().font_semibold().child("Total")).child(div().w(barW).flex_none())
      .child(div().w(80).flex_none().text_right().font_semibold().child(ms(total))));
}

function resendView(t, dt, d) {
  const s = dt.state.network, U = ui(t), rep = s.rep, mono = dt.mono(), W = dt.width() * (dt.width() >= 780 ? 0.62 : 1);
  if (d.legacy) return U.empty("Restart the browser helper to edit and resend", "This helper started before the devtools update.");
  const field = (el) => el.rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(11.5).font_family(mono);
  const modeNote = rep.mode === "page"
    ? "Page: sent by this page with fetch(), so its cookies and origin apply. The browser sets Cookie, Host, Origin, Referer, Content-Length, User-Agent and Sec-* itself; another domain must allow it (CORS)."
    : "Direct: sent by the helper (Node) with exactly these headers, plus this browser's cookies for the URL unless you write a Cookie header. No CORS and no page origin; redirects aren't followed.";
  const top = h_flex().h(30).gap(6).flex_none().items_center()
    .child(field(Input.new(s.rMethod).w(70).h(24).px(6)))
    .child(field(Input.new(s.rUrl).flex_1().min_w(0).h(24).px(6)))
    .child(U.segmented("bp-rep-mode", [["page", "Page", "Send it from the page: its cookies and origin"], ["direct", "Direct", "Send it from the helper: any header, no CORS"]], rep.mode,
      (v, cx) => { rep.mode = v; cx.notify(); }))
    .child(U.button("bp-rep-send", rep.sending ? "Sending…" : "Send", (_e, cx) => send(dt, cx), { primary: true, icon: "send", disabled: rep.sending }));
  const req = v_flex().gap(4).min_w(0)
    .child(h_flex().items_center().gap(8).child(div().text_size(11.5).font_semibold().child("Headers")).child(div().text_size(10.5).text_color(t.dim).child("Name: value, one per line"))
      .child(div().flex_1()).child(U.button("bp-rep-reset", "Reset", (_e, cx) => { fillRepeater(dt, true); cx.notify(); }, { h: 20, px: 7, tip: "Back to the request as it was sent" })))
    .child(field(Textarea.new(s.rHeaders).w_full().h(118).p(6)))
    .child(div().text_size(11.5).font_semibold().child("Body"))
    .child(field(Textarea.new(s.rBody).w_full().h(84).p(6)))
    .when(rep.mode === "direct", (el) => el.child(U.toggle("bp-rep-cookies", "Add this browser's cookies for the URL", rep.cookies, (_e, cx) => { rep.cookies = !rep.cookies; cx.notify(); })));
  const r = rep.result;
  let res = v_flex().gap(4).min_w(0).flex_1();
  if (!r) res = res.child(div().text_size(11.5).text_color(t.dim).child(rep.sending ? "Waiting for the answer…" : "Send it: the answer shows here (status, headers, body). It also appears in the list."));
  else if (!r.ok) res = res.child(div().text_size(12).text_color(t.blocked).child(r.error ?? "Failed")).when(Boolean(r.note), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(r.note)));
  else {
    const good = r.status < 400;
    res = res.child(h_flex().gap(8).items_center().text_size(12)
      .child(div().px(6).h(20).flex().items_center().rounded(5).bg(good ? `${t.ansi2}22` : `${t.blocked}22`).text_color(good ? t.ansi2 : t.blocked).font_semibold().child(`${r.status} ${r.statusText ?? ""}`))
      .child(div().text_color(t.dim).text_size(11).child(`${ms(r.time ?? 0)} · ${kb(r.size ?? 0)} · ${r.mode === "direct" ? "direct" : "from the page"}`)))
      .when(Boolean(r.note), (el) => el.child(div().text_size(11).text_color(t.dim).child(r.note)))
      .child(U.section(`Response headers (${(r.headers ?? []).length})`)).child(U.kv(r.headers ?? [], mono, 140))
      .child(U.section("Body", r.kind === "binary" ? r.note : r.kind === "json" ? "JSON" : r.lang))
      .when(r.kind === "json" || r.kind === "text", (el) => el.child(r.size === 0 ? div().text_size(11.5).text_color(t.dim).child("Empty body") : (dt.codeView("net-rep")?.h(220).w_full() ?? div())));
  }
  const body = W >= 760
    ? h_flex().flex_1().min_h(0).gap(10).items_start()
      .child(v_flex().id("bp-rep-req").w(Math.round(W * 0.46)).flex_none().h_full().overflow_y_scrollbar().child(req))
      .child(v_flex().id("bp-rep-res").flex_1().min_w(0).h_full().overflow_y_scrollbar().pl(10).border_l(1).border_color(t.border).child(res))
    : v_flex().id("bp-rep-all").flex_1().min_h(0).overflow_y_scrollbar().gap(8).child(req).child(div().h(1).bg(t.border)).child(res);
  return v_flex().flex_1().min_h(0).px(8).py(4).gap(4)
    .child(top).child(div().text_size(10.5).text_color(t.dim).child(modeNote)).child(body);
}

function detailView(t, dt, narrow) {
  const s = dt.state.network, U = ui(t), d = s.detail, lite = s.byN.get(s.sel);
  const e = d?.e ?? lite;
  const close = (_e, cx) => { s.sel = null; s.detail = null; s.body = null; cx.notify(); };
  const [st] = e ? statusText(e) : [""];
  const head = h_flex().h(30).px(6).gap(6).flex_none().items_center().border_b(1).border_color(t.border).text_size(11.5)
    .when(narrow, (el) => el.child(U.icon("bp-net-back", "dt-chevron-left", "Back to the list", close)))
    .child(div().flex_none().text_color(t.muted).font_family(dt.mono()).child(e?.method ?? ""))
    .child(v_flex().flex_1().min_w(0).justify_center().child(div().truncate().text_color(t.foreground).child(e ? nameOf(e.url) : ""))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(e?.host ?? "")))
    .child(div().flex_none().text_color(e && bad(e) ? t.blocked : t.muted).child(st))
    .when(!narrow, (el) => el.child(U.icon("bp-net-close", "x", "Close", close)));
  const subs = SUBS.map(([v, l]) => [v, v === "response" && e?.type === "WebSocket" ? "Messages" : l]);
  const actions = h_flex().gap(4).flex_none().items_center()
    .child(U.button("bp-copy-curl", "cURL", (_e, cx) => d?.curl ? dt.copy(d.curl, cx) : null, { h: 20, px: 6, icon: "copy", tip: "Copy as cURL (bash)", disabled: !d?.curl }))
    .child(U.button("bp-copy-fetch", "fetch", (_e, cx) => d?.fetch ? dt.copy(d.fetch, cx) : null, { h: 20, px: 6, icon: "copy", tip: "Copy as fetch()", disabled: !d?.fetch }))
    .child(U.button("bp-copy-resp", "Response", (_e, cx) => copyBody(dt, cx), { h: 20, px: 6, icon: "copy", tip: "Copy the response body", disabled: Boolean(d?.legacy) }));
  const W = dt.width() * (narrow ? 1 : 0.62);
  const strip = W >= 640
    ? h_flex().px(6).gap(6).flex_none().items_center().border_b(1).border_color(t.border).child(U.tabs("bp-net-sub", subs, s.sub, (v, cx) => pickSub(dt, v, cx))).child(div().flex_1()).child(actions)
    : v_flex().px(6).pb(3).gap(2).flex_none().border_b(1).border_color(t.border).child(U.tabs("bp-net-sub", subs, s.sub, (v, cx) => pickSub(dt, v, cx))).child(actions);
  let content;
  if (!d) content = U.empty("Loading…");
  else if (d.error) content = U.empty(d.error);
  else if (s.sub === "headers") content = headersView(t, dt, d);
  else if (s.sub === "payload") content = payloadView(t, dt, d);
  else if (s.sub === "response") content = responseView(t, dt, d);
  else if (s.sub === "timing") content = timingView(t, dt, d);
  else content = resendView(t, dt, d);
  return v_flex().flex_1().min_w(0).min_h(0).h_full().child(head).child(strip).child(content);
}

export const NetworkTab = {
  id: "network",
  label: "Network",
  init(dt) {
    const s = dt.state.network = { list: [], byN: new Map(), gen: "", ver: -1, shown: [], type: "all", sel: null, detail: null, sub: "headers",
      body: null, bodyFor: null, bodyPretty: true, preserve: false, busy: false, rep: { mode: "page", cookies: true, result: null, sending: false, forN: null } };
    s.filter = InputState.new({ placeholder: "Filter URL or domain" });
    s.filter.on("change", (_e, cx) => { refilter(s); cx.notify(); });
    s.rMethod = InputState.new({ placeholder: "GET" });
    s.rUrl = InputState.new({ placeholder: "https://…" });
    s.rUrl.on("submit", (_e, cx) => send(dt, cx));
    s.rHeaders = TextareaState.new({ placeholder: "Name: value", rows: 6 });
    s.rBody = TextareaState.new({ placeholder: "Body (empty for none)", rows: 4 });
  },
  onShow(dt, cx) { load(dt, cx); },
  poll(dt, cx) { load(dt, cx); },
  clear(dt, cx) {
    const s = dt.state.network;
    Object.assign(s, { list: [], byN: new Map(), shown: [], sel: null, detail: null, body: null });
    dt.post(dt.legacy ? "/debug-clear" : "/devtools/net/clear", { kind: "network" }).catch(() => {});
    cx.notify();
  },
  copy(dt) {
    const s = dt.state.network;
    if (s.sel != null && s.detail?.curl) return s.detail.curl;
    return s.shown.map((e) => `${e.method} ${e.failed ? "(failed)" : e.status || "(pending)"} ${e.url}`).join("\n");
  },
  copyTip: "Copy the list (or the selected request as cURL)",
  // the filters, except while a request fills a narrow drawer
  toolbar: (t, dt) => (dt.state.network.sel != null && dt.width() < 780 ? null : toolbar(t, dt)),
  render(t, dt) {
    const s = dt.state.network, W = dt.width();
    if (s.sel == null) return v_flex().flex_1().min_h(0).child(list(t, dt, false)).child(footer(t, dt));
    if (W < 780) return detailView(t, dt, true);
    return h_flex().flex_1().min_h(0)
      .child(v_flex().w(Math.round(W * 0.38)).flex_none().min_h(0).h_full().border_r(1).border_color(t.border).child(list(t, dt, true)).child(footer(t, dt)))
      .child(detailView(t, dt, false));
  },
  // `debug:network <n>` selects request n (tests, key bindings)
  command(dt, arg, cx) {
    const [what, val] = String(arg).split(" ");
    if (what === "select" && val) select(dt, val, cx);
    else if (what === "sub" && val) pickSub(dt, val, cx);
    else if (what === "type" && val) { dt.state.network.type = val; refilter(dt.state.network); }
    else if (what === "filter") { dt.state.network.filter.set_value(String(arg).slice(7)); refilter(dt.state.network); }
    else if (what === "send") send(dt, cx);
    else if (what === "mode" && val) dt.state.network.rep.mode = val;
    else if (what === "close") { dt.state.network.sel = null; dt.state.network.detail = null; }
    else if (what === "set") {
      // set <field> <value>: Edit and resend's method, url, body, header (Name: value appended)
      const s = dt.state.network, [, field, ...v] = String(arg).split(" "), value = v.join(" ");
      if (field === "method") s.rMethod.set_value(value);
      else if (field === "url") s.rUrl.set_value(value);
      else if (field === "body") s.rBody.set_value(value);
      else if (field === "header") s.rHeaders.set_value(`${s.rHeaders.value()}
${value}`);
    }
  },
};
