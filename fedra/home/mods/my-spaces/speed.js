// speed.js — how fast an agent generated tokens in its last finished turn.
//
//   import { lastTurnSpeed, peekSpeed, speedNeedsRefresh, formatSpeed } from "./speed.js";
//   const r = await lastTurnSpeed(agent, terminal);   // agent from agents(), terminal from terminals()
//   // r: { tps, outputTokens, modelMs, wallMs, endedAt, startedAt, calls, model,
//   //      source: "claude" | "codex", sessionId, file, link, partial } | null
//   formatSpeed(r)  // "84 tok/s"
//
// Sidebar use: in render(), show formatSpeed(peekSpeed(a.address)) for done/idle agents, and
// when speedNeedsRefresh(a, t) is true, cx.spawn(async (cx) => { await lastTurnSpeed(a, t); cx.notify(); }).
// whySpeedNull(address) tells why the last answer was null.
//
// WHICH TRANSCRIPT BELONGS TO WHICH TERMINAL (Claude Code)
// Two agents can share a folder (and even a session id), so "newest file in the folder" is wrong.
//   terminal.pid (the shell herdr-core started)
//     -> a descendant process with a ~/.claude/sessions/<pid>.json file (claude.exe; found with one
//        process listing: Get-CimInstance on Windows, ps elsewhere; cached per terminal pid)
//     -> that file's sessionId and cwd -> ~/.claude/projects/<cwd, non-alphanumerics as "-">/<sessionId>.jsonl
//   The same file has the process's own status ("idle"/"busy") and statusUpdatedAt, which is the very
//   timestamp Claude Code reports to herdr (it equals hc's status_ms). It anchors the turn: when idle,
//   the turn ended at statusUpdatedAt (the system/turn_duration entry within 10 s before it); when busy,
//   the current prompt is at statusUpdatedAt and the last finished turn is the one before it on the
//   same parentUuid chain. This keeps the right turn even when another process (a /resume of the same
//   session elsewhere) appends to the same transcript afterwards. Without a process listing it falls
//   back to session files with the terminal's cwd, then the one whose statusUpdatedAt equals hc's
//   status_ms for the terminal, then the session title (ai-title/custom-title).
//
// Codex: no per-process record exists (no pid file; ~/.codex/state_5.sqlite threads have no pid), so
// the link is guarded: a codex process must run under the terminal, and exactly one interactive
// ("source":"cli") rollout with that cwd must have been written since it started (several are
// accepted only if it is the machine's only Codex process: one process, several threads, newest wins).
// Anything else returns null.
//
// THE MATH (one turn = last real user prompt .. last assistant message of that turn)
//   Claude: assistant entries grouped by message.id (Claude Code writes one line per content block,
//     each repeating the message's usage). outputTokens = sum of each message's output_tokens.
//     A call's model time = when its last line landed - the entry before it (the prompt, or the
//     latest tool_result); tool execution and hooks therefore don't count. modelMs = sum over calls.
//   Codex: calls are token_usage_record lines (deduplicated by response_id; older rollouts:
//     token_count deltas of total_token_usage); model time = record time - the last input item
//     (user message or tool output) before the call's first output item.
//   wallMs = endedAt - startedAt (prompt time). tps = outputTokens / (modelMs / 1000).
//   Output tokens include thinking/reasoning tokens. Sub-agent (Task) calls are not counted.
//
// PERFORMANCE
//   The mod runtime's fs has no stat/open, so transcripts are read by a node helper (exec "node"):
//   it reads only the last 256 KB at an offset and reads further back (doubling, max 64 MB, each step
//   parsing only the new bytes) only while the turn's start or anchor is outside the window. Caches: (1) per agent, keyed by terminal pid + status + turn:
//   repeated calls cost nothing, and while an agent works its last finished turn is returned as is;
//   (2) per session, keyed by the process status + statusUpdatedAt (one small JSON read);
//   (3) per transcript, keyed by (file, size, mtime): the helper only stats it.
//   Cold: one process listing (~0.7-3 s, once per terminal) + one helper run (~0.3 s + parsing).
//
// Limits: local machine only (no remote spaces); CLAUDE_CONFIG_DIR / CODEX_HOME are not read here,
// but agents on other accounts (Settings > Accounts) still show: their folders link sessions/ and
// projects/ (Codex: sessions/) to ~/.claude and ~/.codex (accounts/profile.mjs);
// Codex link is a guarded heuristic; a turn split by auto-compaction is reported with partial: true.

import { exec, hc, home } from "herdr";
import * as fs from "fs/promises";

const HOME = home().replace(/\\/g, "/").replace(/\/$/, "");
const WIN = /^[A-Za-z]:/.test(HOME);
const CLAUDE = `${HOME}/.claude`;
const CODEX = `${HOME}/.codex`;
const START_BYTES = 256 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;

const memo = new Map(); // address -> { key, pid, promise, result, reason }
const links = new Map(); // terminal pid -> claude pid
const files = new Map(); // address -> { file, size, mtimeMs, anchorKey, result }
let plist = null; // { at, promise } process listing, shared for 5 s

// ---------------------------------------------------------------------------------------------
// Public API

export function lastTurnSpeed(agent, terminal, { force = false } = {}) {
  if (!agent || !terminal) return Promise.resolve(null);
  const addr = agent.address;
  const key = `${terminal.pid}|${agent.status}|${terminal.turn}`;
  const m = memo.get(addr);
  if (!force && m) {
    if (m.key === key) return m.promise;
    if (m.key === null && Date.now() < m.retryAfter) return m.promise; // just failed or unsettled: wait a bit
    // While it works or waits, its last *finished* turn is still the one we have.
    if (m.key !== null && (agent.status === "working" || agent.status === "blocked") && m.pid === terminal.pid) return m.promise;
  }
  const entry = { key, pid: terminal.pid, result: m?.result ?? null, reason: null, retryAfter: 0 };
  entry.promise = compute(agent, terminal, force).then(
    (r) => {
      entry.result = r.result ?? null;
      entry.reason = r.reason ?? null;
      // herdr said done before Claude's status file did, or the helper failed: ask again a bit later.
      if (r.unsettled || r.retry) { entry.key = null; entry.retryAfter = Date.now() + (r.retry ? 30000 : 1500); }
      return entry.result;
    },
    (e) => { entry.result = null; entry.reason = `error: ${e?.message ?? e}`; entry.key = null; entry.retryAfter = Date.now() + 30000; return null; },
  );
  memo.set(addr, entry);
  return entry.promise;
}

/** The last answer for this agent, synchronously (undefined before the first one). */
export function peekSpeed(address) {
  return memo.get(address)?.result ?? undefined;
}

/** True when lastTurnSpeed(agent, terminal) would do work (status/turn changed or never asked). */
export function speedNeedsRefresh(agent, terminal) {
  const m = memo.get(agent?.address);
  if (!m) return !!terminal;
  if (m.key === null) return Date.now() >= m.retryAfter;
  if (m.key === `${terminal?.pid}|${agent.status}|${terminal?.turn}`) return false;
  return !((agent.status === "working" || agent.status === "blocked") && m.pid === terminal?.pid);
}

/** A Claude Code agent's session folder (~/.claude/projects/<cwd slug>/<sessionId>, where Claude
 *  keeps subagents/), or null when it isn't a local Claude Code agent or can't be linked. */
export async function claudeSessionDir(agent, terminal) {
  if (!agent || !terminal || String(terminal.address ?? agent.address).includes("/")) return null;
  const app = `${agent.app ?? ""} ${terminal.report?.app ?? ""} ${agent.program?.key ?? ""}`.toLowerCase();
  if (!app.includes("claude")) return null;
  const link = await claudeLink(agent, terminal).catch(() => null);
  const info = link?.info;
  return info?.sessionId && info.cwd ? `${CLAUDE}/projects/${slug(info.cwd)}/${info.sessionId}` : null;
}

export function whySpeedNull(address) {
  return memo.get(address)?.reason ?? null;
}

export function formatSpeed(r) {
  return r && Number.isFinite(r.tps) ? `${Math.round(r.tps)} tok/s` : "";
}

export function clearSpeedCache() {
  memo.clear(); links.clear(); files.clear(); plist = null;
}

// ---------------------------------------------------------------------------------------------

const fail = (reason) => ({ result: null, reason });

async function compute(agent, terminal, force) {
  if (String(terminal.address ?? agent.address).includes("/")) return fail("agent on another machine");
  const app = `${agent.app ?? ""} ${terminal.report?.app ?? ""} ${agent.program?.key ?? ""}`.toLowerCase();
  if (app.includes("claude")) return claude(agent, terminal, force);
  if (app.includes("codex")) return codex(agent, terminal, force);
  return fail(`not Claude Code or Codex (${app.trim() || "unknown"})`);
}

async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return null; }
}

const normPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const slug = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, "-");
const cleanTitle = (s) => String(s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// ---- Claude Code ------------------------------------------------------------------------------

async function claude(agent, terminal, force) {
  const link = await claudeLink(agent, terminal);
  if (!link.info) return fail(link.reason);
  const info = link.info;
  const anchor = { t: info.statusUpdatedAt ?? info.updatedAt ?? null, state: info.status === "idle" ? "idle" : "busy" };
  // herdr may show "done" a moment before Claude rewrites its status file; don't cache that answer.
  const unsettled = (agent.status === "done" || agent.status === "idle") && anchor.state !== "idle";
  const file = `${CLAUDE}/projects/${slug(info.cwd)}/${info.sessionId}.jsonl`;
  const anchorKey = `${info.sessionId}|${anchor.state}|${anchor.t}`;
  const prev = files.get(agent.address);
  if (!force && prev && prev.anchorKey === anchorKey && prev.result) {
    return { result: prev.result, unsettled };
  }
  const r = await turnFromFile(agent.address, { kind: "claude", file, sessionId: info.sessionId, projects: `${CLAUDE}/projects` }, anchor, anchorKey, force);
  if (!r.result) return { ...r, unsettled };
  r.result.sessionId = info.sessionId;
  r.result.link = link.how;
  return { result: r.result, unsettled };
}

async function claudeLink(agent, terminal) {
  const tpid = terminal.pid;
  const cached = links.get(tpid);
  if (cached) {
    const info = await readJson(`${CLAUDE}/sessions/${cached.pid}.json`);
    if (info?.sessionId && info.pid === cached.pid) return { info, how: cached.how };
    links.delete(tpid); // claude restarted in that shell, or exited
  }
  let names = [];
  try { names = await fs.readdir(`${CLAUDE}/sessions`); } catch { return { reason: "no ~/.claude/sessions folder (Claude Code too old?)" }; }
  const withFile = new Set(names.filter((n) => /^\d+\.json$/.test(n)).map((n) => Number(n.slice(0, -5))));

  // 1. Process tree: the claude process running under this terminal's shell.
  const procs = tpid ? await processList() : null;
  if (procs && procs.has(tpid)) {
    const below = descendants(procs, tpid).filter((p) => withFile.has(p.pid)).sort((a, b) => b.created - a.created);
    for (const p of below) {
      const info = await readJson(`${CLAUDE}/sessions/${p.pid}.json`);
      if (info?.sessionId) { links.set(tpid, { pid: p.pid, how: "process" }); return { info, how: "process" }; }
    }
    return { reason: "no Claude Code process with a session file under this terminal" };
  }

  // 2. Fallback: session files started in this terminal's folder, then the session title.
  const cwd = normPath(terminal.cwd);
  const cands = [];
  for (const pid of withFile) {
    const info = await readJson(`${CLAUDE}/sessions/${pid}.json`);
    if (info?.sessionId && normPath(info.cwd) === cwd) cands.push(info);
  }
  if (cands.length === 1) return { info: cands[0], how: "cwd" };
  if (!cands.length) return { reason: "no Claude Code session file for this folder" };
  // Claude reports its status to herdr with the same timestamp it writes to its session file.
  try {
    const ms = JSON.parse((await hc(["get", String(terminal.address), "--json"])).stdout).status_ms;
    const same = ms ? cands.filter((c) => Math.abs((c.statusUpdatedAt ?? 0) - ms) <= 1000) : [];
    if (same.length === 1) return { info: same[0], how: "status-time" };
  } catch {}
  const title = cleanTitle(agent.title ?? terminal.title);
  const r = await helper({ op: "titles", files: cands.map((c) => `${CLAUDE}/projects/${slug(c.cwd)}/${c.sessionId}.jsonl`) });
  const hits = cands.filter((c, i) => title && cleanTitle(r?.titles?.[i]) === title);
  const ids = new Set(hits.map((c) => c.sessionId));
  if (ids.size === 1) return { info: hits.sort((a, b) => (b.statusUpdatedAt ?? 0) - (a.statusUpdatedAt ?? 0))[0], how: "title" };
  return { reason: "several Claude Code sessions in this folder and no process listing to tell them apart" };
}

// ---- Codex ------------------------------------------------------------------------------------

const isCodex = (p) => /^codex(\.exe)?$/i.test(p?.name ?? "");

async function codex(agent, terminal, force) {
  const procs = await processList();
  if (!procs || !procs.has(terminal.pid)) return fail("no process listing for this terminal");
  const mine = descendants(procs, terminal.pid).filter(isCodex).sort((a, b) => a.created - b.created);
  if (!mine.length) return fail("no Codex process under this terminal");
  const proc = mine[0];
  const tops = [...procs.values()].filter((p) => isCodex(p) && !isCodex(procs.get(p.ppid)));
  const dirs = [];
  for (let d = new Date(proc.created - 86400000); d.getTime() <= Date.now() + 86400000 && dirs.length < 16; d = new Date(d.getTime() + 86400000)) {
    const pad = (n) => String(n).padStart(2, "0");
    dirs.push(`${CODEX}/sessions/${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`);
  }
  const found = await helper({ op: "codex-find", dirs, cwd: terminal.cwd, sinceMs: proc.created - 2000 });
  let cands = found?.files ?? [];
  if (cands.length > 1 && tops.length === 1) cands = [cands.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]];
  if (cands.length !== 1) {
    return fail(cands.length ? "several Codex sessions in this folder: no reliable link" : "no Codex rollout for this folder since the process started");
  }
  const anchorKey = "codex";
  const r = await turnFromFile(agent.address, { kind: "codex", file: cands[0].file }, null, anchorKey, force);
  if (r.result) { r.result.sessionId = cands[0].id ?? null; r.result.link = "process+cwd"; }
  return r;
}

// ---- shared -----------------------------------------------------------------------------------

async function turnFromFile(address, target, anchor, anchorKey, force) {
  const prev = files.get(address);
  const known = !force && prev && prev.file === target.file && prev.anchorKey === anchorKey && prev.result
    ? { size: prev.size, mtimeMs: prev.mtimeMs } : null;
  const r = await helper({ op: "turn", ...target, anchor, known, startBytes: START_BYTES, maxBytes: MAX_BYTES });
  if (!r) return { ...fail("transcript helper failed (is node on PATH?)"), retry: true };
  if (r.error) return { ...fail(r.error), retry: /^helper exited/.test(r.error) };
  if (r.same) return { result: prev.result };
  if (!r.turn) return fail(r.reason ?? "no finished turn found");
  const t = r.turn;
  const result = {
    tps: t.modelMs > 0 ? t.outputTokens / (t.modelMs / 1000) : null,
    outputTokens: t.outputTokens,
    modelMs: t.modelMs,
    wallMs: t.wallMs,
    endedAt: t.endedAt,
    startedAt: t.startedAt,
    calls: t.calls,
    model: t.model ?? null,
    source: target.kind,
    sessionId: null,
    file: r.file,
    link: null,
    partial: !!t.partial,
  };
  files.set(address, { file: target.file, size: r.size, mtimeMs: r.mtimeMs, anchorKey, result });
  return { result };
}

/** One listing of every process: Map pid -> { pid, ppid, created (ms), name }. Shared for 5 s. */
function processList() {
  const now = Date.now();
  if (plist && now - plist.at < 5000) return plist.promise;
  const promise = (async () => {
    try {
      const r = WIN
        ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object { $c = 0; if ($_.CreationDate) { $c = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; '' + $_.ProcessId + ' ' + $_.ParentProcessId + ' ' + $c + ' ' + $_.Name }"])
        : await exec("ps", ["-A", "-o", "pid=,ppid=,etimes=,comm="]);
      if (r.code !== 0) return null;
      const map = new Map();
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) continue;
        const created = WIN ? Number(m[3]) : now - Number(m[3]) * 1000;
        map.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), created, name: m[4].trim().replace(/^.*[\\/]/, "") });
      }
      return map.size ? map : null;
    } catch { return null; }
  })();
  plist = { at: now, promise };
  return promise;
}

/** Processes below root (children started after their parent, so a reused pid can't adopt them). */
function descendants(procs, root) {
  const kids = new Map();
  for (const p of procs.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const out = [];
  const queue = [[root, procs.get(root)?.created ?? 0, 0]];
  while (queue.length) {
    const [pid, created, depth] = queue.shift();
    if (depth >= 6) continue;
    for (const c of kids.get(pid) ?? []) {
      if (c.pid === pid || (created && c.created && c.created + 1000 < created)) continue;
      out.push({ ...c, depth: depth + 1 });
      queue.push([c.pid, c.created, depth + 1]);
    }
  }
  return out;
}

// ---- the node helper --------------------------------------------------------------------------
// Runs as `node -e <bootstrap> <base64 source> base64 <base64 args>` (base64: nothing for a shell to
// mangle). Prints one line of JSON.

async function helper(args) {
  try {
    const r = await exec("node", ["-e", "eval(Buffer.from(process.argv[1],process.argv[2]).toString())", helperSource(), "base64", b64(JSON.stringify(args))]);
    if (r.code !== 0) return { error: `helper exited ${r.code}: ${r.stderr.slice(0, 300)}` };
    return JSON.parse(r.stdout);
  } catch (e) {
    return null;
  }
}

let helperB64 = null;
function helperSource() {
  if (!helperB64) helperB64 = b64(`(${speedHelper.toString()})(Buffer.from(process.argv[3],"base64").toString())`);
  return helperB64;
}

export function b64(str) {
  const bytes = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? A[n & 63] : "=");
  }
  return out;
}

// Runs inside node, not in the mod: keep it self-contained (it is sent as source text).
function speedHelper(argJson) {
  const fs = require("fs");
  const path = require("path");
  const a = JSON.parse(argJson);
  const print = (o) => process.stdout.write(JSON.stringify(o));
  const TS = (e) => { const t = Date.parse(e && e.timestamp); return Number.isFinite(t) ? t : null; };
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

  function readSlice(file, start, len) {
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, start); return b.subarray(0, n); } finally { fs.closeSync(fd); }
  }

  if (a.op === "titles") {
    return print({ titles: a.files.map((f) => {
      try {
        const size = fs.statSync(f).size; const n = Math.min(size, 262144);
        let ai = null, custom = null;
        for (const l of readSlice(f, size - n, n).toString("utf8").split("\n")) {
          if (!l.includes("-title\"")) continue;
          try { const j = JSON.parse(l); if (j.type === "custom-title") custom = j.customTitle || custom; if (j.type === "ai-title") ai = j.aiTitle || ai; } catch (e) {}
        }
        return custom || ai;
      } catch (e) { return null; }
    }) });
  }

  if (a.op === "codex-find") {
    const want = norm(a.cwd); const out = [];
    for (const d of a.dirs) {
      let names = []; try { names = fs.readdirSync(d); } catch (e) { continue; }
      for (const n of names) {
        if (!/^rollout-.*\.jsonl$/.test(n)) continue;
        const f = path.join(d, n); let st; try { st = fs.statSync(f); } catch (e) { continue; }
        if (st.mtimeMs < a.sinceMs) continue;
        const head = readSlice(f, 0, Math.min(st.size, 65536)).toString("utf8").split("\n")[0];
        const get = (k) => { const m = head.match(new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`)); try { return m ? JSON.parse(`"${m[1]}"`) : null; } catch (e) { return null; } };
        if (!head.includes("\"session_meta\"") || get("source") !== "cli" || norm(get("cwd")) !== want) continue;
        out.push({ file: f, mtimeMs: st.mtimeMs, id: get("id") });
      }
    }
    return print({ files: out });
  }

  // op "turn"
  let file = a.file;
  if (a.kind === "claude" && !fs.existsSync(file) && a.projects) {
    // Long folder names get a hashed slug: look for the session in every project folder.
    try { for (const d of fs.readdirSync(a.projects)) { const f = path.join(a.projects, d, `${a.sessionId}.jsonl`); if (fs.existsSync(f)) { file = f; break; } } } catch (e) {}
  }
  let st; try { st = fs.statSync(file); } catch (e) { return print({ error: `no transcript ${file}` }); }
  const size = st.size, mtimeMs = Math.round(st.mtimeMs);
  if (a.known && a.known.size === size && a.known.mtimeMs === mtimeMs) return print({ same: true, size, mtimeMs, file });
  // Read backwards in growing chunks; each step parses only the new bytes (plus the line cut in two).
  let win = Math.min(size, a.startBytes || 262144), res, E = [], cut = Buffer.alloc(0), start = size;
  for (;;) {
    const from = size - win;
    let buf = Buffer.concat([readSlice(file, from, start - from), cut]);
    cut = Buffer.alloc(0);
    if (from > 0) { const nl = buf.indexOf(10); cut = nl < 0 ? buf : buf.subarray(0, nl); buf = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1); }
    const more = [];
    for (const l of buf.toString("utf8").split("\n")) { if (l) try { more.push(JSON.parse(l)); } catch (e) {} }
    E = more.concat(E);
    start = from;
    res = (a.kind === "codex" ? codexTurn : claudeTurn)(E, a.anchor, from === 0);
    if (!res.needMore || from === 0 || win >= a.maxBytes) break;
    win = Math.min(size, win * 2, a.maxBytes);
  }
  if (res.needMore) res = { reason: `turn start is more than ${a.maxBytes} bytes back` };
  return print(Object.assign(res, { size, mtimeMs, file, bytesRead: win }));

  // Pick the turn's end: near the anchor if there is one, else the last finished turn.
  function pickEnd(E, isEnd, isPrompt, parentOf, anchor, whole) {
    const t = anchor && anchor.t;
    if (t != null && !whole) { const first = E.find((e) => TS(e) != null); if (!first || TS(first) > t - 10000) return { needMore: true }; }
    const near = (pred, lo, hi) => { let best = -1, bd = Infinity; E.forEach((e, i) => { const ts = TS(e); if (pred(e) && ts != null && ts >= lo && ts <= hi && Math.abs(ts - t) < bd) { bd = Math.abs(ts - t); best = i; } }); return best; };
    if (t != null && anchor.state === "idle") { const i = near(isEnd, t - 10000, t + 3000); if (i >= 0) return { end: i, how: "anchor" }; }
    if (t != null && anchor.state !== "idle" && isPrompt && parentOf) {
      const p = near(isPrompt, t - 5000, t + 5000);
      if (p >= 0) {
        // The previous turn on this prompt's own chain.
        let i = parentOf(p);
        while (i != null && i >= 0 && !isEnd(E[i]) && !(E[i].type === "assistant" && !E[i].isSidechain)) i = parentOf(i);
        if (i === -1 && !whole) return { needMore: true };
        if (i != null && i >= 0) return { end: i, how: "anchor-prompt" };
      }
    }
    const lim = t == null ? Infinity : anchor.state === "idle" ? t + 3000 : t;
    for (let i = E.length - 1; i >= 0; i--) if (isEnd(E[i]) && TS(E[i]) <= lim) return { end: i, how: "time" };
    return whole ? { none: true } : { needMore: true };
  }

  function claudeTurn(E, anchor, whole) {
    const byUuid = new Map(); E.forEach((e, i) => { if (e.uuid) byUuid.set(e.uuid, i); });
    // parent index; -1 = parent not in this window; null = chain start
    const parentOf = (i) => { const u = E[i].parentUuid || E[i].logicalParentUuid; if (!u) return null; const j = byUuid.get(u); return j == null ? -1 : j; };
    const side = (e) => e.isSidechain === true;
    const isAsst = (e) => e.type === "assistant" && !side(e) && e.message && e.message.model !== "<synthetic>";
    const isTool = (e) => e.type === "user" && Array.isArray(e.message && e.message.content) && e.message.content.some((b) => b && b.type === "tool_result");
    const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => b.text).join("") : "";
    const isPrompt = (e) => e.type === "user" && !side(e) && !e.isMeta && !e.isCompactSummary && e.message && !isTool(e) && !/^\[Request interrupted/.test(textOf(e.message.content));
    const hasTD = E.some((x) => x.type === "system" && x.subtype === "turn_duration");
    const isEnd = (e) => (e.type === "system" && e.subtype === "turn_duration" && !side(e)) || (!hasTD && isAsst(e) && e.message.stop_reason && e.message.stop_reason !== "tool_use");
    const pick = pickEnd(E, isEnd, isPrompt, parentOf, anchor, whole);
    if (pick.needMore || pick.none) return pick.none ? { reason: "no finished turn in transcript" } : pick;
    let end = pick.end;
    while (end + 1 < E.length && isAsst(E[end]) && isAsst(E[end + 1]) && E[end + 1].message.id === E[end].message.id) end++;
    // Walk the parentUuid chain back to the prompt that started this turn.
    let i = end, start = -1, last = end; const chain = []; const seen = new Set();
    while (i != null && !seen.has(i)) {
      seen.add(i); chain.push(i); last = i;
      if (isPrompt(E[i])) { start = i; break; }
      const j = parentOf(i);
      if (j === -1) { if (!whole) return { needMore: true }; break; }
      i = j;
    }
    const first = start >= 0 ? start : last;
    // The writing process's tag (session_id): another process resuming the same session writes its own.
    const tags = new Map();
    for (const k of chain) { const s = E[k].session_id; if (s && (isAsst(E[k]) || isTool(E[k]))) tags.set(s, (tags.get(s) || 0) + 1); }
    const tag = [...tags].sort((x, y) => y[1] - x[1]).map((x) => x[0])[0] || null;
    const mine = (e) => !tag || !e.session_id || e.session_id === tag;
    const t0 = TS(E[first]);
    let lastIn = t0, model = null; const msgs = new Map();
    for (let k = first; k <= end; k++) {
      const e = E[k]; const ts = TS(e);
      if (ts == null || side(e) || !mine(e)) continue;
      if (isTool(e)) { lastIn = ts; continue; }
      if (!isAsst(e)) continue;
      const id = e.message.id || e.uuid;
      let m = msgs.get(id);
      if (!m) { m = { start: lastIn, land: ts, out: 0 }; msgs.set(id, m); model = model || e.message.model; }
      if (ts > m.land) m.land = ts;
      const o = e.message.usage && e.message.usage.output_tokens;
      if (o > m.out) m.out = o;
    }
    if (!msgs.size) return { reason: "last turn made no model calls" };
    let outputTokens = 0, modelMs = 0, endedAt = 0;
    for (const m of msgs.values()) { outputTokens += m.out; modelMs += Math.max(0, m.land - m.start); endedAt = Math.max(endedAt, m.land); }
    return { turn: { outputTokens, modelMs, wallMs: endedAt - t0, endedAt, startedAt: t0, calls: msgs.size, model, partial: start < 0, how: pick.how, tag } };
  }

  function codexTurn(E, anchor, whole) {
    const P = (e) => e.payload || {};
    const isEnd = (e) => e.type === "event_msg" && P(e).type === "task_complete";
    const pick = pickEnd(E, isEnd, null, null, anchor, whole);
    if (pick.needMore || pick.none) return pick.none ? { reason: "no finished turn in rollout" } : pick;
    const end = pick.end, turnId = P(E[end]).turn_id;
    let start = -1;
    for (let i = end; i >= 0; i--) { const p = P(E[i]); if (E[i].type === "event_msg" && p.type === "task_started" && (!turnId || p.turn_id === turnId)) { start = i; break; } }
    if (start < 0 && !whole) return { needMore: true };
    const first = start >= 0 ? start : 0;
    const isIn = (e) => { const p = P(e); if (e.type === "event_msg") return p.type === "task_started" || p.type === "user_message"; return e.type === "response_item" && (/_output$/.test(p.type || "") || (p.type === "message" && p.role !== "assistant")); };
    const isOut = (e) => e.type === "response_item" && !isIn(e);
    const records = E.slice(first, end + 1).some((e) => e.type === "token_usage_record");
    let prevTotal = null;
    if (!records) for (let i = first - 1; i >= 0; i--) { const inf = P(E[i]).info; if (P(E[i]).type === "token_count" && inf && inf.total_token_usage) { prevTotal = inf.total_token_usage.output_tokens; break; } }
    const t0 = TS(E[first]);
    let lastIn = t0, pending = null, lastOut = null, outputTokens = 0, modelMs = 0, calls = 0, endedAt = 0, model = null; const seen = new Set();
    const close = (land, tokens) => { modelMs += Math.max(0, land - (pending != null ? pending : lastIn)); outputTokens += tokens; calls++; endedAt = Math.max(endedAt, lastOut != null ? lastOut : land); pending = null; };
    for (let k = first; k <= end; k++) {
      const e = E[k], ts = TS(e), p = P(e);
      if (ts == null) continue;
      if (e.type === "turn_context" && p.model) model = p.model;
      if (isIn(e)) { lastIn = ts; continue; }
      if (isOut(e)) { if (pending == null) pending = lastIn; lastOut = ts; continue; }
      if (records && e.type === "token_usage_record") {
        if (turnId && p.turn_id && p.turn_id !== turnId && p.root_turn_id !== turnId) continue;
        const rid = p.response_id || k; if (seen.has(rid)) continue; seen.add(rid);
        close(ts, (p.usage && p.usage.output_tokens) || 0);
      } else if (!records && e.type === "event_msg" && p.type === "token_count" && p.info && p.info.total_token_usage) {
        const tot = p.info.total_token_usage.output_tokens; if (tot === prevTotal) continue;
        const d = prevTotal == null ? ((p.info.last_token_usage && p.info.last_token_usage.output_tokens) || 0) : tot - prevTotal;
        prevTotal = tot; close(lastOut != null ? lastOut : ts, d);
      }
    }
    if (!calls) return { reason: "last turn made no model calls" };
    return { turn: { outputTokens, modelMs, wallMs: endedAt - t0, endedAt, startedAt: t0, calls, model, partial: start < 0, how: pick.how } };
  }
}
