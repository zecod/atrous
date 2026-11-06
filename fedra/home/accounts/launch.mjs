// Owns only the CLI it starts. Native stdio stays attached to the terminal; no TUI proxy.
// A confirmed quota error can gracefully exit that CLI and resume its exact saved chat.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { binding, chooseAccount, claudeRecord, claudeQuotaRecord, codexRecord, quotaMessage, resumeArgs, UUID } from "./handoff.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const VAR = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const title = account => String(account.name || account.email || account.id).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120);
const readJson = async file => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } };
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };

export function invocation(tool, command, args, platform = process.platform) {
  if (platform !== "win32" || /\.exe$/i.test(command)) return { command, args };
  if (/\.(?:ps1|cmd)$/i.test(command)) {
    const root = path.dirname(command);
    // npm's known shims: invoke their actual entry points with an argv array. Passing a
    // prompt through cmd /c would interpret shell metacharacters and lose quoted arguments.
    return { npm: tool === "codex" ? path.join(root, "node_modules/@openai/codex/bin/codex.js")
      : path.join(root, "node_modules/@anthropic-ai/claude-code/bin/claude.exe"), fallback: command, args };
  }
  return { command, args };
}

async function executable(tool, command) {
  const plan = invocation(tool, command, []);
  if (!plan.npm) return { command, prefix: [] };
  if (await exists(plan.npm)) return /\.js$/i.test(plan.npm)
    ? { command: process.execPath, prefix: [plan.npm] } : { command: plan.npm, prefix: [] };
  if (/\.ps1$/i.test(command)) return { command: "powershell.exe", prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command] };
  throw new Error(`Use the ${tool} PowerShell launcher or executable instead of a cmd shim`);
}

function start(exe, args, env, cwd) {
  const child = spawn(exe.command, [...exe.prefix, ...args], { env, cwd, stdio: "inherit", windowsHide: true });
  const done = new Promise(resolve => {
    child.once("error", error => resolve({ code: 127, error }));
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  return { child, done };
}

async function capture(command, args, env = process.env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "";
    const timer = setTimeout(() => { child.kill(); resolve({ code: 124, text: "" }); }, 8000);
    child.stdout.on("data", b => { if (text.length < 100_000) text += b; });
    child.stderr.on("data", () => {});
    child.once("error", () => { clearTimeout(timer); resolve({ code: 127, text: "" }); });
    child.once("exit", code => { clearTimeout(timer); resolve({ code, text }); });
  });
}

class Lines {
  constructor(file) { this.file = file; this.offset = 0; this.partial = ""; }
  async read() {
    let handle;
    try {
      handle = await fs.open(this.file, "r");
      const stat = await handle.stat();
      if (stat.size < this.offset) { this.offset = 0; this.partial = ""; }
      const size = Math.min(4 * 1024 * 1024, stat.size - this.offset);
      if (!size) return [];
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, this.offset);
      this.offset += bytesRead;
      const lines = (this.partial + buffer.toString("utf8", 0, bytesRead)).split("\n");
      this.partial = lines.pop().slice(-2 * 1024 * 1024);
      return lines;
    } catch { return []; }
    finally { await handle?.close(); }
  }
}

// Read only the metadata of the session ID reported by this launch. Never use --last or
// select a conversation by cwd/mtime: several agents may be working in the same repository.
export async function codexSession(home, id) {
  if (!UUID.test(id)) return null;
  const matches = [];
  let visited = 0;
  async function walk(dir, depth = 0) {
    if (depth > 3 || ++visited > 4000) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.name.endsWith(`${id}.jsonl`)) matches.push(file);
    }
  }
  await walk(path.join(home, "sessions"));
  if (matches.length !== 1) return null;
  const reader = new Lines(matches[0]);
  for (const line of await reader.read()) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== "session_meta") continue;
    const meta = row.payload;
    if ((meta?.id ?? meta?.session_id) !== id || meta.source !== "cli" || !path.isAbsolute(meta.cwd ?? "")) return null;
    return { id, cwd: meta.cwd, transcript: matches[0] };
  }
  return null;
}

function settingsArgs(args, file) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--settings") { i++; continue; }
    if (args[i].startsWith("--settings=")) continue;
    result.push(args[i]);
  }
  return [...result, "--settings", file];
}

async function claudeSettings(args, dir) {
  let settings = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i] === "--settings" ? args[++i] : args[i].startsWith("--settings=") ? args[i].slice(11) : null;
    if (value === null) continue;
    settings = value.trim().startsWith("{") ? JSON.parse(value) : JSON.parse(await fs.readFile(value, "utf8"));
  }
  settings.hooks = { ...settings.hooks };
  for (const event of ["SessionStart", "UserPromptSubmit", "StopFailure"]) {
    settings.hooks[event] = [...(settings.hooks[event] ?? []), { ...(event === "StopFailure" ? { matcher: "rate_limit" } : {}), hooks: [{ type: "command", command: process.execPath, args: [SELF, "hook"], timeout: 5 }] }];
  }
  const file = path.join(dir, "claude-settings.json");
  await fs.writeFile(file, JSON.stringify(settings), { mode: 0o600 });
  return settingsArgs(args, file);
}

async function emitHook() {
  // No prompt, transcript contents, token or raw API error is persisted in the handoff event.
  const file = process.env.ATROUS_ACCOUNT_EVENTS;
  if (!file) return;
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 128_000) return; }
  let p; try { p = JSON.parse(input); } catch { return; }
  if (!UUID.test(p.session_id ?? "") || p.agent_id) return;
  const record = { hook_event_name: p.hook_event_name, session_id: p.session_id, cwd: p.cwd, transcript_path: p.transcript_path, model: p.model,
    error: p.error, quota: quotaMessage(p.last_assistant_message) || quotaMessage(p.error_details) };
  await fs.appendFile(file, JSON.stringify(record) + "\n", { mode: 0o600 });
}

async function claudeQuota(session, home) {
  if (!session?.transcript) return false;
  let handle;
  try {
    const root = await fs.realpath(path.join(home, "projects"));
    const file = await fs.realpath(session.transcript);
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    handle = await fs.open(file, "r");
    const stat = await handle.stat(), size = Math.min(256_000, stat.size);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, stat.size - size);
    const lines = buffer.toString("utf8").trim().split("\n").reverse();
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.type === "user" && !row.isMeta) return false;
      if (row.type === "assistant" && !row.isSidechain && !row.agentId) return claudeQuotaRecord(row, session.id);
    }
  } catch {}
  finally { await handle?.close(); }
  return false;
}

export async function supervise({ tool, command, args, accounts = HERE, env = process.env, interactive = Boolean(process.stdin.isTTY), executor, control }) {
  if (!VAR[tool]) throw new Error("Unknown account tool");
  const exe = executor ?? await executable(tool, command);
  const atc = env.ATC_BIN || "atc";
  const terminal = env.ATC_TERMINAL_ID;
  const core = control ?? (args => capture(atc, args, env));
  const state = () => readJson(path.join(accounts, "state.json"));
  const usage = () => readJson(path.join(accounts, "usage.json"));
  const main = env[VAR[tool]] || path.join(os.homedir(), tool === "codex" ? ".codex" : ".claude");
  const homeFor = account => account.id === "default" ? main : account.dir;
  const valid = async account => account?.id === "default" || account?.dir && await exists(path.join(account.dir, ".atrous-account.json"));
  const label = async (name, value) => {
    if (terminal) await core(["label", terminal, `${name}=${value}`]);
  };
  let st = await state();
  let account = st?.accounts?.find(a => a.tool === tool && a.id === st.active?.[tool]);
  if (account?.pending || !await valid(account)) account = { tool, id: "default" };
  const failed = new Map(), runId = randomUUID();
  let launchArgs = args, launchCwd = process.cwd(), session = null, generation = 0, stopped = false, pendingNotice = null;
  let lastRun;
  const onSignal = signal => { stopped = true; if (lastRun?.child.exitCode === null) lastRun.child.kill(signal); };
  const onInterrupt = () => onSignal("SIGINT"), onTerminate = () => onSignal("SIGTERM");
  process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
  try {
    for (;;) {
      const home = homeFor(account);
      if (account.id !== "default") {
        const synced = await capture(process.execPath, [path.join(accounts, "profile.mjs"), "sync", tool, home], env);
        if (synced.code !== 0) throw new Error(`Couldn't refresh account ${title(account)}`);
        console.log(`Atrous account: ${title(account)}`);
      }
      await label("atrous-account", `${tool}:${account.id}`);
      const childEnv = { ...env, [VAR[tool]]: home };
      // Interactive local account launches only; commands, API-key/provider runs, remote TUIs,
      // non-persistent sessions and custom options we cannot preserve are never restarted.
      let canMonitor = interactive && terminal && !env.OPENAI_API_KEY && !env.CODEX_API_KEY && !env.CODEX_ACCESS_TOKEN && !env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN &&
        !env.CLAUDE_CODE_USE_BEDROCK && !env.CLAUDE_CODE_USE_VERTEX && !args.some(a => /^(?:--remote|--cloud|--bg|--background|--tmux|--no-session-persistence|--safe-mode|--bare)/.test(a) || tool === "claude" && /^(?:--print(?:=|$)|-p$)/.test(a)) &&
        resumeArgs(tool, args, randomUUID()) !== null;
      if (canMonitor && tool === "claude") {
        const version = await capture(exe.command, [...exe.prefix, "--version"], childEnv);
        const match = /\b(\d+)\.(\d+)\.(\d+)/.exec(version.text);
        // Use the verified exec-form hook schema, including on Windows without Git Bash.
        // Older clients launch unchanged rather than guessing at shell quoting/schema support.
        canMonitor = Boolean(match && (Number(match[1]) > 2 || Number(match[1]) === 2 && (Number(match[2]) > 1 || Number(match[2]) === 1 && Number(match[3]) >= 318)));
      }
      let privateDir, inputArgs = launchArgs, reader;
      if (canMonitor) {
        const root = path.join(path.dirname(accounts), "data/account-runs");
        await fs.mkdir(root, { recursive: true });
        privateDir = await fs.mkdtemp(path.join(root, "run-"));
        await fs.chmod(privateDir, 0o700).catch(() => {});
        childEnv.ATROUS_ACCOUNT_EVENTS = path.join(privateDir, "events.jsonl");
        if (tool === "codex") {
          inputArgs = [...launchArgs, "-c", `log_dir=${JSON.stringify(privateDir)}`];
          const help = await capture(exe.command, [...exe.prefix, "--help"], childEnv);
          if (help.text.includes("--no-daemon") && !inputArgs.includes("--no-daemon")) inputArgs.unshift("--no-daemon");
          reader = new Lines(path.join(privateDir, "codex-tui.log"));
        } else {
          inputArgs = await claudeSettings(launchArgs, privateDir);
          reader = new Lines(childEnv.ATROUS_ACCOUNT_EVENTS);
        }
      }
      const running = start(exe, inputArgs, childEnv, launchCwd);
      lastRun = running;
      let exited = false, result;
      running.done.then(value => { exited = true; result = value; });
      const currentGeneration = ++generation;
      session = null;
      const candidates = new Map(), quotas = new Map();
      const candidate = id => {
        if (id === session?.id || candidates.has(id)) return;
        candidates.set(id, { at: Date.now(), next: 0, delay: 500 });
        while (candidates.size > 16) candidates.delete(candidates.keys().next().value);
      };
      let quota = null, handoff = null, announced = false;
      while (!exited && !stopped) {
        if (reader) {
          const snapshot = await usage();
          const blocked = binding(tool, snapshot?.[`${tool}:${account.id}`]).blocked;
          for (const raw of await reader.read()) {
            let record;
            if (tool === "codex") record = codexRecord(raw.replace(/\x1b\[[0-9;]*m/g, ""), null);
            else { try { record = claudeRecord(JSON.parse(raw), session?.id, blocked); } catch {} }
            if (record?.type === "session") {
              if (tool === "codex") { candidate(record.id); continue; }
              const exact = record;
              if (exact && path.isAbsolute(exact.cwd ?? "")) { session = exact; quota = null; }
            } else if (record?.type === "input") {
              quotas.delete(record.id);
              if (record.id === session?.id) { quota = null; announced = false; }
            } else if (record?.type === "quota") {
              const value = { ...record, at: Date.now() };
              quotas.set(record.id, value);
              while (quotas.size > 32) quotas.delete(quotas.keys().next().value);
              if (tool === "codex") candidate(record.id);
              if (record.id === session?.id) quota = value;
            }
          }
          for (const [id, retry] of candidates) {
            if (Date.now() - retry.at > 30_000) { candidates.delete(id); continue; }
            if (Date.now() < retry.next) continue;
            retry.delay = Math.min(8000, retry.delay * 2);
            retry.next = Date.now() + retry.delay;
            const exact = await codexSession(home, id);
            if (exact) { session = exact; quota = quotas.get(id) ?? null; candidates.delete(id); }
          }
          if (session && pendingNotice?.session === session.id) {
            await label("atrous.account.handoff", JSON.stringify({ ...pendingNotice, phase: "resumed" }));
            pendingNotice = null;
          }
        }
        if (quota && session && (tool === "codex" || await claudeQuota(session, home))) {
          st = await state(); const snapshot = await usage();
          const model = quota.model || session.model;
          const next = chooseAccount(st, snapshot, tool, account.id, failed, model);
          if (next && await valid(next)) {
            const resumed = resumeArgs(tool, args, session.id, session.cwd, model);
            if (resumed && !exited && !stopped) {
              // A second state read makes disabling automatic resume take effect before input.
              const latest = await state();
              const stillLinked = latest?.accounts?.some(a => a.tool === tool && a.id === next.id && a.dir === next.dir && !a.pending);
              if (!stillLinked || latest.auto?.enabled === false || latest.auto?.resume === false) { await sleep(500); continue; }
              const sync = next.id === "default" ? { code: 0 } : await capture(process.execPath, [path.join(accounts, "profile.mjs"), "sync", tool, next.dir], env);
              if (sync.code !== 0) break;
              if (exited || stopped) break;
              failed.set(account.id, { at: Date.now(), resets: binding(tool, snapshot?.[`${tool}:${account.id}`], model).resets });
              await label("atrous.account.handoff", JSON.stringify({ id: `${runId}-${currentGeneration}`, phase: "switching", tool, from: account.id, to: next.id, name: title(next) }));
              if (exited || stopped) break;
              // Use the TUI's exit shortcut. Ctrl+C can reach the parent Node/npm shim when
              // Windows restores console mode during shutdown and cancel the handoff itself.
              // If the CLI doesn't exit, leave it alone rather than starting a second writer.
              await core(["keys", terminal, "ctrl+d"]);
              await Promise.race([running.done, sleep(350)]);
              if (!exited) await core(["keys", terminal, "ctrl+d"]);
              await Promise.race([running.done, sleep(4000)]);
              if (exited && !stopped) handoff = { next, resumed };
              break;
            }
          } else if (!announced && st && st.auto?.enabled !== false && st.auto?.resume !== false) {
            announced = true;
            await label("atrous.account.handoff", JSON.stringify({ id: `${runId}-${currentGeneration}`, phase: "waiting", tool, from: account.id }));
          }
        }
        await sleep(500);
      }
      if (!exited) result = await running.done;
      if (privateDir) await fs.rm(privateDir, { recursive: true, force: true }).catch(() => {});
      if (!handoff || stopped) {
        if (result?.error) throw result.error;
        return result?.code ?? 1;
      }
      console.log(`Atrous: resuming ${tool === "codex" ? "Codex" : "Claude Code"} conversation ${session.id} on ${title(handoff.next)}.`);
      const previous = account;
      account = handoff.next; launchArgs = handoff.resumed; launchCwd = session.cwd;
      pendingNotice = { id: `${runId}-${currentGeneration}`, tool, from: previous.id, to: account.id, name: title(account), session: session.id };
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
    await label("atrous-account", "");
    await label("atrous.account.handoff", "");
    // A manual stop never authorizes another launch. Let the CLI's normal signal handling
    // finish; these listeners never affect a different terminal or an existing CLI process.
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv[2] === "hook") await emitHook();
    else process.exitCode = await supervise({ tool: process.argv[2], command: process.argv[4], args: process.argv.slice(6) });
  } catch (error) { console.error(`Atrous accounts: ${error.message}`); process.exitCode = 1; }
}
