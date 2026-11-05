// Which Claude Code session an agent runs, so its subagents can hang under it on the canvas.
// A trimmed copy of my-spaces/speed.js's linking (mods can't import across folders):
//   terminal.pid (the shell atrous-core started)
//     -> a descendant process with a ~/.claude/sessions/<pid>.json file (one process listing,
//        shared for 5 s, cached per terminal pid)
//     -> its sessionId and cwd -> ~/.claude/projects/<cwd, non-alphanumerics as "-">/<sessionId>
// Without a process listing: the one session file started in the terminal's folder, else the one
// whose statusUpdatedAt equals atc's status_ms for the terminal. (speed.js also tries the session
// title; left out here: an ambiguous folder just shows no subagents.)
// Local machine only.

import { exec, core, home } from "atrous";
import * as fs from "fs/promises";

const HOME = home().replace(/\\/g, "/").replace(/\/$/, "");
const WIN = /^[A-Za-z]:/.test(HOME);
const CLAUDE = `${HOME}/.claude`;

const links = new Map(); // terminal pid -> { pid: claude pid }
let plist = null; // { at, promise }

const normPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const slug = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, "-");

async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return null; }
}

/** A Claude Code agent's session folder (where Claude keeps subagents/), or null. */
export async function claudeSessionDir(agent, terminal) {
  if (!agent || !terminal || String(terminal.address ?? agent.address).includes("/")) return null;
  const app = `${agent.app ?? ""} ${terminal.report?.app ?? ""} ${agent.program?.key ?? ""}`.toLowerCase();
  if (!app.includes("claude")) return null;
  const info = await claudeLink(terminal).catch(() => null);
  return info?.sessionId && info.cwd ? `${CLAUDE}/projects/${slug(info.cwd)}/${info.sessionId}` : null;
}

async function claudeLink(terminal) {
  const tpid = terminal.pid;
  const cached = links.get(tpid);
  if (cached) {
    const info = await readJson(`${CLAUDE}/sessions/${cached.pid}.json`);
    if (info?.sessionId && info.pid === cached.pid) return info;
    links.delete(tpid); // claude restarted in that shell, or exited
  }
  let names = [];
  try { names = await fs.readdir(`${CLAUDE}/sessions`); } catch { return null; }
  const withFile = new Set(names.filter((n) => /^\d+\.json$/.test(n)).map((n) => Number(n.slice(0, -5))));

  // 1. Process tree: the claude process running under this terminal's shell.
  const procs = tpid ? await processList() : null;
  if (procs && procs.has(tpid)) {
    const below = descendants(procs, tpid).filter((p) => withFile.has(p.pid)).sort((a, b) => b.created - a.created);
    for (const p of below) {
      const info = await readJson(`${CLAUDE}/sessions/${p.pid}.json`);
      if (info?.sessionId) { links.set(tpid, { pid: p.pid }); return info; }
    }
    return null;
  }

  // 2. Session files started in this terminal's folder; several: the status time atc has.
  const cwd = normPath(terminal.cwd);
  const cands = [];
  for (const pid of withFile) {
    const info = await readJson(`${CLAUDE}/sessions/${pid}.json`);
    if (info?.sessionId && normPath(info.cwd) === cwd) cands.push(info);
  }
  if (cands.length === 1) return cands[0];
  if (!cands.length) return null;
  try {
    const ms = JSON.parse((await core(["get", String(terminal.address), "--json"])).stdout).status_ms;
    const same = ms ? cands.filter((c) => Math.abs((c.statusUpdatedAt ?? 0) - ms) <= 1000) : [];
    if (same.length === 1) return same[0];
  } catch {}
  return null;
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

/** Base64 of a string's UTF-8 bytes (Windows mangles quotes in program arguments). */
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
