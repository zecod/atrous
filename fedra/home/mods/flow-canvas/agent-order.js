// The order of every agent list in Atrous (the project start screen, my-new-menu's "+", the
// onboarding's Agents step, Flow's "+"), and which agents are installed. Mods can't import across
// folders: copy this file as it is (the same file is in mods/start, mods/my-new-menu and
// mods/onboarding). The rule:
//   1. installed agents first: Claude Code, Codex, Pi, OpenCode in that order (the ones installed),
//      then the other installed agents by how often the person started them (shared "agents.uses",
//      counted with noteAgentUse), ties as knownAgents() lists them;
//   2. then the agents not installed, in the same order.
// Installed: knownAgents() asks the shell for each agent's `run[0]`. Fedra starts Claude Code and
// Codex through the account launchers (accounts/claude.ps1, ...), a path that always exists, so for
// those the command itself is looked up (where.exe on Windows, `command -v` elsewhere).

import { shared, setShared, knownAgents, exec, window } from "atrous";

export const FIRST = ["claude", "codex", "pi", "opencode"];
// shared: { "<agent key>": times started from a menu or the start screen }
export const USES = "agents.uses";
// shared: { "<machine name, or '' for this computer>": the last agents found there } (shown at once
// while the next check runs; the same key my-new-menu, Flow and my-spaces read)
export const KNOWN = "new-menu.agents";

// { installed: [...], missing: [...] }, each in the order above.
export function agentOrder(list, uses) {
  const count = uses ?? shared(USES) ?? {};
  const rank = (a) => (FIRST.includes(a.key) ? FIRST.indexOf(a.key) : FIRST.length);
  const sorted = (xs) =>
    xs.map((a, i) => [a, i])
      .sort((x, y) => rank(x[0]) - rank(y[0]) || (count[y[0].key] ?? 0) - (count[x[0].key] ?? 0) || x[1] - y[1])
      .map(([a]) => a);
  const all = list ?? [];
  return { installed: sorted(all.filter((a) => a.installed)), missing: sorted(all.filter((a) => !a.installed)) };
}

// Counts one start of `key` (call it where an agent is started from a list).
export function noteAgentUse(key) {
  if (!key) return;
  const uses = shared(USES) ?? {};
  setShared(USES, { ...uses, [key]: (uses[key] ?? 0) + 1 });
}

// The last list found on `machine` (null: this computer), at once and without asking anything.
export function cachedAgents(machine) {
  return shared(KNOWN)?.[machine ?? ""] ?? [];
}

const WRAPPED = { claude: "claude", codex: "codex" };
const isPath = (cmd) => /[\\/]/.test(String(cmd ?? ""));

// Which of these commands `machine` has.
async function have(commands, machine) {
  const safe = commands.filter((c) => /^[A-Za-z0-9._-]+$/.test(c));
  if (!safe.length) return null;
  try {
    if (!machine && window()?.platform === "windows") {
      const r = await exec("where.exe", safe);
      const found = new Set();
      for (const line of r.stdout.split(/\r?\n/)) {
        const name = line.trim().split(/[\\/]/).pop()?.replace(/\.[^.]*$/, "").toLowerCase();
        const hit = safe.find((c) => c.toLowerCase() === name);
        if (hit) found.add(hit);
      }
      return found;
    }
    const r = await exec("sh", ["-lc", safe.map((c) => `command -v '${c}' >/dev/null 2>&1 && echo '${c}'`).join("; ")], { on: machine ?? null });
    return new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch {
    return null; // couldn't ask: keep what knownAgents() said
  }
}

// knownAgents() on `machine`, with launcher-wrapped agents checked by their own command, and
// remembered in shared KNOWN. Rejects when knownAgents() does.
export async function loadAgents(machine) {
  const list = await knownAgents({ on: machine ?? null });
  const wrapped = list.filter((a) => WRAPPED[a.key] && isPath(a.run?.[0]));
  if (wrapped.length) {
    const found = await have(wrapped.map((a) => WRAPPED[a.key]), machine);
    if (found) for (const a of wrapped) a.installed = found.has(WRAPPED[a.key]);
  }
  const all = shared(KNOWN) ?? {};
  const where = machine ?? "";
  if (JSON.stringify(all[where]) !== JSON.stringify(list)) setShared(KNOWN, { ...all, [where]: list });
  return list;
}
