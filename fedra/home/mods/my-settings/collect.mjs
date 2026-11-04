// Collector for the Usage & activity page (usage.js). Plain Node, not a mod module: usage.js starts it as a
// background herdr-core terminal (`hc run --bg --rm -- node collect.mjs <dir> <id> [--full]`),
// since reading every Claude Code / Codex log can take minutes on a busy disk, past exec's 30 s.
//
// Runs `ccusage daily --json --by-agent` (all agents ccusage detects: Claude Code, Codex,
// opencode, Gemini, ...) and merges a compact per-day, per-agent, per-model summary into
// <dir>/ccusage.json, then marks <dir>/job.json done or failed.
// - The first run, one a week, and `--full` read every log. Other runs pass `--since` the day
//   before the last update: ccusage then skips older log files (seconds instead of minutes),
//   and the older days come from the saved summary.
// - Days Claude Code or Codex have since cleaned from their logs stay: for each day and agent,
//   the bigger total wins.
// - Other accounts (Settings > Accounts) are counted without CLAUDE_CONFIG_DIR / CODEX_HOME: their
//   folders link projects/ and sessions/ to ~/.claude and ~/.codex (accounts/profile.mjs), so their
//   logs are already where ccusage looks. Passing those folders too would count them twice.

import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

const [dir, id] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!dir) {
  console.error("usage: node collect.mjs <out dir> [job id] [--full]");
  process.exit(2);
}

const BASE = ["daily", "--json", "--by-agent"];
const FULL_EVERY = 7 * 86400_000;
const BUDGET = { full: 9 * 60_000, recent: 3 * 60_000 }; // main.js gives up a minute later
const win = process.platform === "win32";

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

function killTree(child) {
  // With a shell on Windows, child.kill() would only stop cmd.exe and leave ccusage running.
  if (win && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill();
}

function runOnce(cmd, args, ms) {
  return new Promise((resolve) => {
    // .cmd shims (npx.cmd, ccusage.cmd) need a shell on Windows; the arguments are constants.
    const child = spawn(cmd, args, { shell: win, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
    const out = [];
    let err = "";
    let late = false;
    const timer = setTimeout(() => { late = true; killTree(child); }, Math.max(1000, ms));
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: String(e.message) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: late ? `timed out after ${Math.round(ms / 1000)} s` : err });
    });
  });
}

const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const int = (n) => Math.round(Number(n) || 0);

// ccusage's unified rows -> { "2026-11-04": { claude: { i, o, cw, cr, c, m: { model: [i, o, cw, cr, c] } } } }
function compact(report) {
  const days = {};
  for (const row of report.daily ?? []) {
    const date = row.period ?? row.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) continue;
    const agents = row.agents?.length ? row.agents : [{ ...row, agent: row.agent && row.agent !== "all" ? row.agent : "claude" }];
    const day = (days[date] ??= {});
    for (const a of agents) {
      const m = {};
      for (const b of a.modelBreakdowns ?? []) {
        m[b.modelName ?? "unknown"] = [int(b.inputTokens), int(b.outputTokens), int(b.cacheCreationTokens), int(b.cacheReadTokens), round(b.cost)];
      }
      day[a.agent] = { i: int(a.inputTokens), o: int(a.outputTokens), cw: int(a.cacheCreationTokens), cr: int(a.cacheReadTokens), c: round(a.totalCost ?? a.costUSD), m };
    }
  }
  return days;
}

const total = (e) => (e ? e.i + e.o + e.cw + e.cr : 0);

function merge(old, now) {
  const days = { ...now };
  for (const [date, agents] of Object.entries(old ?? {})) {
    const day = (days[date] = { ...(days[date] ?? {}) });
    for (const [agent, e] of Object.entries(agents)) {
      if (total(e) > total(day[agent])) day[agent] = e;
    }
  }
  return Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function writeAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

async function finish(fields) {
  const jobPath = join(dir, "job.json");
  const job = (await readJson(jobPath)) ?? {};
  await writeAtomic(jobPath, { ...job, id: id ?? job.id, ...fields, finished: Date.now() });
}

const started = Date.now();
await mkdir(dir, { recursive: true });
const path = join(dir, "ccusage.json");
const old = await readJson(path);
const full = process.argv.includes("--full") || !old?.days || !old.full || started - old.full > FULL_EVERY;
const since = full ? null : ymd(new Date(new Date(old.updated).getTime() - 86400_000));
const ARGS = since ? [...BASE, "--since", since] : BASE;
const deadline = started + (full ? BUDGET.full : BUDGET.recent);
// A global `ccusage` first (no registry round trip), then npx's cache, then bun's.
const RUNNERS = [
  ["ccusage", ARGS],
  ["npx", ["-y", "ccusage@latest", ...ARGS]],
  ["bunx", ["ccusage@latest", ...ARGS]],
];

let failure = "ccusage didn't run";
for (const [cmd, args] of RUNNERS) {
  const left = deadline - Date.now();
  if (left < 5000) break;
  const r = await runOnce(cmd, args, left);
  let report = null;
  try { report = r.code === 0 ? JSON.parse(r.stdout) : null; } catch {}
  if (!Array.isArray(report?.daily)) {
    const why = (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
    // A missing global ccusage isn't worth reporting; the next runner is the real attempt.
    if (cmd !== "ccusage") failure = `${cmd} ${args.slice(0, 2).join(" ")}: ${why || `exit code ${r.code}`}`;
    continue;
  }
  const days = merge(old?.days, compact(report));
  const runner = [cmd, ...args.filter((a) => !BASE.includes(a))].join(" ");
  const now = Date.now();
  await writeAtomic(path, { v: 1, updated: now, full: full ? now : old.full, since, ms: now - started, runner, days });
  await finish({ state: "done", ms: now - started, runner, full });
  process.exit(0);
}
await finish({ state: "error", ms: Date.now() - started, error: failure });
process.exit(1);
