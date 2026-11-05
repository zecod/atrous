// Runner for Settings > Skills (skills.js). Plain Node, not a mod module: skills.js starts it as a
// background atrous-core terminal, since installing a skill (npx fetching the CLI, cloning the repo)
// can take longer than exec's 30 s:
//
//   atc run --bg --rm --json --no-parent --no-notify -- node skills-run.mjs <job.json> --home <dir> [--no-telemetry] -- <skills args...>
//
// Runs `npx -y skills <args>` with its output piped (so the CLI never waits for a prompt), writes
// everything it prints to <job>.log, and keeps <job.json> up to date for the page to poll:
//   { state: "running", line }                       line: the CLI's latest step ("Cloning repository")
//   { state: "done" | "error", code, result?, error?, ms }   result: the CLI's --json output, parsed
// --home: the user folder the page lists skills from (Atrous's home()). The CLI puts global skills
// under os.homedir(), which comes from USERPROFILE (Windows) / HOME; atrous-core starts terminals
// with its own idea of those, so they are set here and the install lands where the page looks.
// --no-telemetry sets DISABLE_TELEMETRY=1 (Settings always passes it: Atrous has no telemetry); otherwise the CLI reports
// the install to skills.sh, which is where its install counts come from.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep < 0 ? argv : argv.slice(0, sep);
const args = sep < 0 ? [] : argv.slice(sep + 1);
let jobPath = null;
let noTelemetry = false;
let home = null;
for (let i = 0; i < own.length; i++) {
  if (own[i] === "--no-telemetry") noTelemetry = true;
  else if (own[i] === "--home") home = own[++i] ? resolve(own[i]) : null;
  else if (!jobPath) jobPath = own[i];
}
const LIMIT = 5 * 60_000;
const win = process.platform === "win32";

if (!jobPath || !args.length) {
  console.error("usage: node skills-run.mjs <job.json> [--home <dir>] [--no-telemetry] -- <skills args...>");
  process.exit(2);
}
const logPath = jobPath.replace(/\.json$/, "") + ".log";

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function writeAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

let writing = Promise.resolve();
function update(fields) {
  writing = writing.then(async () => {
    const job = (await readJson(jobPath)) ?? {};
    await writeAtomic(jobPath, { ...job, ...fields });
  }).catch(() => {});
  return writing;
}

async function finish(fields) {
  await update({ ...fields, finished: Date.now() });
}

// A shell is needed for npx.cmd on Windows, so only plain arguments are passed through.
if (!args.every((a) => /^[\w@.:/*+=-]+$/.test(a))) {
  await finish({ state: "error", code: 2, error: "Refused an argument with unexpected characters." });
  process.exit(2);
}
// The skills CLI needs Node 22.20 or newer.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 20)) {
  await appendFile(logPath, `Node ${process.versions.node} at ${process.execPath}\n`).catch(() => {});
  await finish({ state: "error", code: 2, error: `The skills CLI needs Node 22.20 or newer; this is Node ${process.versions.node}.` });
  process.exit(2);
}
// The npx beside this Node (same version, and found even where PATH differs), else PATH's.
const sibling = join(dirname(process.execPath), win ? "npx.cmd" : "npx");
const NPX = existsSync(sibling) ? sibling : "npx";

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
// The CLI draws with clack: "│", "◇  Cloning repository", "└  Done". A step is the text after the mark.
const step = (l) => l.replace(/^[\s│┃|◇◆●○■□▲△◒◐◓◑└┌├─╮╯╰╭]+/u, "").replace(/[\s│╮╯─]+$/u, "").trim();

const started = Date.now();
const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
if (noTelemetry) env.DISABLE_TELEMETRY = "1";
if (home) {
  env.HOME = home;
  if (win) env.USERPROFILE = home;
}
const where = home ?? homedir();
const cmdline = `${noTelemetry ? "DISABLE_TELEMETRY=1 " : ""}npx -y skills ${args.join(" ")}`;
await appendFile(logPath, `$ ${cmdline}\n(home: ${where}; npx: ${NPX}; node ${process.versions.node})\n\n`).catch(() => {});
await update({ state: "running", line: args[0] === "add" ? "Fetching the skill…" : "Running the skills CLI…", pid: process.pid, home: where });
console.log(`$ ${cmdline}`);

// Through cmd.exe on Windows (npx is a .cmd), quoted for a folder like "C:\Program Files\nodejs".
const child = spawn(win && NPX !== "npx" ? `"${NPX}"` : NPX, ["-y", "skills", ...args], { shell: win, windowsHide: true, env, cwd: where });
let stdout = "";
let tail = "";
let line = "";
let lastWrite = 0;
let flushTimer = null;
let late = false;

function take(chunk, isErr) {
  const text = chunk.toString("utf8");
  if (!isErr) stdout += text;
  process.stdout.write(text);
  const clean = text.replace(ANSI, "").replace(/\r(?!\n)/g, "\n");
  appendFile(logPath, clean).catch(() => {});
  tail = (tail + clean).slice(-6000);
  for (const l of clean.split(/\r?\n/)) {
    const s = step(l);
    // Not the --json output's own lines ([, {, "name": ..., }).
    if (s && !/^[[\]{}",:]/.test(s)) line = s.slice(0, 120);
  }
  // At most every 400 ms, and the last step once the output pauses.
  if (flushTimer) return;
  const wait = Math.max(0, 400 - (Date.now() - lastWrite));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    lastWrite = Date.now();
    if (line) update({ line });
  }, wait);
}

child.stdout.on("data", (d) => take(d, false));
child.stderr.on("data", (d) => take(d, true));

const timer = setTimeout(() => {
  late = true;
  // With a shell on Windows, child.kill() would stop only cmd.exe and leave npx running.
  if (win && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill();
}, LIMIT);

const code = await new Promise((resolve) => {
  child.on("error", (e) => { tail += `\n${e.message}`; resolve(-1); });
  child.on("close", (c) => resolve(c ?? -1));
});
clearTimeout(timer);
clearTimeout(flushTimer);

let result = null;
try {
  const s = stdout.trim();
  const at = s.search(/^[[{]/m);
  if (at >= 0) result = JSON.parse(s.slice(at));
} catch {}

const rows = Array.isArray(result) ? result : [];
const failed = rows.some((r) => r?.status && !/^(installed|updated|skipped|unchanged)$/.test(r.status));
const ok = code === 0 && !late && !failed;

// Why it failed, in the CLI's words: its JSON (`reason` / `error`), else its own error lines
// (clack marks them ■), else the last lines it printed that aren't JSON.
function why() {
  if (late) return "It took more than 5 minutes and was stopped.";
  const fromJson = [...rows.map((r) => r?.reason ?? r?.error), result && !Array.isArray(result) ? result.error ?? result.message : null]
    .filter((x) => typeof x === "string" && x.trim());
  if (fromJson.length) return [...new Set(fromJson)].join("; ");
  const lines = tail.split(/\r?\n/);
  const marked = lines.filter((l) => /^\s*[■▲✖×]/u.test(l)).map(step).filter(Boolean);
  if (marked.length) return [...new Set(marked)].slice(-2).join(" ");
  const plain = lines.map(step).filter((l) => l && !/^[[\]{}",:]/.test(l) && !/^(Done!?|\$ .*)$/.test(l));
  return plain.slice(-2).join(" ") || `npx exited with code ${code}.`;
}

await appendFile(logPath, `\n[exit ${code}${late ? ", stopped after 5 minutes" : ""}]\n`).catch(() => {});
await finish({
  state: ok ? "done" : "error",
  code,
  result,
  line: ok ? line : null,
  error: ok ? null : why(),
  ms: Date.now() - started,
});
process.exit(ok ? 0 : 1);
