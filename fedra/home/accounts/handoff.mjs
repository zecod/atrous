// Pure account-handoff policy. No credentials, process control or model requests here.
export const FRESH_MS = 15 * 60_000;
export const CONTINUE = "Continue the existing task from where you stopped at the account usage limit. Check the saved conversation and working files before retrying any interrupted action.";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function binding(tool, usage, model = "", now = Date.now()) {
  let best = { pct: 0, resets: null };
  for (const row of usage?.rows ?? []) {
    if (tool === "claude" && row.kind === "model" && model && !String(model).toLowerCase().includes(String(row.label).toLowerCase().split(/\s+/)[0])) continue;
    const pct = row.resets && row.resets <= now ? 0 : Math.max(0, Number(row.pct) || 0);
    if (pct >= best.pct) best = { pct, resets: row.resets ?? null };
  }
  return { ...best, blocked: Boolean(usage?.blocked) && now - (usage.at ?? 0) < FRESH_MS || best.pct >= 100 };
}

export function chooseAccount(state, usage, tool, current, failed = new Map(), model = "", now = Date.now()) {
  if (!state || state.auto?.enabled === false || state.auto?.resume === false) return null;
  const accounts = (state.accounts ?? []).filter(a => a.tool === tool && !a.pending);
  const start = accounts.findIndex(a => a.id === current);
  const order = [...accounts.slice(start + 1), ...accounts.slice(0, Math.max(0, start))];
  // Prefer the account the person (or the usage card) already selected.
  const preferred = state.active?.[tool];
  order.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  for (const account of order) {
    if (account.id === current) continue;
    const entry = usage?.[`${tool}:${account.id}`];
    if (entry?.login !== "in" || !entry.rows?.length || !entry.at || now - entry.at > FRESH_MS || entry.stale || entry.error) continue;
    if (entry.rows.some(row => !Number.isFinite(row.pct) || row.pct < 0)) continue;
    const limit = binding(tool, entry, model, now);
    if (limit.blocked || limit.pct >= (state.auto?.threshold ?? 95)) continue;
    const previous = failed.get(account.id);
    // An account that rejected this run is eligible again only after its known window reset
    // and a newer successful usage check. Unknown limits never cause account ping-pong.
    if (previous && !(previous.resets && now >= previous.resets && entry.at > previous.resets)) continue;
    return account;
  }
  return null;
}

export function quotaMessage(text) {
  return /(?:you[’']?ve|you have) (?:hit|reached) your (?:usage )?limit|usage[_ ]limit[_ ](?:reached|exceeded)|(?:usage|account|session|weekly|monthly) (?:quota|limit) (?:has been )?(?:exhausted|reached)|hit your limit\s*[·:.—-]?\s*reset/i.test(String(text ?? ""));
}

// Only parse Codex's own error record in the private log of this launch. User messages,
// tool output, generic HTTP 429s and another session's errors never trigger a handoff.
export function codexRecord(line, current) {
  if (!/^\d{4}-\d\d-\d\dT\S+\s+(?:\x1b\[[0-9;]*m)*(?:INFO|WARN|ERROR)\b/.test(line)) return null;
  const id = /session_loop\{thread_id=([0-9a-f-]{36})\}/i.exec(line)?.[1];
  if (!id || !UUID.test(id)) return null;
  if (/^.*:\s+codex_core::(?:session|codex):\s+new\s*$/.test(line)) return { type: "session", id };
  if (current && current !== id) return null;
  const message = /:\s+codex_core::(?:session(?:::[a-z_]+)*|codex):\s+Turn error:\s*(.*)$/.exec(line)?.[1];
  if (message && quotaMessage(message)) return { type: "quota", id, model: /\bmodel=([^\s}]+)/.exec(line)?.[1] };
  if (/codex\.op="(?:user_input|turn_input)".*:\s+codex_core::(?:session::handlers|codex):\s+new\s*$/.test(line)) return { type: "input", id };
  return null;
}

export function claudeRecord(payload, current, currentBlocked = false) {
  if (!payload || !UUID.test(payload.session_id ?? "") || payload.agent_id) return null;
  const id = payload.session_id;
  if (payload.hook_event_name === "SessionStart") return { type: "session", id, cwd: payload.cwd, transcript: payload.transcript_path, model: payload.model };
  if (id !== current) return null;
  if (payload.hook_event_name === "UserPromptSubmit") return { type: "input", id };
  if (payload.hook_event_name === "StopFailure" && payload.error === "rate_limit" &&
      (currentBlocked || payload.quota === true || quotaMessage(payload.last_assistant_message) || quotaMessage(payload.error_details))) return { type: "quota", id };
  return null;
}

export function claudeQuotaRecord(row, session) {
  if (row?.type !== "assistant" || !row.isApiErrorMessage || row.sessionId !== session || row.isSidechain || row.agentId) return false;
  if (!["rate_limit", "rate_limit_error"].includes(row.error)) return false;
  const text = (row.message?.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\n");
  return quotaMessage(text) || (row.quotaLimits ?? []).some(q => /^(?:five_hour|seven_day|weekly|monthly|session)/.test(q.rateLimitType ?? ""));
}

const CODEX_VALUES = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "--enable", "--disable", "--local-provider"]);
const CODEX_FLAGS = new Set(["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--approve-for-me", "--search", "--no-alt-screen", "--no-daemon", "--strict-config", "--oss", "--full-auto"]);
const CLAUDE_VALUES = new Set(["--model", "--effort", "--agent", "--permission-mode", "--permission-prompt-tool", "--append-system-prompt", "--append-system-prompt-file", "--system-prompt", "--system-prompt-file", "--system-prompt-snapshot", "--settings", "--setting-sources", "--fallback-model", "--max-budget-usd", "--name", "-n", "--debug-file"]);
const CLAUDE_MANY = new Set(["--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools", "--mcp-config", "--plugin-dir"]);
const CLAUDE_FLAGS = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--chrome", "--no-chrome", "--strict-mcp-config", "--disable-slash-commands", "--verbose", "--bare", "--safe-mode"]);

// Fail closed on unsupported launch modes/options instead of guessing which arguments are a
// task or silently dropping a permissions flag. Initial prompts are never replayed.
export function resumeArgs(tool, args, session, cwd, model) {
  if (!UUID.test(session ?? "")) return null;
  const out = [], values = tool === "codex" ? CODEX_VALUES : CLAUDE_VALUES;
  const flags = tool === "codex" ? CODEX_FLAGS : CLAUDE_FLAGS;
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], name = arg.split("=")[0], inline = arg.includes("=");
    if (tool === "codex" && ["resume", "fork"].includes(arg) && positional === 0) {
      if (args[i + 1] && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    if (tool === "claude" && ["--resume", "-r", "--session-id"].includes(name)) { if (!inline && args[i + 1] && !args[i + 1].startsWith("-")) i++; continue; }
    if (["--last", "--all", "--continue", "-c"].includes(arg) && (tool === "claude" || arg !== "-c")) continue;
    if (name === "--worktree" || tool === "claude" && name === "-w") { if (tool === "claude" && !inline && args[i + 1] && !args[i + 1].startsWith("-")) i++; continue; }
    if (tool === "codex" && ["--image", "-i"].includes(name)) { while (args[i + 1] && !args[i + 1].startsWith("-")) i++; continue; }
    if (tool === "claude" && CLAUDE_MANY.has(name)) {
      out.push(arg); if (!inline) while (args[i + 1] && !args[i + 1].startsWith("-")) out.push(args[++i]); continue;
    }
    if (values.has(name)) {
      if (tool === "codex" && ["-C", "--cd"].includes(name) && cwd || ["-m", "--model"].includes(name) && model) { if (!inline) i++; continue; }
      if (!inline && i + 1 >= args.length) return null;
      out.push(arg); if (!inline) out.push(args[++i]); continue;
    }
    if (flags.has(arg)) { out.push(arg); continue; }
    if (arg.startsWith("-")) return null;
    if (positional++ === 0 && /^(?:exec|review|login|logout|mcp|app|agents|attach|auth|update|doctor|plugin|queue|cloud|remote-control|features|debug|completion|help|install|gateway|respawn)$/.test(arg)) return null;
  }
  if (model) out.push("--model", model);
  if (tool === "codex") return [...out, ...(cwd ? ["--cd", cwd] : []), "resume", session, CONTINUE];
  return [...out, "--resume", session, CONTINUE];
}
