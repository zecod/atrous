// Offline CLI fixture: real child processes and hooks, no credentials or model requests.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("--help")) { console.log("--no-daemon"); process.exit(0); }
if (args.includes("--version")) { console.log("2.1.318 (Claude Code)"); process.exit(0); }
const env = process.env, tool = env.FIXTURE_TOOL, root = env.FIXTURE_ROOT;
const home = env[tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"];
const resumed = args.includes(tool === "codex" ? "resume" : "--resume");
const id = "019a0000-0000-7000-8000-000000000001", other = "019a0000-0000-7000-8000-000000000002";
const record = row => fs.appendFile(path.join(root, "runs.jsonl"), JSON.stringify(row) + "\n");
await record({ type: "start", home, args, resumed });
const hard = env.FIXTURE_MODE !== "transient";
const message = hard ? "You've hit your usage limit. Try again later." : "Rate limit reached, retry shortly";
if (tool === "codex") {
  const dir = path.join(home, "sessions", "2026", "11", "06");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `rollout-fixture-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, source: "cli", cwd: process.cwd() } }) + "\n");
  const log = args.find(a => a.startsWith("log_dir="));
  if (log) {
    const line = (session, text) => `2026-11-06T12:00:00Z INFO session_loop{thread_id=${session}}: codex_core::session${text === "new" ? "" : "::turn"}: ${text}\n`;
    await fs.writeFile(path.join(JSON.parse(log.slice(8)), "codex-tui.log"), line(other, "new") + line(other, "Turn error: You've hit your usage limit.") + line(id, "new") + (resumed || env.FIXTURE_MODE === "manual" ? "" : line(id, `Turn error: ${message}`)));
  }
} else {
  const transcript = path.join(home, "projects", "fixture", `${id}.jsonl`);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, JSON.stringify({ type: "assistant", sessionId: id, error: "rate_limit", isApiErrorMessage: true, message: { content: [{ type: "text", text: message }] } }) + "\n");
  const file = args[args.indexOf("--settings") + 1];
  if (file) {
    const settings = JSON.parse(await fs.readFile(file, "utf8"));
    await record({ type: "settings", preserved: settings.fixture, hooks: settings.hooks.SessionStart.length });
    for (const event of ["SessionStart", ...(resumed || env.FIXTURE_MODE === "manual" ? [] : ["StopFailure"])]) {
      const hook = settings.hooks[event].at(-1).hooks[0];
      const result = spawnSync(hook.command, hook.args, { env, input: JSON.stringify({ hook_event_name: event, session_id: id, cwd: process.cwd(), transcript_path: transcript, error: "rate_limit", error_details: message }), encoding: "utf8", windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr);
    }
  }
}
if (!resumed && !["manual", "transient", "unavailable", "disabled"].includes(env.FIXTURE_MODE)) {
  for (let i = 0; i < 150; i++) {
    try { await fs.access(path.join(root, "stop")); break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
} else await new Promise(r => setTimeout(r, 1700));
await record({ type: "exit", home });
