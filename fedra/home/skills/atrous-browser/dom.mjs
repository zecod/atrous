// dom.mjs: the page's live HTML and its storage, for `bp` (bp.mjs next to this file; see dom.md).
//
//   bp dom query|html|set|rm|picked ...    bp cookies ls|set|rm|clear ...
//   bp local|session ls|get|set|rm|clear ...    bp idb ls|read|put|rm|clear ...
//
// run(argv, api): argv starts with the group word; api(path, body?) calls the Browser panel's
// helper (devtools-dom.mjs in the browser-panel mod) and returns its JSON or throws.
// Prints compact JSON on stdout; long strings are cut unless --full. Errors are thrown (bp prints
// them on stderr and exits 1).

import fs from "node:fs";

const LIMITS = { html: 4000 }; // characters shown without --full, by field; others: DEFAULT
const DEFAULT = 300;

const USAGE = {
  dom: `bp dom query <selector> [--limit n]
bp dom html [<selector>] [--all] [--picked] [--node id]
bp dom set <selector> (--html <text|@file> | --inner <text|@file> | --text <t>) [--attr k=v]... [--rm-attr k]... [--all] [--node id]
bp dom rm <selector> [--all] [--node id]
bp dom picked`,
  cookies: `bp cookies ls [--url U]
bp cookies set <name> <value|@file> [--domain d] [--path p] [--expires date|epoch|7d|2h|30m] [--http-only] [--secure] [--same-site Lax|Strict|None] [--url U]
bp cookies rm <name> [--domain d] [--path p] [--url U]
bp cookies clear [--url U]`,
  local: `bp local ls [--origin O] | get <key> | set <key> <value|@file> | rm <key> | clear`,
  session: `bp session ls [--origin O] | get <key> | set <key> <value|@file> | rm <key> | clear`,
  idb: `bp idb ls
bp idb read <db> <store> [--limit n] [--skip n] [--index name]
bp idb put <db> <store> <json|@file> [--key k]
bp idb rm <db> <store> <key>
bp idb clear <db> <store>`,
};

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
}
function opt(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
function many(argv, name) {
  const out = [];
  for (let v = opt(argv, name); v !== null; v = opt(argv, name)) out.push(v);
  return out;
}
const text = (v) => (typeof v === "string" && v.startsWith("@") && v.length > 1 ? fs.readFileSync(v.slice(1), "utf8") : v);
// A key or value as JSON when it parses (5, [1,"a"], "\"5\"", {"a":1}), else the text itself.
const json = (v) => { try { return JSON.parse(v); } catch { return v; } };
const q = (o) => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== false).map(([k, v]) => [k, String(v)])).toString(); return s ? `?${s}` : ""; };

// --expires: a date, epoch seconds, or from now: 30m, 2h, 7d, 1y.
function expires(v) {
  if (v === null) return undefined;
  const rel = /^(\d+(?:\.\d+)?)([smhdwy])$/i.exec(v);
  if (rel) return Math.round(Date.now() / 1000 + Number(rel[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }[rel[2].toLowerCase()]);
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`--expires: a date (2027-01-31), epoch seconds, or 30m / 2h / 7d / 1y; got ${v}`);
  return ms / 1000;
}

function shorten(v, key) {
  if (typeof v === "string") {
    const max = LIMITS[key] ?? DEFAULT;
    return v.length > max ? `${v.slice(0, max)}…(+${v.length - max} chars; --full for all)` : v;
  }
  if (Array.isArray(v)) return v.map((x) => shorten(x, key));
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = shorten(x, k); return o; }
  return v;
}

function need(argv, n, group) {
  if (argv.length < n) throw new Error(`Missing arguments. Usage:\n${USAGE[group]}`);
}

export async function run(argv, api0) {
  // A helper started before these routes existed answers "Unknown /dom/..." or "POST please".
  const api = async (p, body) => {
    try { return await api0(p, body); }
    catch (e) {
      if (/^Unknown (GET |POST )?\/(dom|storage)\/|^POST please/.test(String(e?.message))) {
        throw new Error("The Browser panel's helper is older than the page and storage commands: restart it (in the panel's debug drawer, Elements tab: Restart the helper; pages and tabs stay open)");
      }
      throw e;
    }
  };
  argv = [...argv];
  const group = argv.shift();
  const full = flag(argv, "--full");
  const out = (v) => { const { ok, ...rest } = v ?? {}; process.stdout.write(`${JSON.stringify(full ? rest : shorten(rest))}\n`); };
  const cmd = argv.shift();
  if (!cmd || cmd === "help" || cmd === "--help") { process.stdout.write(`${USAGE[group] ?? Object.values(USAGE).join("\n")}\n`); return; }

  if (group === "dom") {
    const node = opt(argv, "--node");
    const all = flag(argv, "--all");
    const target = () => (node ? { nodeId: Number(node) } : (need(argv, 1, "dom"), { selector: argv[0] }));
    switch (cmd) {
      case "query": case "q": {
        const limit = opt(argv, "--limit");
        need(argv, 1, "dom");
        return out(await api("/dom/query", { selector: argv[0], limit: limit ? Number(limit) : undefined }));
      }
      case "html": {
        if (flag(argv, "--picked")) return out(await api(`/dom/html${q({ picked: 1 })}`));
        return out(await api(`/dom/html${q({ selector: argv[0], nodeId: node, all: all ? 1 : null })}`));
      }
      case "set": {
        const html = opt(argv, "--html"), inner = opt(argv, "--inner"), txt = opt(argv, "--text");
        const set = {}, remove = many(argv, "--rm-attr");
        for (const a of many(argv, "--attr")) {
          const i = a.indexOf("=");
          if (i < 1) throw new Error(`--attr wants name=value, got ${a}`);
          set[a.slice(0, i)] = a.slice(i + 1);
        }
        const body = { ...target(), all };
        if (html !== null) body.outerHTML = text(html);
        if (inner !== null) body.innerHTML = text(inner);
        if (txt !== null) body.text = text(txt);
        if (Object.keys(set).length || remove.length) body.attributes = { set, remove };
        return out(await api("/dom/set", body));
      }
      case "rm": case "remove": return out(await api("/dom/remove", { ...target(), all }));
      case "picked": return out(await api("/dom/picked"));
    }
  }

  if (group === "cookies") {
    const url = opt(argv, "--url");
    switch (cmd) {
      case "ls": case "list": return out(await api(`/storage/cookies${q({ url })}`));
      case "set": {
        const domain = opt(argv, "--domain"), path = opt(argv, "--path"), exp = expires(opt(argv, "--expires")), sameSite = opt(argv, "--same-site");
        const httpOnly = flag(argv, "--http-only"), secure = flag(argv, "--secure");
        need(argv, 2, "cookies");
        return out(await api("/storage/cookies/set", { name: argv[0], value: text(argv[1]), domain, path, expires: exp, httpOnly, secure, sameSite, url }));
      }
      case "rm": case "delete": {
        const domain = opt(argv, "--domain"), path = opt(argv, "--path");
        need(argv, 1, "cookies");
        return out(await api("/storage/cookies/delete", { name: argv[0], domain, path, url }));
      }
      case "clear": return out(await api("/storage/cookies/clear", { url }));
    }
  }

  if (group === "local" || group === "session") {
    const origin = opt(argv, "--origin");
    const base = `/storage/${group}`;
    switch (cmd) {
      case "ls": case "list": return out(await api(`${base}${q({ origin })}`));
      case "get": need(argv, 1, group); return out(await api(`${base}${q({ origin, key: argv[0] })}`));
      case "set": need(argv, 2, group); return out(await api(`${base}/set`, { key: argv[0], value: text(argv[1]), origin }));
      case "rm": case "remove": need(argv, 1, group); return out(await api(`${base}/remove`, { key: argv[0], origin }));
      case "clear": return out(await api(`${base}/clear`, { origin }));
    }
  }

  if (group === "idb") {
    switch (cmd) {
      case "ls": case "list": return out(await api("/storage/idb"));
      case "read": {
        const limit = opt(argv, "--limit"), skip = opt(argv, "--skip"), index = opt(argv, "--index");
        need(argv, 2, "idb");
        return out(await api(`/storage/idb/data${q({ db: argv[0], store: argv[1], limit, skip, index })}`));
      }
      case "put": {
        const key = opt(argv, "--key");
        need(argv, 3, "idb");
        const raw = text(argv[2]);
        return out(await api("/storage/idb/put", { db: argv[0], store: argv[1], value: json(raw), key: key === null ? undefined : json(key) }));
      }
      case "rm": case "delete": need(argv, 3, "idb"); return out(await api("/storage/idb/delete", { db: argv[0], store: argv[1], key: json(argv[2]) }));
      case "clear": need(argv, 2, "idb"); return out(await api("/storage/idb/clear", { db: argv[0], store: argv[1] }));
    }
  }

  throw new Error(`Unknown command: ${group} ${cmd}\n${USAGE[group] ?? Object.values(USAGE).join("\n")}`);
}
