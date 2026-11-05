// `bp net ...`: the Browser panel's network log, replay, waits, intercept rules and the paused
// queue, for agents. The helper's /net/* API (devtools-net.mjs in mods/browser-panel) does the work;
// this file only turns arguments into calls and prints compact JSON. See net.md.
//
//   export async function run(argv, api)   argv starts with "net"; api(path, body?) -> JSON or throws

import fs from "node:fs";

const USAGE = `bp net: the Browser panel's traffic. JSON out.
  net ls [--type xhr|fetch|api|doc|js|css|img|media|font|ws|other] [--q text] [--domain d] [--status 404|4xx|error|failed|pending]
         [--method M] [--limit 50] [--since seq] [--tab current|all|<id>]
  net show <id> [--body] [--response] [--max chars] [--full]
  net replay [<id>] [--method M] [--url U] [--header "K: V"]... [--remove-header K]... [--body text|@file] [--direct] [--max chars] [--full]
  net wait <url-pattern> [--method M] [--status s] [--timeout 30] [--since seq]
  net rule add <url-pattern> [--stage request|response] [--set-header "K: V"]... [--remove-header K]... [--body text|@file]
               [--status n] [--url U] [--method M] [--only-method M] [--type T] [--pause] [--times n] [--ttl 600] [--tab current]
  net rule ls | net rule rm <id> | net rule rm --all
  net paused [--max chars]
  net continue <id> [--method M] [--url U] [--set-header "K: V"]... [--remove-header K]... [--body text|@file] [--status n]
  net drop <id>`;

const TYPES = { xhr: "XHR", fetch: "Fetch", doc: "Document", document: "Document", js: "Script", script: "Script", css: "Stylesheet",
  stylesheet: "Stylesheet", img: "Image", image: "Image", media: "Media", font: "Font", ws: "WebSocket", other: "Other", ping: "Ping", preflight: "Preflight" };
const SHOW_MAX = 4000, FULL = 20_000_000;

// --body is a switch for `show` (include the request body) and takes a value elsewhere.
function parse(argv) {
  const pos = [], o = {};
  const many = new Set(["header", "remove-header", "set-header"]);
  const bools = new Set(argv[0] === "show" ? ["body", "response", "full"] : ["pause", "all", "direct", "full"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    let k = a.slice(2), v;
    const eq = k.indexOf("=");
    if (eq > 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    else if (bools.has(k)) v = true;
    else { v = argv[++i]; if (v === undefined) throw new Error(`--${k} needs a value`); }
    if (many.has(k)) (o[k] ??= []).push(v); else o[k] = v;
  }
  return { pos, o };
}
const text = (v) => (typeof v === "string" && v.startsWith("@") ? fs.readFileSync(v.slice(1), "utf8") : v);
function header(s) {
  const i = String(s).indexOf(":");
  if (i <= 0) throw new Error(`A header is "Name: value", got: ${s}`);
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}
const headerSet = (list) => (list?.length ? Object.fromEntries(list.map(header)) : undefined);
const num = (v, name) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isFinite(n)) throw new Error(`--${name} wants a number`); return n; };
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const qs = (o) => new URLSearchParams(strip(o)).toString();
const id = (pos, what) => { if (!pos[1]) throw new Error(`usage: bp net ${what} <id>`); return pos[1]; };

// Edits shared by `replay`, `rule add` and `continue`.
function edits(o) {
  return strip({
    method: o.method, url: o.url, body: o.body !== undefined ? text(o.body) : undefined, status: num(o.status, "status"),
    headers: o["set-header"] || o["remove-header"] ? strip({ set: headerSet(o["set-header"]), remove: o["remove-header"] }) : undefined,
  });
}

export async function run(argv, api) {
  const args = argv[0] === "net" ? argv.slice(1) : argv;
  const { pos, o } = parse(args);
  const cmd = pos[0];
  switch (cmd) {
    case undefined: case "help": return void process.stdout.write(`${USAGE}\n`);
    case "ls": case "list": {
      const r = await api(`/net/requests?${qs({ type: o.type, q: o.q, domain: o.domain, status: o.status, method: o.method, limit: o.limit, since: o.since, tab: o.tab })}`);
      return out({ last: r.last, count: r.count, shown: r.requests.length, requests: r.requests.map(({ tab: _t, seq: _s, ...x }) => x) });
    }
    case "show": {
      const max = o.full ? FULL : num(o.max, "max") ?? SHOW_MAX;
      return out(await api(`/net/request?${qs({ id: id(pos, "show"), body: o.body ? 1 : undefined, response: o.response ? 1 : undefined, max })}`));
    }
    case "replay": {
      const max = o.full ? FULL : num(o.max, "max") ?? SHOW_MAX;
      if (!pos[1] && !o.url) throw new Error("usage: bp net replay <id> [edits], or bp net replay --url U [--method M] ...");
      const e = edits(o);
      return out(await api("/net/replay", strip({ id: pos[1], method: e.method, url: e.url, body: e.body,
        headers: headerSet(o.header ?? o["set-header"]), removeHeaders: o["remove-header"], mode: o.direct ? "direct" : "page", max })));
    }
    case "wait": {
      if (!pos[1]) throw new Error("usage: bp net wait <url-pattern> [--method M] [--timeout s]");
      const r = await api("/net/wait", strip({ pattern: pos[1], method: o.method, status: o.status, since: num(o.since, "since"),
        timeoutMs: Math.round((num(o.timeout, "timeout") ?? 30) * 1000) }));
      return out(r.request);
    }
    case "rule": {
      const sub = pos[1];
      if (sub === "ls" || sub === "list") return out(await api("/net/rules"));
      if (sub === "rm" || sub === "remove") {
        if (o.all) return out(await api("/net/rules/remove", { all: true }));
        if (!pos[2]) throw new Error("usage: bp net rule rm <id> | --all");
        return out(await api("/net/rules/remove", { id: pos[2] }));
      }
      if (sub === "add") {
        if (!pos[2]) throw new Error("usage: bp net rule add <url-pattern> [...]");
        const e = edits(o);
        const type = o.type ? TYPES[String(o.type).toLowerCase()] ?? o.type : undefined;
        const r = await api("/net/rules", strip({ pattern: pos[2], stage: o.stage === "response" ? "response" : "request", action: o.pause ? "pause" : "modify",
          method: o["only-method"], resourceType: type, set: Object.keys(e).length ? e : undefined, times: num(o.times, "times"),
          ttlSec: num(o.ttl, "ttl"), tab: o.tab }));
        return out({ id: r.id, rule: r.rule });
      }
      throw new Error("usage: bp net rule add|ls|rm ...");
    }
    case "paused": return out((await api(`/net/paused?${qs({ max: o.full ? FULL : num(o.max, "max") ?? SHOW_MAX })}`)).paused);
    case "continue": return out(await api("/net/paused/continue", { id: id(pos, "continue"), ...edits(o) }));
    case "drop": return out(await api("/net/paused/drop", { id: id(pos, "drop") }));
  }
  throw new Error(`Unknown: bp net ${cmd}\n${USAGE}`);
}
