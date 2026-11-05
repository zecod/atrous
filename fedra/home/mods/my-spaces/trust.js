// Agents that haven't reported a status, and what they show: a folder-trust prompt, or output.
// (A copy of flow-canvas/trust.js: mods can't import across folders. Keep the two the same.)
//
// An agent terminal: a live terminal Atrous started in a space (atrous.space label) for a known agent:
//   the atrous.agent=<program key> label (Atrous sets it on what it starts for a known agent), else
//   the accounts launcher's atrous-account=<tool>:<id> label, a known agent's run command in its
//   argv, the program the app sees running, or a tab named after a known agent (older builds).
// Unreported: no OSC 7501 report yet. Claude Code and Codex report once they're past their startup
// screens, so one asking "Trust this folder?" would be invisible; OpenCode never reports at all.
//
// What it shows comes from its screen (`atc read`), only while the window is in front:
// - in its first 3 minutes (and for an agent that reported idle without ever having a turn), a
//   trust prompt, every 2.5 s;
// - after its first 15 s, whether its screen still changes, every 4 s: "running" while it changed in
//   the last 8 s, else idle. Never "needs you" from that: only the prompts below say so.
// Prompts verified against the real CLIs (2026-11-05):
//   Claude Code 2.1.318:  "Accessing workspace: <folder>" ... "Quick safety check: Is this a
//     project you created or one you trust? ..." then the options "❯ No, exit" / "Yes, I trust
//     this folder" (No is selected) and "Enter to confirm · Esc to cancel". Accept: down, enter.
//   Codex 0.166.0:  "Folder access <folder>" ... "Trust this folder? Codex can read, edit, and run
//     files here ..." then "› 1. Trust and continue" / "2. Back to Agent Command Center" and
//     "enter continue · esc back". Accept: enter.
// Anything else with "trust" and a selection list (❯ ›) in those first minutes is answered the same
// generic way: move the selection to the first yes/trust/allow/continue option, press enter.

import { core } from "atrous";

const norm = (s) => String(s ?? "").replace(/\\/g, "/").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const ASK_MS = 3 * 60000; // trust prompts come at startup
export const QUIET_MS = 8000; // no screen change for this long: idle
export const STARTING_MS = 15000; // "Starting…" at most this long, then its screen decides

const BUILT = {
  claude: { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false, tile: "#1c1d21", color: "#ffffff" },
  codex: { key: "codex", name: "Codex", icon: "icons/codex.svg", tint: false, tile: "#1c1d21", color: "#ffffff" },
};

/**
 * The known agent a terminal was started as, or null. `known`: knownAgents(); `tabName`: tab id ->
 * its name (for builds without the atrous.agent label).
 */
export function launchOf(term, known, tabName) {
  if (!term || term.state !== "live") return null;
  const labels = term.labels ?? {};
  if (!labels["atrous.space"] || labels["atrous.quick"]) return null;
  const list = known ?? [];
  const byKey = (k) => list.find((a) => a.key === k) ?? BUILT[k] ?? (k ? { key: k, name: k } : null);
  if (labels["atrous.agent"]) return byKey(labels["atrous.agent"]);
  const tool = String(labels["atrous-account"] ?? "").split(":")[0];
  if (tool) return byKey(tool);
  const argv = norm((term.argv ?? []).join(" "));
  for (const a of list) {
    const r0 = norm(a.run?.[0]);
    if (!r0) continue;
    const base = r0.split("/").pop().replace(/\.(ps1|sh|cmd|exe|bat)$/, "");
    if (r0.includes("/") ? argv.includes(r0) : new RegExp(`(^|[\\s'"&/])${esc(base)}(\\.(exe|cmd|ps1))?(['"\\s]|$)`).test(argv)) return a;
  }
  const p = term.program;
  if (p?.agent && p.key && !p.shell) return list.find((a) => a.key === p.key) ?? p;
  const tab = tabName?.(labels["atrous.tab"]);
  if (tab) return list.find((a) => a.name === tab) ?? null;
  return null;
}

/** It has reported a status (OSC 7501) at least once. */
export function reported(term) {
  return Boolean(term?.reported || (term?.status && (typeof term.status === "string" || term.status.state)));
}

const MARK = /^\s*(❯|›|>|●|→)\s+(\S.*)$/;
const YES = /^(yes|trust|allow|continue|proceed|accept|ok)\b/i;

/**
 * What a screen asks, or null: { app: "claude" | "codex" | "generic", question, keys }.
 * keys: what `atc keys` presses to accept (null: no accepting option found; open it instead).
 */
export function promptOf(screen) {
  const lines = String(screen ?? "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const all = lines.join("\n");
  const app = /Quick safety check|Yes, I trust this folder|Do you trust the files in this folder/i.test(all) ? "claude"
    : /Trust this folder\?|Trust and continue/i.test(all) ? "codex"
    : /\btrust\b/i.test(all) ? "generic" : null;
  if (!app) return null;
  // The question, then the option list under it: the selected line and its neighbours up to blank
  // lines. (The first line naming trust: an option below it may say "trust" too.)
  const q = lines.findIndex((l) => /\btrust\b/i.test(l));
  let sel = -1;
  for (let i = Math.max(0, q); i < lines.length; i++) if (MARK.test(lines[i])) { sel = i; break; }
  if (sel < 0) return app === "generic" ? null : { app, question: "Trust this folder?", keys: null };
  let top = sel, bottom = sel;
  while (top - 1 > q && lines[top - 1].trim()) top--;
  while (bottom + 1 < lines.length && lines[bottom + 1].trim() && !/enter|esc/i.test(lines[bottom + 1])) bottom++;
  const options = lines.slice(top, bottom + 1).map((l) => (MARK.exec(l)?.[2] ?? l).trim().replace(/^\d+[.)]\s*/, ""));
  const at = sel - top;
  const yes = options.findIndex((o) => YES.test(o) && !/^(no|back|exit|cancel)\b/i.test(o));
  if (yes < 0) return app === "generic" ? null : { app, question: "Trust this folder?", keys: null };
  const move = yes - at;
  const keys = [...Array(Math.abs(move)).fill(move > 0 ? "down" : "up"), "enter"];
  return { app, question: "Trust this folder?", keys };
}

/** Presses the accepting keys. */
export async function answer(address, keys) {
  if (!keys?.length) return false;
  const r = await core(["keys", address, ...keys]);
  return r.code === 0;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * The screen reader for a mod: call poll(view, cx, candidates) from a timer, only while the window is
 * in front. Reads at most one terminal per call, the one most overdue.
 * candidates(): [{ address, ask }]: ask = look for a prompt (else only whether the screen changes).
 * view.prompts: address -> { at, prompt, answered, hash, changedAt }.
 */
export function poll(view, cx, candidates) {
  if (view.promptBusy) return;
  const now = Date.now();
  const want = candidates();
  const keep = new Set(want.map((c) => c.address));
  for (const a of [...view.prompts.keys()]) if (!keep.has(a)) view.prompts.delete(a);
  const due = want
    .map((c) => ({ ...c, late: now - (view.prompts.get(c.address)?.at ?? 0) - (c.ask ? 2500 : 4000) }))
    .filter((c) => c.late >= 0)
    .sort((x, y) => y.late - x.late)[0];
  if (!due) return;
  view.promptBusy = true;
  cx.spawn(async (cx) => {
    let text = null;
    try {
      const r = await core(["read", due.address, "--lines", "30"]);
      if (r.code === 0) text = r.stdout.replace(/\n\[atc\][^\n]*\s*$/, "");
    } catch {}
    view.promptBusy = false;
    const was = view.prompts.get(due.address);
    const prompt = text != null && due.ask ? promptOf(text) : null;
    const h = text == null ? was?.hash : hash(text);
    const t = Date.now();
    const changedAt = was && h !== was.hash ? t : was?.changedAt ?? 0;
    // busy: what the status said at the last read (a quiet screen turns it idle only on a read)
    const busy = t - changedAt < QUIET_MS;
    view.prompts.set(due.address, { at: t, prompt, answered: prompt ? was?.answered ?? 0 : 0, hash: h, changedAt, busy });
    if (JSON.stringify(was?.prompt ?? null) !== JSON.stringify(prompt) || Boolean(was?.busy) !== busy) cx.notify();
  });
}

/** An unreported agent's status from its screen: "working" (output moving) or "idle". */
export function activity(view, address, now = Date.now()) {
  const e = view.prompts.get(address);
  return e && now - e.changedAt < QUIET_MS ? "working" : "idle";
}
