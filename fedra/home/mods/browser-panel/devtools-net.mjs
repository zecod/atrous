// devtools-net: the helper side of the panel's devtools drawer (debug.js). Console with stacks,
// a network log with bodies, Edit and resend (Repeater) and Intercept (Proxy), per page tab.
//
// helper.mjs only wires it in (lines marked "devtools-net hook"):
//   const devnet = devtoolsNet({ current: () => S.targetId, log });
//   devnet.connect(cdp)            once the browser connection is up (adds its own event listener)
//   devnet.route(method, path, q, b)   first thing in the HTTP router: an answer, or undefined
//   devnet.release()               on helper exit: every paused request goes on, Fetch is disabled
//
// Every page tab gets a CDP session of its own here (Target.attachToTarget, flatten), separate
// from the helper's: Runtime, Log, Page and Network (with a response buffer, so bodies can be read
// back) are enabled on it, and Fetch only while the drawer's Intercept or a rule needs it. Other CDP clients (agents with
// Playwright, the helper itself) are untouched: their sessions keep their own domains, and Chrome
// chains Fetch interception across sessions, so an agent's own route() still runs. When this
// session goes away (helper killed), Chrome lets the requests it held go on.
//
// Drawer API (127.0.0.1:<api port>, JSON, under /devtools/; the drawer's own, may change):
//   GET  hello                          -> {ok, v}  (an older helper answers 404/405: the drawer says so)
//   GET  console?gen=&since=, net?gen=&since=   incremental lists of the shown tab (see list())
//   GET  request?key=, body?key=        one request in full / its response body, by the drawer's row key
//   POST console/clear, net/clear, net/preserve {on}, send {method, url, headers, body, mode}
//   GET  intercept[?summary=1][&passive=1], intercept/item?id=
//   POST intercept {on, pattern, types, response, scope}, intercept/forward {id, edits?},
//        intercept/drop {id}, intercept/forward-all, rules {...} (a rule by "you"), rules/remove {id | all} (any rule)
//
// Agents' network API (under /net/; the herdr-browser skill's `bp net` uses it). The same log and
// the same Fetch engine as the drawer, so the person sees agents' rules and holds there.
//   GET  /net/requests?type=&q=&domain=&status=&method=&since=<seq>&limit=50&tab=all|current|<id>
//        -> {last, current, count, requests: [{id, seq, tab, method, url, domain, status, type, mime, size,
//           time, pending, failed, error, cache, edited, paused}]}   (newest `limit`, oldest first)
//        type: xhr fetch api doc js css img media font ws other; status: 404, 4xx, error, failed, pending
//        id is the request's seq: one number across tabs, growing; `since` lists only newer ones
//   GET  /net/request?id=&body=1&response=1&max=100000
//        -> the request with requestHeaders, responseHeaders, timing; postData (body=1);
//           response (response=1): {text, size} or {base64: true, data, size, truncated} or {none, note}
//   POST /net/replay {id?, method?, url?, headers?: {k: v}, removeHeaders?: [k], body?, mode?: "page"|"direct", max?}
//        an edited copy of request id (or a new one), sent from that tab's page (cookies, origin) or,
//        mode "direct", from the helper -> {status, statusText, headers, body, size, time, note}
//   POST /net/wait {pattern, method?, status?, since?, timeoutMs?: 30000}   long poll: the first request
//        matching pattern that finishes from now on (or after `since`, or one in flight now) -> {request};
//        408 on timeout
//   POST /net/rules {pattern, method?, resourceType?, stage?: "request"|"response", action?: "modify"|"pause",
//        set?: {url?, method?, headers?: {set: {k: v}, remove: [k]}, body?, status?, statusText?},
//        times?, ttlSec?: 600, tab?: "current"|<id>}   -> {id}. modify: applied with no human step;
//        pause: held in the queue the drawer shows (the person can forward them too). Rules expire
//        (default 10 min, or after `times` matches); a pause rule's holds go on when it goes, and
//        after 60 s with nobody (agent or person) looking at the queue.
//   GET  /net/rules -> {rules: [{id, by: "agent"|"you", pattern, stage, action, set, left, hits, expiresIn}], intercept}
//   POST /net/rules/remove {id | all: true}   all = the agents' rules; the person's only from the drawer
//   GET  /net/paused?max= -> {paused: [{id, stage, by, method, url, headers, postData | status, body, age}]}
//   POST /net/paused/continue {id, method?, url?, headers?: {k: v} (all of them) | {set, remove}, body?, status?, statusText?}
//   POST /net/paused/drop {id}           the page sees a network error
// Patterns: with a *, CDP wildcards (* any, ? one character); without, "the URL contains this" (literally).
// Pages never hang: the drawer's Intercept off, the drawer or panel closing, a pause rule going
// away, nobody looking, and the helper exiting all let every held request go on.

import { STATUS_CODES } from "node:http";

const MAX_NET = 1000, MAX_CONSOLE = 1000, MAX_FRAMES = 300;
const NET_BUFFER = { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000, maxPostDataSize: 65536 };
const SHOW_MAX = 1_000_000; // characters of a body sent to the drawer
const WATCHDOG_MS = 20000; // Intercept turns itself off when nobody looked at the queue this long
const WORLD = "herdr-devtools";
const OUR_SOURCE = /^herdr|__herdr|herdr-devtools/i; // frames of code the panel injects (sourceURL herdr://...)
// What a page's fetch() can't set: the browser writes these itself.
const FORBIDDEN = new Set(["accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method",
  "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer",
  "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "via", "user-agent"]);
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "expect", "te", "trailer"]);
const internal = (url) => /^(devtools|chrome-extension|edge-extension|edge|chrome):/i.test(url ?? "");
const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
const err = (status, message) => Object.assign(new Error(message), { status });

// CDP headers ({name: "a\nb"}) as [[name, value]] pairs, one per line.
export function pairs(h) {
  if (Array.isArray(h)) return h.map((x) => (Array.isArray(x) ? [String(x[0]), String(x[1])] : [String(x.name), String(x.value)]));
  const out = [];
  for (const [k, v] of Object.entries(h ?? {})) for (const line of String(v).split("\n")) out.push([k, line]);
  return out;
}
const headerOf = (h, name) => pairs(h).find(([k]) => k.toLowerCase() === name)?.[1] ?? "";
const textual = (mime) => /^text\/|json|javascript|ecmascript|xml|html|css|svg|x-www-form-urlencoded|graphql|csv|yaml|plain/i.test(mime ?? "");
export function langOf(mime, url) {
  const m = String(mime ?? "").toLowerCase(), p = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ""; } })();
  if (/json/.test(m) || p.endsWith(".json")) return "json";
  if (/html/.test(m)) return "html";
  if (/svg|xml/.test(m)) return "xml";
  if (/css/.test(m) || p.endsWith(".css")) return "css";
  if (/javascript|ecmascript/.test(m) || /\.m?js$/.test(p)) return "javascript";
  return "text";
}
export function prettyJson(text) {
  if (!text || text.length > 5_000_000) return null;
  const s = text.trim();
  if (!/^[[{"]/.test(s) && !/^(true|false|null|-?\d)/.test(s)) return null;
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return null; }
}
const b64 = (s) => Buffer.from(String(s ?? ""), "utf8").toString("base64");

// The request body as people read it: query string, form fields, JSON, multipart parts.
export function payloadOf(e) {
  const out = { query: [], form: null, json: null, multipart: null, raw: e.postData ?? null, contentType: headerOf(e.reqHeaders, "content-type") };
  try { out.query = [...new URL(e.url).searchParams]; } catch {}
  const raw = e.postData;
  if (raw == null) return out;
  const ct = out.contentType.toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) { try { out.form = [...new URLSearchParams(raw)]; } catch {} }
  else if (ct.includes("multipart/form-data")) {
    const boundary = /boundary="?([^";]+)"?/i.exec(out.contentType)?.[1];
    if (boundary) {
      out.multipart = raw.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--")).map((part) => {
        const cut = part.indexOf("\r\n\r\n") >= 0 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
        const head = cut >= 0 ? part.slice(0, cut) : part, body = cut >= 0 ? part.slice(cut).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "") : "";
        const disp = /content-disposition:[^\n]*/i.exec(head)?.[0] ?? "";
        return { name: /\bname="([^"]*)"/i.exec(disp)?.[1] ?? "", filename: /filename="([^"]*)"/i.exec(disp)?.[1] ?? null,
          type: /content-type:\s*([^\r\n]*)/i.exec(head)?.[1] ?? "", value: body.length > 4000 ? `${body.slice(0, 4000)}…` : body, size: body.length };
      });
    }
  }
  if (!out.form && !out.multipart) out.json = prettyJson(raw);
  return out;
}

// Chrome's timing (ms after requestTime) as DevTools' phases, in ms after the request started.
export function phasesOf(e) {
  const t = e.timing, total = e.end && e.start ? (e.end - e.start) * 1000 : null;
  if (!t || !e.start) return { phases: [], total };
  const base = (t.requestTime - e.start) * 1000, out = [];
  const add = (label, a, b) => { if (a >= 0 && b > a) out.push({ label, start: +a.toFixed(2), dur: +(b - a).toFixed(2) }); };
  const first = [t.proxyStart, t.dnsStart, t.connectStart, t.sendStart].find((x) => x >= 0) ?? 0;
  add("Queueing", 0, base);
  add("Stalled", base, base + first);
  if (t.proxyStart >= 0) add("Proxy negotiation", base + t.proxyStart, base + t.proxyEnd);
  if (t.dnsStart >= 0) add("DNS lookup", base + t.dnsStart, base + t.dnsEnd);
  if (t.connectStart >= 0) add("Initial connection", base + t.connectStart, base + (t.sslStart >= 0 ? t.sslStart : t.connectEnd));
  if (t.sslStart >= 0) add("SSL", base + t.sslStart, base + t.sslEnd);
  add("Request sent", base + t.sendStart, base + Math.max(t.sendEnd, t.sendStart + 0.01));
  const headers = t.receiveHeadersStart > 0 ? t.receiveHeadersStart : t.receiveHeadersEnd;
  add("Waiting for server response", base + t.sendEnd, base + headers);
  if (total != null) add("Content download", base + t.receiveHeadersEnd, total);
  return { phases: out, total: total != null ? +total.toFixed(2) : null };
}

// bash quoting; ANSI-C ($'...') when the text has control characters (a multipart body's CRLFs)
const shq = (s) => {
  s = String(s);
  if (!/[\x00-\x1f\x7f]/.test(s)) return `'${s.replace(/'/g, "'\\''")}'`;
  return `$'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")
    .replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}'`;
};
// Copy as cURL (bash) and Copy as fetch, from the headers the browser really sent when known.
export function curlOf(e) {
  const all = pairs(e.reqHeadersRaw ?? e.reqHeaders);
  const h = all.filter(([k]) => !k.startsWith(":") && !/^(host|content-length|connection|accept-encoding)$/i.test(k));
  const parts = [`curl ${shq(e.url)}`];
  const data = e.postData != null && e.postData !== "";
  if (!(e.method === "GET" && !data) && !(e.method === "POST" && data)) parts.push(`-X ${e.method}`);
  for (const [k, v] of h) parts.push(`-H ${shq(`${k}: ${v}`)}`);
  if (data) parts.push(`--data-raw ${shq(e.postData)}`);
  if (/br|gzip|deflate|zstd/.test(headerOf(all, "accept-encoding"))) parts.push("--compressed");
  return parts.join(" \\\n  ");
}
export function fetchOf(e) {
  const skip = new Set(["cookie", "host", "connection", "content-length", "user-agent", "accept-encoding", "origin", "referer"]);
  const h = pairs(e.reqHeadersRaw ?? e.reqHeaders).filter(([k]) => !k.startsWith(":") && !skip.has(k.toLowerCase()) && !k.toLowerCase().startsWith("sec-"));
  const init = { headers: Object.fromEntries(h) };
  const ref = headerOf(e.reqHeadersRaw ?? e.reqHeaders, "referer");
  if (ref) init.referrer = ref;
  if (e.postData != null && e.postData !== "") init.body = e.postData;
  init.method = e.method;
  init.mode = "cors";
  init.credentials = "include";
  return `fetch(${JSON.stringify(e.url)}, ${JSON.stringify(init, null, 2)});`;
}

export function devtoolsNet({ current = () => null, log = () => {} } = {}) {
  let cdp = null;
  let VER = 1; // every change to any list gets the next number
  let SEQ = 0; // every request, in every tab, gets the next number: its id for agents (/net/*)
  const bySeq = new Map(); // seq -> { t, e }
  let preserve = false;
  const tabs = new Map(); // targetId -> tab (see tabOf)
  const bySession = new Map(); // our sessionId -> targetId
  const I = { on: false, pattern: "*", types: [], response: false, scope: "tab", tab: null, ver: 1, paused: new Map(), lastPoll: 0,
    note: "", busy: Promise.resolve() };
  const send = (method, params = {}, session, ms = 15000) => {
    if (!cdp || cdp.closed) return Promise.reject(err(503, "The browser isn't connected"));
    return cdp.send(method, params, session, ms);
  };

  function tabOf(id) {
    let t = tabs.get(id);
    if (!t) {
      t = { id, session: null, attaching: null, gen: 1, net: [], byRid: new Map(), nseq: 0, nver: 0, cgen: 1, console: [], cseq: 0, cver: 0,
        herdrCtx: new Set(), pendingExtra: new Map(), fetchOn: false, url: "" };
      tabs.set(id, t);
    }
    return t;
  }

  async function attach(id) {
    const t = tabOf(id);
    if (t.session) return t;
    if (t.attaching) return t.attaching;
    t.attaching = (async () => {
      const { sessionId } = await send("Target.attachToTarget", { targetId: id, flatten: true }, undefined, 8000);
      t.session = sessionId;
      bySession.set(sessionId, id);
      await Promise.all([
        send("Network.enable", NET_BUFFER, sessionId).catch((e) => log("devtools network", e.message)),
        send("Runtime.enable", {}, sessionId).catch(() => {}),
        send("Log.enable", {}, sessionId).catch(() => {}),
        send("Page.enable", {}, sessionId).catch(() => {}),
      ]);
      await syncTab(t).catch((e) => log("devtools fetch", e.message));
      return t;
    })();
    try { return await t.attaching; } catch (e) { tabs.delete(id); throw e; } finally { if (tabs.get(id) === t) t.attaching = null; }
  }

  async function shown() {
    const id = current();
    if (!id) return null;
    try { return await attach(id); } catch (e) { log("devtools attach", e.message); return null; }
  }

  function connect(c) {
    cdp = c;
    c.listeners.push(onEvent);
    send("Target.getTargets").then(({ targetInfos }) => {
      for (const ti of targetInfos) if (ti.type === "page" && !internal(ti.url)) attach(ti.targetId).catch(() => {});
    }).catch(() => {});
    if (!connect.timer) {
      connect.timer = setInterval(tick, 2000);
      connect.timer.unref?.();
    }
  }

  // ---- events --------------------------------------------------------------------------------

  const touch = (t, e) => { e.v = ++VER; t.nver = VER; };
  function netEntry(t, p) {
    const req = p.request ?? {};
    const e = { n: ++t.nseq, seq: ++SEQ, rid: p.requestId, method: req.method ?? "GET", url: req.url ?? "", host: hostOf(req.url), type: p.type ?? "Other",
      start: p.timestamp, wall: p.wallTime, status: 0, statusText: "", mime: "", size: 0, time: 0, done: false, failed: false, error: "",
      cache: "", reqHeaders: req.headers ?? {}, resHeaders: {}, postData: req.postData, hasPostData: Boolean(req.hasPostData),
      initiator: p.initiator ? { type: p.initiator.type, url: p.initiator.url ?? p.initiator.stack?.callFrames?.[0]?.url ?? "",
        line: p.initiator.lineNumber ?? p.initiator.stack?.callFrames?.[0]?.lineNumber } : null,
      herdr: Boolean(p.initiator?.stack?.callFrames?.some((f) => OUR_SOURCE.test(f.url ?? ""))),
      priority: req.initialPriority ?? "", referrerPolicy: req.referrerPolicy ?? "", frameId: p.frameId };
    if (e.postData === undefined && req.postDataEntries?.length) {
      try { e.postData = req.postDataEntries.map((x) => Buffer.from(x.bytes ?? "", "base64").toString("utf8")).join(""); } catch {}
    }
    return e;
  }
  function pushNet(t, e) {
    t.net.push(e);
    t.byRid.set(e.rid, e);
    bySeq.set(e.seq, { t, e });
    const extra = t.pendingExtra.get(e.rid);
    if (extra) { t.pendingExtra.delete(e.rid); if (extra.req) e.reqHeadersRaw = extra.req; if (extra.res) e.resHeadersRaw = extra.res; }
    while (t.net.length > MAX_NET) { const old = t.net.shift(); bySeq.delete(old.seq); if (t.byRid.get(old.rid) === old) t.byRid.delete(old.rid); }
    touch(t, e);
  }
  function clearNet(t) { for (const e of t.net) bySeq.delete(e.seq); t.net = []; t.byRid.clear(); t.gen++; t.nver = ++VER; }
  function pushConsole(t, c) {
    c.n = ++t.cseq;
    c.t = c.t ?? Date.now();
    if (c.text.length > 50000) c.text = `${c.text.slice(0, 50000)}…`;
    c.v = ++VER;
    t.cver = VER;
    t.console.push(c);
    while (t.console.length > MAX_CONSOLE) t.console.shift();
  }
  const frames = (st) => (st?.callFrames ?? []).slice(0, 40).map((f) => ({ fn: f.functionName || "", url: f.url || "", line: (f.lineNumber ?? 0) + 1, col: (f.columnNumber ?? 0) + 1 }));
  const ours = (t, ctxId, stack) => (ctxId != null && t.herdrCtx.has(ctxId)) || stack.some((f) => OUR_SOURCE.test(f.url) || /__herdr/.test(f.fn));
  const where = (url, line, col) => (url ? `${url}${line ? `:${line}${col ? `:${col}` : ""}` : ""}` : "");

  function onEvent(method, p, session) {
    if (!session) {
      if (method === "Target.targetCreated" && p.targetInfo?.type === "page" && !internal(p.targetInfo.url)) {
        attach(p.targetInfo.targetId).catch(() => {});
      } else if (method === "Target.targetDestroyed") {
        const t = tabs.get(p.targetId);
        if (t) { tabs.delete(p.targetId); bySession.delete(t.session); dropPaused(p.targetId); }
      } else if (method === "Target.detachedFromTarget" && bySession.has(p.sessionId)) {
        const t = tabs.get(bySession.get(p.sessionId));
        bySession.delete(p.sessionId);
        if (t) { t.session = null; t.fetchOn = false; dropPaused(t.id); }
      }
      return;
    }
    const id = bySession.get(session);
    if (!id) return; // another session's event (the helper's): not ours
    const t = tabs.get(id);
    if (!t) return;
    switch (method) {
      case "Network.requestWillBeSent": {
        if (p.type === "Document" && p.frameId === t.id && !p.redirectResponse && !preserve) clearNet(t);
        const prev = t.byRid.get(p.requestId);
        if (prev && p.redirectResponse) {
          const r = p.redirectResponse;
          Object.assign(prev, { status: r.status, statusText: r.statusText ?? "", resHeaders: r.headers ?? {}, mime: r.mimeType ?? "", done: true,
            redirect: true, end: p.timestamp, time: Math.round((p.timestamp - prev.start) * 1000), protocol: r.protocol ?? "",
            remote: r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : "", timing: r.timing ?? prev.timing,
            size: r.encodedDataLength ?? prev.size });
          prev.rid = `${p.requestId}~${prev.n}`; // the next hop takes the request id
          touch(t, prev);
          finished(t, prev);
        }
        pushNet(t, netEntry(t, p));
        break;
      }
      case "Network.requestWillBeSentExtraInfo": {
        const e = t.byRid.get(p.requestId);
        if (e && !e.reqHeadersRaw) { e.reqHeadersRaw = p.headers; e.cookies = (p.associatedCookies ?? []).length; touch(t, e); }
        else { const x = t.pendingExtra.get(p.requestId) ?? {}; x.req = p.headers; t.pendingExtra.set(p.requestId, x); trimPending(t); }
        break;
      }
      case "Network.responseReceivedExtraInfo": {
        const e = t.byRid.get(p.requestId);
        if (e) { e.resHeadersRaw = p.headers; touch(t, e); }
        else { const x = t.pendingExtra.get(p.requestId) ?? {}; x.res = p.headers; t.pendingExtra.set(p.requestId, x); trimPending(t); }
        break;
      }
      case "Network.responseReceived": {
        const e = t.byRid.get(p.requestId), r = p.response ?? {};
        if (!e) break;
        Object.assign(e, { status: r.status ?? 0, statusText: r.statusText ?? "", mime: r.mimeType ?? "", resHeaders: r.headers ?? {},
          type: p.type ?? e.type, protocol: r.protocol ?? "", remote: r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : "",
          timing: r.timing, resAt: p.timestamp, security: r.securityState ?? "" });
        if (r.fromDiskCache) e.cache = "disk";
        if (r.fromServiceWorker) e.cache = "service worker";
        if (r.fromPrefetchCache) e.cache = "prefetch cache";
        if (r.requestHeaders && !e.reqHeadersRaw) e.reqHeadersRaw = r.requestHeaders;
        touch(t, e);
        break;
      }
      case "Network.requestServedFromCache": {
        const e = t.byRid.get(p.requestId);
        if (e) { e.cache = "memory"; touch(t, e); }
        break;
      }
      case "Network.dataReceived": {
        const e = t.byRid.get(p.requestId);
        if (e && !e.done) { e.size += p.encodedDataLength || 0; e.v = ++VER; t.nver = VER; }
        break;
      }
      case "Network.loadingFinished": {
        const e = t.byRid.get(p.requestId);
        if (e) { Object.assign(e, { size: p.encodedDataLength ?? e.size, end: p.timestamp, time: Math.round((p.timestamp - e.start) * 1000), done: true }); touch(t, e); finished(t, e); }
        break;
      }
      case "Network.loadingFailed": {
        const e = t.byRid.get(p.requestId);
        if (!e) break;
        const why = p.canceled ? "canceled" : p.blockedReason ? `blocked:${p.blockedReason}` : p.corsErrorStatus ? `CORS error: ${p.corsErrorStatus.corsError}` : p.errorText ?? "failed";
        Object.assign(e, { failed: true, error: e.dropped ? "dropped by Intercept" : why, end: p.timestamp, time: Math.round((p.timestamp - e.start) * 1000), done: true });
        touch(t, e);
        finished(t, e);
        break;
      }
      case "Network.webSocketCreated": {
        if (t.byRid.get(p.requestId)) break;
        const e = netEntry(t, { requestId: p.requestId, request: { url: p.url, method: "GET" }, type: "WebSocket", timestamp: 0, initiator: p.initiator });
        e.frames = []; e.start = null;
        pushNet(t, e);
        break;
      }
      case "Network.webSocketWillSendHandshakeRequest": {
        const e = t.byRid.get(p.requestId);
        if (e) { e.start = p.timestamp; e.wall = p.wallTime; e.reqHeaders = p.request?.headers ?? {}; touch(t, e); }
        break;
      }
      case "Network.webSocketHandshakeResponseReceived": {
        const e = t.byRid.get(p.requestId), r = p.response ?? {};
        if (e) { Object.assign(e, { status: r.status ?? 101, statusText: r.statusText ?? "", resHeaders: r.headers ?? {}, resAt: p.timestamp }); if (r.requestHeaders) e.reqHeadersRaw = r.requestHeaders; touch(t, e); }
        break;
      }
      case "Network.webSocketFrameSent":
      case "Network.webSocketFrameReceived": {
        const e = t.byRid.get(p.requestId), r = p.response ?? {};
        if (!e?.frames) break;
        const data = String(r.payloadData ?? "");
        const at = e.wall && e.start ? Math.round((e.wall + (p.timestamp - e.start)) * 1000) : Date.now(); // wall clock, ms
        e.frames.push({ dir: method.endsWith("Sent") ? "out" : "in", at, op: r.opcode, len: data.length, data: data.length > 4000 ? `${data.slice(0, 4000)}…` : data });
        if (e.frames.length > MAX_FRAMES) e.frames.shift();
        e.size += data.length;
        e.nframes = (e.nframes ?? 0) + 1;
        touch(t, e);
        break;
      }
      case "Network.webSocketFrameError": {
        const e = t.byRid.get(p.requestId);
        if (e?.frames) { e.frames.push({ dir: "err", at: Date.now(), data: p.errorMessage ?? "error" }); touch(t, e); }
        break;
      }
      case "Network.webSocketClosed": {
        const e = t.byRid.get(p.requestId);
        if (e) { e.done = true; e.end = p.timestamp; e.time = e.start ? Math.round((p.timestamp - e.start) * 1000) : 0; touch(t, e); finished(t, e); }
        break;
      }
      case "Runtime.executionContextCreated": {
        const c = p.context ?? {};
        if (c.auxData && c.auxData.isDefault === false && /^herdr/i.test(c.name ?? "")) t.herdrCtx.add(c.id);
        break;
      }
      case "Runtime.executionContextDestroyed": t.herdrCtx.delete(p.executionContextId); break;
      case "Runtime.executionContextsCleared": t.herdrCtx.clear(); break;
      case "Runtime.consoleAPICalled": {
        const level = { warning: "warn", error: "error", assert: "error", debug: "debug", info: "info", trace: "log" }[p.type] ?? "log";
        const stack = frames(p.stackTrace), top = stack[0];
        const text = p.type === "clear" ? "console.clear()" : (p.args ?? []).map(remoteText).join(" ");
        pushConsole(t, { level, text, url: top?.url ?? "", line: top?.line ?? 0, col: top?.col ?? 0, source: top ? short(top.url, top.line) : "",
          stack: p.type === "trace" || level === "error" || level === "warn" ? stack : stack.slice(0, 1), herdr: ours(t, p.executionContextId, stack),
          t: p.timestamp ? Math.round(p.timestamp) : Date.now() });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {}, stack = frames(d.stackTrace);
        const url = d.url ?? stack[0]?.url ?? "";
        const line = d.lineNumber !== undefined ? d.lineNumber + 1 : stack[0]?.line ?? 0, col = d.columnNumber !== undefined ? d.columnNumber + 1 : stack[0]?.col ?? 0;
        const what = d.exception?.description ?? d.exception?.value ?? "";
        pushConsole(t, { level: "error", text: what ? `${d.text || "Uncaught"} ${what}` : d.text ?? "Uncaught exception", url, line, col, source: url ? short(url, line) : "",
          stack, herdr: ours(t, d.executionContextId, stack) });
        break;
      }
      case "Log.entryAdded": {
        const e = p.entry ?? {}, stack = frames(e.stackTrace);
        const level = e.level === "warning" ? "warn" : e.level === "verbose" ? "debug" : e.level ?? "log";
        const line = e.lineNumber !== undefined ? e.lineNumber + 1 : stack[0]?.line ?? 0;
        pushConsole(t, { level, text: e.text ?? "", url: e.url ?? stack[0]?.url ?? "", line, col: 0, source: e.url ? short(e.url, line) : e.source ?? "",
          kind: e.source ?? "", stack, herdr: ours(t, null, stack), t: e.timestamp ? Math.round(e.timestamp) : Date.now() });
        break;
      }
      case "Page.frameNavigated":
        if (!p.frame?.parentId) { t.url = p.frame.url; pushConsole(t, { level: "nav", text: `Navigated to ${p.frame.url}`, url: "", line: 0, col: 0, source: "", stack: [], herdr: false }); }
        break;
      case "Fetch.requestPaused": onPaused(t, p); break;
    }
  }
  function trimPending(t) { while (t.pendingExtra.size > 200) t.pendingExtra.delete(t.pendingExtra.keys().next().value); }
  const short = (u, line) => { try { const x = new URL(u); return `${x.pathname.split("/").pop() || x.host}${line ? `:${line}` : ""}`; } catch { return u ? `${u}${line ? `:${line}` : ""}` : ""; } };

  // ---- lists ---------------------------------------------------------------------------------
  // Incremental: the drawer sends the gen and the newest version it has; it gets the rows changed
  // since (or all of them, reset, when the gen moved: a clear, a new document, another tab).
  function list(t, kind, q) {
    const items = kind === "net" ? t.net : t.console, gen = `${t.id}:${kind === "net" ? t.gen : t.cgen}`;
    const since = Number(q.get("since") ?? -1), ver = kind === "net" ? t.nver : t.cver;
    const first = items[0]?.n ?? 0;
    const head = { ok: true, target: t.id, gen, ver, first, preserve, icpt: { on: I.on, n: I.paused.size, rules: RULES.size } };
    if (q.get("gen") !== gen || since < 0) return { ...head, reset: true, entries: items.map(kind === "net" ? lite : (c) => c) };
    if (since >= ver) return { ...head, same: true };
    return { ...head, reset: false, entries: items.filter((x) => x.v > since).map(kind === "net" ? lite : (c) => c) };
  }
  const lite = (e) => ({ n: e.n, v: e.v, method: e.method, url: e.url, host: e.host, type: e.type, status: e.status, statusText: e.statusText,
    mime: e.mime, size: e.size, time: e.time, done: e.done, failed: e.failed, error: e.error, cache: e.cache, herdr: e.herdr || undefined,
    edited: e.edited, nframes: e.nframes, redirect: e.redirect || undefined, paused: e.paused || undefined });

  const byKey = (t, key) => t.net.find((x) => String(x.n) === String(key)) ?? null;

  async function detail(t, key) {
    const e = byKey(t, key);
    if (!e) throw err(404, "That request is no longer in the log");
    if (e.hasPostData && e.postData === undefined && !e.redirect) {
      try { e.postData = (await send("Network.getRequestPostData", { requestId: e.rid }, t.session, 5000)).postData; }
      catch { e.postData = null; e.postDataGone = true; }
    }
    const { frames: _f, ...full } = e;
    return { ok: true, e: { ...full, rawRequest: Boolean(e.reqHeadersRaw), resolvedReqHeaders: pairs(e.reqHeadersRaw ?? e.reqHeaders),
      resolvedResHeaders: pairs(e.resHeadersRaw ?? e.resHeaders) }, frames: e.frames ?? null, payload: payloadOf(e), timing: phasesOf(e),
      curl: curlOf(e), fetch: fetchOf(e) };
  }

  async function body(t, key, raw = false) {
    const e = byKey(t, key);
    if (!e) throw err(404, "That request is no longer in the log");
    if (e.type === "WebSocket") return { ok: true, kind: "frames", frames: e.frames ?? [] };
    if (e.redirect) return { ok: true, kind: "none", note: `A redirect (${e.status}): no body. The next request in the list is where it went.` };
    if (!e.done) return { ok: true, kind: "none", note: "Still loading: the body is there once the response has finished." };
    if (e.failed) return { ok: true, kind: "none", note: `No response: the request failed (${e.error}).` };
    if (e.status === 204 || e.status === 205 || (e.status >= 100 && e.status < 200)) return { ok: true, kind: "none", note: `This response has no body (${e.status}).` };
    let r;
    try { r = await send("Network.getResponseBody", { requestId: e.rid }, t.session, 10000); }
    catch (x) {
      return { ok: true, kind: "none", gone: true, note: `The body is no longer available: the browser has let it go (${String(x.message).replace(/^Network\.getResponseBody: /, "")}). Bodies are kept for requests made while this helper ran, until the page navigates away or about 20 MB of newer ones push them out.` };
    }
    if (raw) return { ok: true, kind: "raw", body: r.body, base64: r.base64Encoded, mime: e.mime };
    return shape(r.body, r.base64Encoded, e.mime, e.url);
  }

  function shape(text, base64, mime, url) {
    const buf = base64 ? Buffer.from(text ?? "", "base64") : null;
    const size = buf ? buf.length : Buffer.byteLength(text ?? "", "utf8");
    let s = text ?? "";
    if (buf) {
      const asText = buf.toString("utf8");
      // a "binary" body that decodes cleanly is text (Chrome base64-encodes some text types)
      if (textual(mime) || (!asText.includes("�") && !/[\x00-\x08\x0e-\x1f]/.test(asText.slice(0, 4000)))) s = asText;
      else return { ok: true, kind: "binary", size, mime, note: `binary · ${size.toLocaleString("en-US")} B${mime ? ` · ${mime}` : ""}` };
    }
    const lang = langOf(mime, url), pretty = lang === "json" || !lang || lang === "text" ? prettyJson(s) : null;
    const cut = (x) => (x && x.length > SHOW_MAX ? `${x.slice(0, SHOW_MAX)}\n… cut at ${SHOW_MAX.toLocaleString("en-US")} characters` : x);
    return { ok: true, kind: pretty ? "json" : "text", lang: pretty ? "json" : lang, size, mime, text: cut(s), pretty: cut(pretty), truncated: s.length > SHOW_MAX };
  }

  // ---- Edit and resend -----------------------------------------------------------------------

  const REPEAT = `async function (req) {
    const t0 = performance.now();
    const h = new Headers();
    for (const [k, v] of req.headers) { try { h.append(k, v); } catch (e) {} }
    const init = { method: req.method, headers: h, credentials: "include", redirect: "follow", cache: "no-store" };
    if (req.referrer) { try { init.referrer = req.referrer; } catch (e) {} }
    if (req.body != null && req.body !== "" && !/^(GET|HEAD)$/i.test(req.method)) init.body = req.body;
    try {
      const r = await fetch(req.url, init);
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      const cap = Math.min(buf.length, 8000000);
      for (let i = 0; i < cap; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, Math.min(cap, i + 32768)));
      return { ok: true, status: r.status, statusText: r.statusText, headers: [...r.headers], url: r.url, redirected: r.redirected, type: r.type,
        size: buf.length, time: performance.now() - t0, base64: btoa(bin), origin: location.origin };
    } catch (e) { return { ok: false, error: String(e && e.message || e), time: performance.now() - t0, origin: location.origin }; }
    //# sourceURL=herdr-devtools/repeater.js
  }`;

  async function resend(t, b) {
    const method = String(b.method || "GET").toUpperCase().trim(), url = String(b.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw err(400, "The URL must start with http:// or https://");
    if (!/^[A-Z]+$/.test(method)) throw err(400, "The method should be a word like GET or POST");
    const headers = pairs(b.headers ?? []).filter(([k]) => k && !k.startsWith(":"));
    const hasBody = b.body != null && b.body !== "" && !/^(GET|HEAD)$/.test(method);
    if (b.mode === "direct") {
      const h = new Headers(), skipped = [];
      for (const [k, v] of headers) { if (HOP.has(k.toLowerCase())) { skipped.push(k); continue; } try { h.append(k, v); } catch { skipped.push(k); } }
      let cookieNote = "";
      if (b.cookies !== false && !h.has("cookie")) {
        try {
          const { cookies } = await send("Network.getCookies", { urls: [url] }, t?.session ?? undefined, 5000);
          if (cookies?.length) { h.set("cookie", cookies.map((c) => `${c.name}=${c.value}`).join("; ")); cookieNote = `${cookies.length} cookie${cookies.length === 1 ? "" : "s"} from this browser added. `; }
        } catch {}
      }
      const t0 = Date.now();
      try {
        const r = await fetch(url, { method, headers: h, body: hasBody ? String(b.body) : undefined, redirect: "manual", signal: AbortSignal.timeout(60000) });
        const buf = Buffer.from(await r.arrayBuffer());
        const mime = r.headers.get("content-type") ?? "";
        return { ok: true, mode: "direct", status: r.status, statusText: r.statusText, headers: [...r.headers], url, time: Date.now() - t0,
          note: `${cookieNote}Sent by the helper (Node), not the page: no CORS, no page origin.${skipped.length ? ` Not sent (set by the connection): ${skipped.join(", ")}.` : ""}${r.status >= 300 && r.status < 400 ? " Redirects aren't followed here." : ""}`,
          ...shape(buf.toString("base64"), true, mime, url) };
      } catch (x) {
        return { ok: false, mode: "direct", error: String(x.cause?.message ?? x.message ?? x), time: Date.now() - t0 };
      }
    }
    if (!t?.session) throw err(503, "No page to send it from");
    const dropped = headers.filter(([k]) => FORBIDDEN.has(k.toLowerCase()) || /^(sec-|proxy-)/i.test(k)).map(([k]) => k);
    const send2 = headers.filter(([k]) => !dropped.includes(k));
    // say which were left out: the ones asked for explicitly (an agent's), else all, shortly
    const told = [...new Set((b.explicit ? dropped.filter((k) => b.explicit.includes(k.toLowerCase())) : dropped).map((k) => k.toLowerCase()))];
    const toldText = told.length > 6 ? `${told.slice(0, 6).join(", ")} and ${told.length - 6} more` : told.join(", ");
    const referrer = headerOf(headers, "referer");
    const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: t.id, worldName: WORLD }, t.session, 5000);
    const r = await send("Runtime.callFunctionOn", { functionDeclaration: REPEAT, executionContextId, arguments: [{ value: { method, url, headers: send2, body: hasBody ? String(b.body) : null, referrer } }],
      awaitPromise: true, returnByValue: true }, t.session, 65000);
    const v = r.result?.value;
    if (!v) throw err(500, r.exceptionDetails?.exception?.description ?? "The page didn't answer");
    const note = `Sent by the page (${v.origin}) with fetch(): its cookies and origin apply.${told.length ? ` The browser sets these itself, so yours were left out: ${toldText}.` : ""}`;
    if (!v.ok) {
      return { ok: false, mode: "page", time: Math.round(v.time), error: v.error,
        note: `${note} The page's fetch() was refused: usually CORS (${v.origin} may not read ${hostOf(url)}'s answer) or the page's Content-Security-Policy. Send it Direct instead: from the helper, with this browser's cookies.` };
    }
    const mime = v.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    return { ok: true, mode: "page", status: v.status, statusText: v.statusText, headers: v.headers, url: v.url, redirected: v.redirected, time: Math.round(v.time),
      note: `${note}${v.redirected ? " Redirects were followed." : ""}${v.type === "cors" ? " Cross-origin: only the headers the server exposes to the page are shown." : ""}`,
      ...shape(v.base64, true, mime, v.url) };
  }

  // ---- Intercept: one Fetch engine for the drawer (I) and agents' rules (RULES) ---------------
  // Each tab's session has Fetch enabled with the union of the drawer's pattern (while it's on)
  // and every live rule's; a paused request then gets the modify rules that match it, and waits
  // in I.paused if a pause rule or the drawer wants it, else goes on at once.

  const RULES = new Map(); // id -> { id, by, pattern, re, method, resourceType, stage, action, set, times, left, hits, created, expires, tab }
  let RSEQ = 0, lastAgentPoll = 0;
  const AGENT_WATCHDOG_MS = 60000; // requests a pause rule holds go on when nobody looked for this long
  const inScope = (id) => I.scope === "all" || id === I.tab;
  // With a *: CDP's wildcards (* any, ? one character, backslash escapes). Without: "the URL
  // contains this", taken literally (a ? in a query string is just a ?).
  const glob = (p) => { p = String(p ?? "").trim() || "*"; return p.includes("*") ? p : `*${p.replace(/[\\?]/g, "\\$&")}*`; };
  function globRe(p) {
    const g = glob(p);
    let re = "";
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === "\\" && i + 1 < g.length) re += g[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      else if (c === "*") re += ".*";
      else if (c === "?") re += ".";
      else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
    return new RegExp(`^${re}$`, "s");
  }
  I.re = globRe(I.pattern);
  // {set: {name: value}, remove: [names]} applied to [[name, value]] (names case-insensitive)
  function patchHeaders(list, h) {
    if (!h) return list;
    const set = Object.entries(h.set ?? {}), rm = new Set([...(h.remove ?? []), ...set.map(([k]) => k)].map((k) => String(k).toLowerCase()));
    return [...list.filter(([k]) => !rm.has(String(k).toLowerCase())), ...set.map(([k, v]) => [k, String(v)])];
  }
  const headerObj = (list) => { const o = {}; for (const [k, v] of list ?? []) o[k] = k in o ? `${o[k]}${k.toLowerCase() === "set-cookie" ? "\n" : ", "}${v}` : v; return o; };
  const cap = (text, max) => (text == null ? text : text.length > max ? `${text.slice(0, max)}… (${text.length.toLocaleString("en-US")} characters, cut at ${max})` : text);

  function patternsFor(t) {
    const out = new Map();
    const add = (urlPattern, resourceType, requestStage) => {
      const p = { urlPattern, requestStage, ...(resourceType ? { resourceType } : {}) };
      out.set(JSON.stringify(p), p);
    };
    if (I.on && inScope(t.id)) {
      for (const st of I.response ? ["Request", "Response"] : ["Request"]) {
        if (!I.types.length) add(glob(I.pattern), null, st);
        else for (const ty of I.types) add(glob(I.pattern), ty, st);
      }
    }
    for (const r of RULES.values()) if (!r.tab || r.tab === t.id) add(glob(r.pattern), r.resourceType || null, r.stage === "response" ? "Response" : "Request");
    return [...out.values()];
  }
  async function syncTab(t) {
    if (!t.session) return;
    const pats = patternsFor(t), key = JSON.stringify(pats);
    if (!pats.length) {
      if (t.fetchOn) { t.fetchOn = false; t.fetchKey = ""; await send("Fetch.disable", {}, t.session, 3000).catch(() => {}); }
      return;
    }
    if (t.fetchOn && t.fetchKey === key) return;
    await send("Fetch.enable", { patterns: pats, handleAuthRequests: false }, t.session, 5000);
    t.fetchOn = true;
    t.fetchKey = key;
  }
  const serial = (fn) => { const run = I.busy.then(fn); I.busy = run.catch(() => {}); return run; };
  const syncNow = async () => { for (const t of tabs.values()) await syncTab(t).catch((e) => log("devtools fetch", e.message)); };
  const syncAll = () => serial(syncNow); // from outside serial() only

  const ruleMatches = (r, t, stage, method, url, type) => r.stage === stage && (!r.tab || r.tab === t.id) && (!r.method || r.method === String(method).toUpperCase())
    && (!r.resourceType || r.resourceType === type) && r.expires > Date.now() && (r.left == null || r.left > 0) && r.re.test(url);

  function applySet(item, s) {
    if (!s) return;
    if (item.stage === "request") {
      if (s.url) item.url = String(s.url);
      if (s.method) item.method = String(s.method).toUpperCase();
      if (s.body != null) item.postData = String(s.body);
      if (s.headers) item.headers = patchHeaders(item.headers, s.headers);
    } else {
      if (s.status) item.status = Number(s.status);
      if (s.statusText) item.statusText = String(s.statusText);
      if (s.headers) item.resHeaders = patchHeaders(item.resHeaders, s.headers);
      if (s.body != null) item.newBody = String(s.body);
    }
  }

  function onPaused(t, p) {
    const req = p.request ?? {}, stage = p.responseStatusCode !== undefined ? "response" : "request";
    const plain = () => send("Fetch.continueRequest", { requestId: p.requestId }, t.session, 5000).catch(() => {});
    if (p.responseErrorReason) { plain(); return; }
    const url = req.url + (req.urlFragment ?? ""), type = p.resourceType ?? "";
    const matched = [...RULES.values()].filter((r) => ruleMatches(r, t, stage, req.method, url, type));
    const pauseRule = matched.find((r) => r.action === "pause"), mods = matched.filter((r) => r.action === "modify");
    const ui = I.on && inScope(t.id) && (stage === "request" || I.response) && I.re.test(url) && (!I.types.length || I.types.includes(type));
    for (const r of [...mods, ...(pauseRule ? [pauseRule] : [])]) { r.hits++; if (r.left != null) r.left--; }
    if (!mods.length && !pauseRule && !ui) { plain(); return; } // a pattern overlap (a method or type that doesn't match)
    let postData = req.postData;
    if (postData === undefined && req.postDataEntries?.length) { try { postData = req.postDataEntries.map((x) => Buffer.from(x.bytes ?? "", "base64").toString("utf8")).join(""); } catch {} }
    const item = { id: p.requestId, tab: t.id, session: t.session, stage, networkId: p.networkId, at: Date.now(), type, method: req.method, url,
      headers: pairs(req.headers), postData: postData ?? null, hasPostData: Boolean(req.hasPostData),
      status: p.responseStatusCode, statusText: p.responseStatusText ?? "", resHeaders: pairs(p.responseHeaders ?? []) };
    item.orig = { method: item.method, url: item.url, headers: item.headers, postData: item.postData, status: item.status, statusText: item.statusText, resHeaders: item.resHeaders };
    for (const r of mods) applySet(item, r.set); // in the order the rules were made
    item.rules = mods.map((r) => r.id);
    if (matched.some((r) => r.left === 0)) setTimeout(tick, 0);
    if (!pauseRule && !ui) {
      finish(item).then((changed) => mark(item, changed ? "rule" : null)).catch((e) => { log("devtools rule", e.message); plain(); });
      return;
    }
    item.by = pauseRule ? pauseRule.id : "you";
    item.ui = ui;
    I.paused.set(item.id, item);
    I.ver++;
    const e = t.byRid.get(p.networkId);
    if (e) { e.paused = item.stage; touch(t, e); }
  }

  async function readBody(item) {
    if (item.body !== undefined) return;
    try { const r = await send("Fetch.getResponseBody", { requestId: item.id }, item.session, 10000); item.body = r.body; item.base64 = r.base64Encoded; }
    catch (e) { item.body = null; item.bodyError = e.message; }
  }

  // Lets the request (or response) go with what it holds now; true when anything differs from
  // what the browser paused.
  async function finish(item) {
    const o = item.orig;
    if (item.stage === "request") {
      const params = { requestId: item.id };
      if (item.url !== o.url) params.url = item.url;
      if (item.method !== o.method) params.method = item.method;
      if (JSON.stringify(item.headers) !== JSON.stringify(o.headers)) params.headers = item.headers.filter(([k]) => k).map(([name, value]) => ({ name, value }));
      if (item.postData != null && item.postData !== o.postData) params.postData = b64(item.postData);
      await send("Fetch.continueRequest", params, item.session, 8000);
      return Object.keys(params).length > 1;
    }
    const code = Number(item.status) || o.status;
    const phrase = item.statusText || (code === o.status && o.statusText) || STATUS_CODES[code] || "Edited"; // Chrome wants one for 299
    const headersChanged = JSON.stringify(item.resHeaders) !== JSON.stringify(o.resHeaders), codeChanged = code !== o.status || item.statusText !== o.statusText;
    if (item.newBody == null && !headersChanged && !codeChanged) {
      await send("Fetch.continueResponse", { requestId: item.id }, item.session, 5000).catch(() => send("Fetch.continueRequest", { requestId: item.id }, item.session, 5000));
      return false;
    }
    if (item.newBody == null) {
      // same body: let it through with new status/headers; else read it and send it back
      try {
        await send("Fetch.continueResponse", { requestId: item.id, responseCode: code, responsePhrase: phrase, responseHeaders: item.resHeaders.map(([name, value]) => ({ name, value })) }, item.session, 8000);
        return true;
      } catch {}
      await readBody(item);
    }
    // a new body goes out decoded, so the original encoding and length go
    const body = item.newBody != null ? b64(item.newBody) : item.body != null ? (item.base64 ? item.body : b64(item.body)) : "";
    const headers = item.resHeaders.filter(([k]) => k && !/^(content-length|content-encoding)$/i.test(k)).map(([name, value]) => ({ name, value }));
    await send("Fetch.fulfillRequest", { requestId: item.id, responseCode: code, responsePhrase: phrase, responseHeaders: headers, body }, item.session, 8000);
    return true;
  }

  function mark(item, how) {
    const t = tabs.get(item.tab), e = t?.byRid.get(item.networkId);
    if (!e) return;
    e.paused = undefined;
    if (how === "edited" || how === "rule") e.edited = how === "rule" ? `${item.stage} (rule)` : item.stage;
    if (how === "dropped") e.dropped = true;
    touch(t, e);
  }
  function settle(item, how) {
    I.paused.delete(item.id);
    I.ver++;
    mark(item, how);
  }
  function dropPaused(tabId) {
    for (const item of [...I.paused.values()]) if (item.tab === tabId) { I.paused.delete(item.id); I.ver++; }
  }
  // Release: on as it stands (modify rules' changes stay); a plain continue if that fails.
  async function goOn(item) {
    if (!I.paused.has(item.id)) return;
    I.paused.delete(item.id);
    let changed = false;
    try { changed = await finish(item); }
    catch (e) {
      log("devtools continue", e.message);
      await send("Fetch.continueRequest", { requestId: item.id }, item.session, 5000).catch(() => {});
    }
    I.ver++;
    mark(item, changed ? "rule" : "forwarded");
  }

  // A held item edited by a person (the drawer) or an agent (/net/paused/continue), then let go.
  function applyEdits(item, ed) {
    if (!ed) return;
    if (item.stage === "request") {
      if (ed.url) item.url = String(ed.url);
      if (ed.method) item.method = String(ed.method).toUpperCase();
      if (ed.body != null) item.postData = String(ed.body);
    } else {
      if (ed.status) item.status = Number(ed.status);
      if (ed.statusText != null) item.statusText = String(ed.statusText);
      if (ed.body != null) item.newBody = String(ed.body);
    }
    if (ed.headers) {
      const h = ed.headers, patch = !Array.isArray(h) && (h.set || h.remove);
      const list = patch ? patchHeaders(item.stage === "request" ? item.headers : item.resHeaders, h) : pairs(h);
      if (item.stage === "request") item.headers = list; else item.resHeaders = list;
    }
  }

  async function forward(b) {
    const item = I.paused.get(String(b.id));
    if (!item) throw err(404, "That request isn't held any more");
    applyEdits(item, b.edits);
    if (item.stage === "response" && item.newBody == null && b.edits) await readBody(item);
    const changed = await finish(item);
    settle(item, changed ? "edited" : "forwarded");
    return { ok: true, changed };
  }

  async function drop(b) {
    const item = I.paused.get(String(b.id));
    if (!item) throw err(404, "That request isn't held any more");
    const t = tabs.get(item.tab), e = t?.byRid.get(item.networkId);
    if (e) e.dropped = true;
    await send("Fetch.failRequest", { requestId: item.id, errorReason: "BlockedByClient" }, item.session, 5000).catch((x) => log("devtools drop", x.message));
    settle(item, "dropped");
    return { ok: true };
  }

  // The drawer's Intercept switch and settings.
  async function setIntercept(cfg, note = "") {
    const was = I.on;
    if (cfg.pattern !== undefined) { I.pattern = String(cfg.pattern); I.re = globRe(I.pattern); }
    if (Array.isArray(cfg.types)) I.types = cfg.types.map(String).filter(Boolean);
    if (cfg.response !== undefined) I.response = Boolean(cfg.response);
    if (cfg.scope === "all" || cfg.scope === "tab") I.scope = cfg.scope;
    if (cfg.on !== undefined) I.on = Boolean(cfg.on);
    if (I.on) {
      if (!was || cfg.scope) I.tab = current() ?? I.tab;
      I.lastPoll = Date.now();
      I.note = "";
      if (I.scope === "tab" && !(await shown())) { I.on = false; throw err(503, "No page to intercept"); }
    }
    // what the drawer held and no longer wants goes on (a pause rule's own holds stay)
    for (const item of [...I.paused.values()]) {
      if (item.by !== "you") { if (!I.on) item.ui = false; continue; }
      if (!I.on || !inScope(item.tab)) await goOn(item);
    }
    await syncNow();
    for (const item of [...I.paused.values()]) if (item.by === "you" && !I.on) await goOn(item); // paused meanwhile
    if (was && !I.on && note) I.note = note;
    I.ver++;
  }

  async function removeRules(ids, why = "") {
    for (const id of ids) {
      const r = RULES.get(id);
      if (!r) continue;
      RULES.delete(id);
      log("devtools rule removed", id, why);
    }
    // what a removed pause rule held: the drawer keeps it if it wants it, else it goes on
    for (const item of [...I.paused.values()]) {
      if (item.by === "you" || RULES.has(item.by)) continue;
      if (item.ui && I.on) item.by = "you";
      else await goOn(item);
    }
    await syncNow();
    I.ver++;
  }

  function ruleOut(r) {
    const { re: _re, ...x } = r;
    return { ...x, expiresIn: Math.max(0, Math.round((r.expires - Date.now()) / 1000)) };
  }

  async function addRule(b, by) {
    if (!b.pattern) throw err(400, "A rule needs a URL pattern");
    const stage = b.stage === "response" ? "response" : "request", action = b.action === "pause" ? "pause" : "modify";
    const set = b.set ?? {};
    let headers = set.headers;
    if (headers && !headers.set && !headers.remove) headers = { set: headers }; // a plain {name: value} means set
    const ttl = Math.max(5, Math.min(86400, Number(b.ttlSec) || 600));
    const r = { id: `r${++RSEQ}`, by, pattern: String(b.pattern), re: globRe(b.pattern),
      method: b.method ? String(b.method).toUpperCase() : null, resourceType: b.resourceType || null, stage, action,
      set: { ...set, ...(headers ? { headers: { set: headers.set ?? {}, remove: headers.remove ?? [] } } : {}) },
      times: b.times ? Math.max(1, Number(b.times) | 0) : null, left: b.times ? Math.max(1, Number(b.times) | 0) : null, hits: 0,
      created: Date.now(), expires: Date.now() + ttl * 1000, tab: b.tab === "current" ? current() : b.tab || null };
    if (action === "modify" && !Object.keys(r.set).length) throw err(400, "A modify rule needs something to set (url, method, headers, body, status)");
    RULES.set(r.id, r);
    I.ver++;
    await syncAll();
    return { ok: true, id: r.id, rule: ruleOut(r) };
  }

  function tick() {
    const now = Date.now();
    if (I.on && now - I.lastPoll > WATCHDOG_MS) {
      log("devtools: intercept watchdog");
      serial(() => setIntercept({ on: false }, "Intercept turned itself off: the drawer wasn't watching for 20 s (hidden or closed), so the held requests went on.")).catch(() => {});
    }
    const gone = [...RULES.values()].filter((r) => r.expires <= now || r.left === 0).map((r) => r.id);
    if (gone.length) serial(() => removeRules(gone, "expired")).catch(() => {});
    // held by a pause rule while nobody (agent or person) looks: let go
    if (now - Math.max(lastAgentPoll, I.lastPoll) > AGENT_WATCHDOG_MS) {
      for (const item of [...I.paused.values()]) if (item.by !== "you" && now - item.at > AGENT_WATCHDOG_MS) goOn(item).catch(() => {});
    }
  }

  function icptState(summary, passive) {
    if (!passive) I.lastPoll = Date.now();
    const head = { ok: true, on: I.on, pattern: I.pattern, types: I.types, response: I.response, scope: I.scope, tab: I.tab, ver: I.ver, n: I.paused.size,
      rules: RULES.size, note: I.note };
    if (summary) return head;
    return { ...head, ruleList: [...RULES.values()].map(ruleOut),
      items: [...I.paused.values()].map(({ session: _s, orig: _o, body: _b, base64: _6, ...x }) => x) };
  }

  async function icptItem(id) {
    const item = I.paused.get(id);
    if (!item) throw err(404, "That request isn't held any more");
    const { session: _s, orig: _o, body: _b, base64: _6, ...x } = item;
    if (item.stage === "response") await readBody(item);
    let shownBody = null;
    if (item.stage === "response") {
      const mime = item.resHeaders.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
      if (item.newBody != null) shownBody = shape(item.newBody, false, mime, item.url);
      else if (item.body != null) shownBody = shape(item.body, item.base64, mime, item.url);
    }
    return { ok: true, item: x, body: shownBody, bodyError: item.bodyError ?? null };
  }

  // ---- the agents' network API (/net/*), the same log and the same engine ----------------------

  const TYPEQ = { xhr: ["XHR"], fetch: ["Fetch"], api: ["XHR", "Fetch", "EventSource"], doc: ["Document"], document: ["Document"], js: ["Script"],
    script: ["Script"], css: ["Stylesheet"], img: ["Image"], image: ["Image"], media: ["Media"], font: ["Font"], ws: ["WebSocket"], websocket: ["WebSocket"] };
  const KNOWN = new Set(Object.values(TYPEQ).flat());
  const typeOk = (e, ty) => !ty || (ty === "other" ? !KNOWN.has(e.type) : (TYPEQ[ty.toLowerCase()] ?? [ty]).includes(e.type));
  function statusOk(e, st) {
    if (!st) return true;
    st = String(st).toLowerCase();
    if (st === "failed") return e.failed;
    if (st === "pending") return !e.done;
    if (st === "error") return e.failed || e.status >= 400;
    if (/^[1-5]xx$/.test(st)) return Math.floor(e.status / 100) === Number(st[0]);
    return String(e.status) === st;
  }
  const agentItem = (t, e) => ({ id: String(e.seq), seq: e.seq, tab: t.id, method: e.method, url: e.url, domain: e.host, status: e.status, type: e.type,
    mime: e.mime || undefined, size: e.size, time: e.time, pending: !e.done, failed: e.failed || undefined, error: e.error || undefined,
    cache: e.cache || undefined, edited: e.edited || undefined, paused: e.paused || undefined, herdr: e.herdr || undefined });
  function tabsFor(sel) {
    if (!sel || sel === "all") return [...tabs.values()];
    const id = sel === "current" ? current() : sel;
    return [...tabs.values()].filter((t) => t.id === id);
  }

  function requests(q) {
    const ty = q.get("type"), text = (q.get("q") ?? "").toLowerCase(), domain = (q.get("domain") ?? "").toLowerCase(), st = q.get("status");
    const since = Number(q.get("since") ?? 0), limit = Math.max(1, Math.min(1000, Number(q.get("limit")) || 50)), method = q.get("method")?.toUpperCase();
    const hits = [];
    for (const t of tabsFor(q.get("tab"))) {
      for (const e of t.net) {
        if (e.seq <= since || !typeOk(e, ty) || !statusOk(e, st) || (method && e.method !== method)) continue;
        if (text && !e.url.toLowerCase().includes(text)) continue;
        if (domain && !(e.host ?? "").toLowerCase().includes(domain)) continue;
        hits.push(agentItem(t, e));
      }
    }
    hits.sort((a, b) => a.seq - b.seq);
    return { ok: true, last: SEQ, current: current(), count: hits.length, requests: hits.slice(-limit) };
  }

  async function agentRequest(q) {
    const hit = bySeq.get(Number(q.get("id")));
    if (!hit) throw err(404, `No request ${q.get("id")} (the log keeps the last ${MAX_NET} per tab; a new page clears it unless Preserve log is on)`);
    const { t, e } = hit, max = Math.max(100, Math.min(20_000_000, Number(q.get("max")) || 100_000));
    const d = await detail(t, e.n);
    const out = { ok: true, ...agentItem(t, e), statusText: e.statusText || undefined, protocol: e.protocol || undefined, remote: e.remote || undefined,
      initiator: e.initiator ?? undefined, requestHeaders: headerObj(d.e.resolvedReqHeaders), requestHeadersProvisional: !d.e.rawRequest || undefined,
      responseHeaders: headerObj(d.e.resolvedResHeaders), timing: d.timing };
    if (q.get("body")) out.postData = e.postData == null ? null : cap(e.postData, max);
    if (q.get("response")) {
      const r = await body(t, e.n, true);
      if (r.kind === "raw") {
        if (r.base64) {
          const buf = Buffer.from(r.body ?? "", "base64"), text = buf.toString("utf8");
          if (!text.includes("�") && !/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 4000))) out.response = { text: cap(text, max), size: buf.length };
          else out.response = { base64: true, data: buf.subarray(0, max).toString("base64"), size: buf.length, truncated: buf.length > max || undefined };
        } else out.response = { text: cap(r.body ?? "", max), size: Buffer.byteLength(r.body ?? "", "utf8") };
      } else if (r.kind === "frames") out.response = { frames: r.frames };
      else out.response = { none: true, note: r.note };
    }
    return out;
  }

  async function agentReplay(b) {
    let base = { method: "GET", url: "", headers: [], body: null }, t = await shown();
    if (b.id != null) {
      const hit = bySeq.get(Number(b.id));
      if (!hit) throw err(404, `No request ${b.id}`);
      t = hit.t;
      const d = await detail(hit.t, hit.e.n);
      base = { method: d.e.method, url: d.e.url, headers: d.e.resolvedReqHeaders.filter(([k]) => !k.startsWith(":")), body: d.e.postData ?? null };
    }
    let headers = base.headers;
    if (b.headers) headers = Array.isArray(b.headers) || !(b.headers.set || b.headers.remove) ? patchHeaders(headers, { set: Object.fromEntries(pairs(b.headers)) }) : patchHeaders(headers, b.headers);
    if (b.removeHeaders) headers = patchHeaders(headers, { remove: b.removeHeaders });
    const explicit = b.headers ? pairs(b.headers.set ?? b.headers).map(([k]) => k.toLowerCase()) : [];
    const r = await resend(t, { method: b.method ?? base.method, url: b.url ?? base.url, headers, body: b.body !== undefined ? b.body : base.body, mode: b.mode ?? "page", cookies: b.cookies, explicit });
    const max = Math.max(100, Number(b.max) || 100_000);
    const { pretty: _p, text, lang: _l, ...rest } = r;
    return { ...rest, headers: r.headers ? headerObj(r.headers) : undefined, body: text != null ? cap(text, max) : undefined };
  }

  const waiters = new Set();
  function finished(t, e) {
    for (const w of waiters) if (w.match(t, e)) { waiters.delete(w); w.done(agentItem(t, e)); }
  }
  function agentWait(b) {
    if (!b.pattern) throw err(400, "wait needs a URL pattern");
    const re = globRe(b.pattern), method = b.method ? String(b.method).toUpperCase() : null;
    const since = b.since != null ? Number(b.since) : SEQ;
    const timeout = Math.max(100, Math.min(300000, Number(b.timeoutMs) || 30000));
    const inFlight = new Set();
    for (const t of tabs.values()) for (const e of t.net) if (!e.done) inFlight.add(e.seq);
    const match = (t, e) => e.done && (e.seq > since || inFlight.has(e.seq)) && re.test(e.url) && (!method || e.method === method)
      && (!b.status || statusOk(e, b.status)) && (!b.tab || tabsFor(b.tab).includes(t));
    for (const t of tabs.values()) for (const e of t.net) if (match(t, e)) return { ok: true, request: agentItem(t, e) };
    return new Promise((resolve, reject) => {
      const w = { match, done: (x) => { clearTimeout(w.timer); resolve({ ok: true, request: x }); } };
      w.timer = setTimeout(() => { waiters.delete(w); reject(err(408, `No request matching ${b.pattern} finished within ${Math.round(timeout / 1000)} s`)); }, timeout);
      waiters.add(w);
    });
  }

  function pausedOut(max) {
    return [...I.paused.values()].map((it) => ({ id: it.id, stage: it.stage, by: it.by === "you" ? "you" : `rule ${it.by}`, tab: it.tab, type: it.type,
      method: it.method, url: it.url, age: Math.round((Date.now() - it.at) / 1000),
      ...(it.stage === "request" ? { headers: headerObj(it.headers), postData: it.postData == null ? undefined : cap(it.postData, max) }
        : { status: it.status, statusText: it.statusText || undefined, headers: headerObj(it.resHeaders), body: it.newBody != null ? cap(it.newBody, max) : undefined }),
      rules: it.rules?.length ? it.rules : undefined }));
  }

  // ---- routes --------------------------------------------------------------------------------

  async function route(method, pathname, q, b) {
    if (pathname.startsWith("/net/")) return netRoute(method, pathname.slice(5), q, b);
    if (!pathname.startsWith("/devtools/")) return undefined;
    const p = pathname.slice(10);
    if (p === "hello") return { ok: true, v: 2 };
    if (!cdp) throw err(503, "The browser isn't connected yet");
    if (method === "GET") {
      if (p === "intercept") return icptState(q.get("summary"), q.get("passive"));
      if (p === "intercept/item") return icptItem(q.get("id"));
      if (I.on) I.lastPoll = Date.now();
      const t = await shown();
      if (!t) return { ok: true, target: null, gen: "", ver: 0, first: 0, reset: true, entries: [], preserve, icpt: { on: I.on, n: I.paused.size, rules: RULES.size } };
      if (p === "console") return list(t, "console", q);
      if (p === "net") return list(t, "net", q);
      if (p === "request") return detail(t, q.get("key"));
      if (p === "body") return body(t, q.get("key"));
      throw err(404, `Unknown ${pathname}`);
    }
    switch (p) {
      case "console/clear": { const t = await shown(); if (t) { t.console = []; t.cgen++; t.cver = ++VER; } return { ok: true }; }
      case "net/clear": { const t = await shown(); if (t) clearNet(t); return { ok: true }; }
      case "net/preserve": preserve = Boolean(b.on); return { ok: true, preserve };
      case "send": return resend(await shown(), b);
      case "intercept": await serial(() => setIntercept(b)); return icptState(false);
      case "intercept/forward": return forward(b);
      case "intercept/drop": return drop(b);
      case "intercept/forward-all": for (const item of [...I.paused.values()]) await goOn(item); return { ok: true };
      case "rules": return addRule(b, "you"); // a rule the person made in the drawer
      // the person removes any rule from the drawer (agents' too)
      case "rules/remove": await serial(() => removeRules(b.all ? [...RULES.keys()] : [String(b.id)], "removed in the drawer")); return { ok: true };
    }
    throw err(404, `Unknown ${pathname}`);
  }

  async function netRoute(method, p, q, b) {
    if (!cdp) throw err(503, "The browser isn't connected yet");
    lastAgentPoll = Date.now();
    if (method === "GET") {
      if (p === "requests") return requests(q);
      if (p === "request") return agentRequest(q);
      if (p === "rules") return { ok: true, rules: [...RULES.values()].map(ruleOut), intercept: I.on ? { by: "you", pattern: I.pattern, response: I.response } : null };
      if (p === "paused") return { ok: true, paused: pausedOut(Math.max(100, Number(q.get("max")) || 20000)) };
      throw err(404, `Unknown /net/${p}`);
    }
    switch (p) {
      case "replay": return agentReplay(b);
      case "wait": return agentWait(b);
      case "rules": return addRule(b, "agent");
      case "rules/remove": {
        // agents remove their own rules; the person's ("you") only from the drawer
        const ids = b.all ? [...RULES.values()].filter((r) => r.by === "agent").map((r) => r.id) : [String(b.id)];
        if (!b.all) {
          const r = RULES.get(ids[0]);
          if (!r) throw err(404, `No rule ${b.id}`);
          if (r.by !== "agent") throw err(403, `Rule ${b.id} was made by the person in the panel: only they remove it`);
        }
        await serial(() => removeRules(ids, "removed by an agent"));
        return { ok: true, removed: ids };
      }
      case "paused/continue": {
        const { id, ...ed } = b;
        return forward({ id, edits: Object.keys(ed).length ? ed : undefined });
      }
      case "paused/drop": return drop(b);
    }
    throw err(404, `Unknown /net/${p}`);
  }

  // Helper exit: nothing may stay held, no rule outlives it.
  async function release() {
    if (!I.on && !I.paused.size && !RULES.size) return;
    const all = (async () => {
      I.on = false;
      RULES.clear();
      for (const item of [...I.paused.values()]) await goOn(item);
      for (const t of tabs.values()) { if (t.fetchOn && t.session) { t.fetchOn = false; await send("Fetch.disable", {}, t.session, 1500).catch(() => {}); } }
      for (const item of [...I.paused.values()]) await goOn(item);
    })();
    await Promise.race([all, new Promise((r) => setTimeout(r, 2500))]);
  }

  return { connect, route, release, _state: () => ({ tabs, I, RULES }) };
}

// A console argument as text (strings bare, objects from their preview).
function remoteText(a) {
  if (!a) return "";
  if (a.type === "string") return a.value;
  if (a.unserializableValue) return a.unserializableValue;
  if ("value" in a && a.type !== "object") return String(a.value);
  if (a.subtype === "error" && a.description) return a.description;
  if (a.preview?.properties) {
    const inner = a.preview.properties.slice(0, 12).map((p) => (a.subtype === "array" ? p.value : `${p.name}: ${p.value}`)).join(", ");
    return a.subtype === "array" ? `[${inner}${a.preview.overflow ? ", …" : ""}]` : `${a.className && a.className !== "Object" ? `${a.className} ` : ""}{${inner}${a.preview.overflow ? ", …" : ""}}`;
  }
  if ("value" in a) return JSON.stringify(a.value);
  return a.description ?? a.type;
}
