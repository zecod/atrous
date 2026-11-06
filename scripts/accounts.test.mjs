import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { binding, chooseAccount, quotaMessage, codexRecord, claudeRecord, claudeQuotaRecord, resumeArgs, CONTINUE, FRESH_MS } from "../fedra/home/accounts/handoff.mjs";
import { supervise, codexSession, invocation } from "../fedra/home/accounts/launch.mjs";
const id = "019a0000-0000-7000-8000-000000000001";
const now = Date.now();
const state = () => ({ active: { codex: "paid" }, auto: { enabled: true, resume: true, threshold: 95 }, accounts: ["paid", "free", "third"].map(id => ({ tool: "codex", id })) });
const entry = pct => ({ login: "in", at: now, rows: [{ pct, resets: now + 3600_000 }] });

test("available account requires fresh verified usage and enabled resume", () => {
  const s = state(), usage = { "codex:free": entry(20), "codex:third": entry(30) };
  assert.equal(chooseAccount(s, usage, "codex", "paid", new Map(), "", now).id, "free");
  s.active.codex = "third";
  assert.equal(chooseAccount(s, usage, "codex", "paid", new Map(), "", now).id, "third");
  for (const bad of [{ stale: true }, { error: true }, { login: "out" }, { at: now - FRESH_MS - 1 }, { rows: [] }, { rows: [{ pct: null }] }, { rows: [{ pct: 100 }] }, { blocked: true }]) {
    assert.equal(chooseAccount(state(), { "codex:free": { ...entry(20), ...bad } }, "codex", "paid", new Map(), "", now), null);
  }
  for (const key of ["enabled", "resume"]) { const off = state(); off.auto[key] = false; assert.equal(chooseAccount(off, usage, "codex", "paid"), null); }
  const pending = state(); pending.accounts[1].pending = true;
  assert.equal(chooseAccount(pending, { "codex:free": entry(0) }, "codex", "paid"), null);
});

test("monthly limits bind; failed accounts cannot ping-pong before verified reset", () => {
  assert.equal(binding("codex", { rows: [{ pct: 10 }, { pct: 100, kind: "monthly" }] }, "", now).blocked, true);
  assert.equal(binding("claude", { rows: [{ pct: 100, kind: "model", label: "Opus" }, { pct: 15 }] }, "sonnet", now).pct, 15);
  assert.equal(binding("claude", { rows: [{ pct: 100, kind: "model", label: "Opus" }] }, "", now).blocked, true);
  const failed = new Map([["free", { resets: now - 1000 }]]);
  assert.equal(chooseAccount(state(), { "codex:free": entry(5) }, "codex", "paid", failed, "", now).id, "free");
  failed.set("free", { resets: null });
  assert.equal(chooseAccount(state(), { "codex:free": entry(5) }, "codex", "paid", failed), null);
});

test("only confirmed quota errors trigger; warning thresholds and generic 429 do not", () => {
  assert.equal(quotaMessage("You've hit your usage limit."), true);
  assert.equal(quotaMessage("You’ve hit your usage limit."), true);
  for (const text of ["95% used", "429 Too Many Requests", "Rate limit reached, retry shortly", "Unauthorized"]) assert.equal(quotaMessage(text), false);
  const line = text => `2026-11-06T12:00:00Z INFO session_loop{thread_id=${id}}: codex_core::session::turn: Turn error: ${text}`;
  assert.equal(codexRecord(line("You've hit your usage limit."), id).type, "quota");
  assert.equal(codexRecord(line("429 Too Many Requests"), id), null);
  assert.equal(codexRecord("tool output: " + line("You've hit your usage limit."), id), null);
  assert.equal(codexRecord(line("You've hit your usage limit."), "019a0000-0000-7000-8000-000000000002"), null);
  const failure = { hook_event_name: "StopFailure", session_id: id, error: "rate_limit", quota: true };
  assert.equal(claudeRecord(failure, id).type, "quota");
  assert.equal(claudeRecord({ ...failure, agent_id: "helper" }, id), null);
  assert.equal(claudeRecord({ ...failure, quota: false }, id), null);
  const row = { type: "assistant", sessionId: id, error: "rate_limit", isApiErrorMessage: true, message: { content: [{ type: "text", text: "You've hit your usage limit." }] } };
  assert.equal(claudeQuotaRecord(row, id), true);
  for (const bad of [{ isSidechain: true }, { agentId: "helper" }, { isApiErrorMessage: false }, { sessionId: "other" }]) assert.equal(claudeQuotaRecord({ ...row, ...bad }, id), false);
});

test("exact resume preserves permission/model argv without replaying original prompt", () => {
  const prompt = "fix security; $(do-not-run) & <secret>";
  const codex = resumeArgs("codex", ["--sandbox", "workspace-write", "--model", "fixture", prompt], id, process.cwd());
  assert.deepEqual(codex, ["--sandbox", "workspace-write", "--model", "fixture", "--cd", process.cwd(), "resume", id, CONTINUE]);
  const claude = resumeArgs("claude", ["--permission-mode", "acceptEdits", "--model", "sonnet", "--resume", id, prompt], id);
  assert.deepEqual(claude, ["--permission-mode", "acceptEdits", "--model", "sonnet", "--resume", id, CONTINUE]);
  assert.equal(resumeArgs("codex", ["exec", prompt], id), null);
  assert.equal(resumeArgs("claude", ["--print", prompt], id), null);
  assert.equal(resumeArgs("codex", ["--future-unknown-flag"], id), null);
  assert.equal(resumeArgs("codex", [], "bad-session"), null);
  assert.deepEqual(invocation("codex", "/npm/codex.ps1", [prompt], "win32").args, [prompt]);
});

test("shared account normalization copies remain identical", async () => {
  const files = await Promise.all(["accounts", "usage-card", "my-settings"].map(mod => fs.readFile(new URL(`../fedra/home/mods/${mod}/accounts-core.js`, import.meta.url), "utf8")));
  assert.equal(files[0], files[1]); assert.equal(files[0], files[2]);
});

test("Windows custom cmd launchers retain the original shell fallback", { skip: process.platform !== "win32" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atrous-custom-launcher-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "codex.cmd"), "@echo fixture-custom-launcher\r\n");
  for (const file of ["launch.ps1", "codex.ps1"]) await fs.copyFile(new URL(`../fedra/home/accounts/${file}`, import.meta.url), path.join(root, file));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  env.PATH = bin + path.delimiter + process.env.PATH;
  delete env.ATC_TERMINAL_ID;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-File", path.join(root, "codex.ps1")], { env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture-custom-launcher/);
});

async function fixture(t, tool, mode = "handoff") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atrous-handoff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const accounts = path.join(root, "accounts"), paid = path.join(accounts, "paid"), free = path.join(accounts, "free");
  const worktree = path.join(root, "existing-worktree"); await fs.mkdir(worktree);
  for (const dir of [paid, free]) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, ".atrous-account.json"), "{}"); }
  await fs.writeFile(path.join(accounts, "profile.mjs"), "process.exitCode = 0;");
  await fs.writeFile(path.join(accounts, "state.json"), JSON.stringify({ active: { [tool]: "paid" }, auto: { enabled: true, resume: mode !== "disabled" }, accounts: [{ tool, id: "paid", dir: paid }, { tool, id: "free", dir: free }] }));
  await fs.writeFile(path.join(accounts, "usage.json"), JSON.stringify({ [`${tool}:paid`]: entry(100), ...(mode === "unavailable" ? {} : { [`${tool}:free`]: entry(0) }) }));
  const env = { ...process.env, ATC_TERMINAL_ID: "fixture:1", FIXTURE_TOOL: tool, FIXTURE_ROOT: root, FIXTURE_MODE: mode, FIXTURE_CWD: worktree };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) delete env[key];
  // A key for a different provider must not disable this tool's OAuth-account handoff.
  env[tool === "codex" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"] = "unused-fixture-key";
  const labels = []; let keys = 0;
  const control = async args => { if (args[0] === "keys") { assert.equal(args[2], "ctrl+d"); keys++; await fs.writeFile(path.join(root, "stop"), ""); } else labels.push(args[2]); return { code: 0 }; };
  const args = tool === "codex" ? ["--sandbox", "workspace-write", "original task"] : ["--permission-mode", "acceptEdits", "--settings", JSON.stringify({ fixture: true, hooks: { SessionStart: [] } }), "original task"];
  const code = await supervise({ tool, args, accounts, env, interactive: true, executor: { command: process.execPath, prefix: [fileURLToPath(new URL("./fixtures/account-agent.mjs", import.meta.url))] }, control });
  const rows = (await fs.readFile(path.join(root, "runs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(code, 0);
  if (mode === "handoff") {
    const starts = rows.filter(r => r.type === "start");
    assert.equal(starts.length, 2); assert.equal(keys, 1);
    assert.equal(starts[0].home, paid); assert.equal(starts[1].home, free);
    assert.equal(starts[0].cwd, process.cwd()); assert.equal(await fs.realpath(starts[1].cwd), await fs.realpath(worktree));
    assert.equal(starts[1].args.includes(id), true); assert.equal(starts[1].args.includes("original task"), false);
    assert.equal(starts[1].args.includes(CONTINUE), true);
    assert.equal(rows.findIndex(r => r.type === "exit"), rows.findIndex(r => r.type === "start" && r.resumed) - 1);
    assert.equal(labels.some(l => l?.includes('"phase":"resumed"')), true);
    if (tool === "claude") for (const row of rows.filter(r => r.type === "settings")) assert.equal(row.preserved, true);
    if (tool === "codex") { assert.equal((await codexSession(paid, id)).id, id); assert.equal(await codexSession(paid, "bad"), null); }
  } else { assert.equal(rows.filter(r => r.type === "start").length, 1); assert.equal(keys, 0); }
}
for (const tool of ["codex", "claude"]) {
  test(`${tool}: quota resumes exact conversation after original process exits`, { timeout: 20_000 }, t => fixture(t, tool));
  for (const mode of ["manual", "transient", "unavailable", "disabled"]) test(`${tool}: ${mode} never restarts`, { timeout: 15_000 }, t => fixture(t, tool, mode));
}
