// What the onboarding reads and writes, kept out of main.js so its drawing stays plain.
// Everything here runs in tasks (cx.spawn), never in render: files, programs and the agents check.
//
// Reads (never writes): data/migration.json (what the app brought over on its first start),
// accounts/state.json and each account's login files (only their non-secret fields: plan, email),
// the atrous-browser skill's links in ~/.claude/skills and ~/.codex/skills.
// Writes: programs.json (the YOLO switch: `run` overrides, compare-then-atomic-replace),
// settings.json (`appearance`, when a theme of the other lightness is picked).

import { readTextFile, writeTextFile, appHome, home, exec, window, shared, knownAgents } from "atrous";
import * as fs from "fs/promises";

export const slash = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const isWindows = () => window()?.platform === "windows";
const isMac = () => window()?.platform === "macos";

export async function readJson(path) {
  try {
    const text = await readTextFile(path);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ---- what came over on the first start ----------------------------------------------------

// data/migration.json, written by the app when it brought a previous home over (src/migrate.rs):
//   { version: 1, from: "<app it came from>", home, at: <unix s>, files: [...], settings, keys,
//     programs: bool, themes: n, layouts: [...], clicks: n, mods: [...], data: n, layout,
//     accounts?: n }
// `accounts` is optional: without it the count is the extra accounts in accounts/state.json.
export async function readMigration() {
  const m = await readJson(`${slash(appHome())}/data/migration.json`);
  return m && typeof m === "object" && !Array.isArray(m) ? m : null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const count = (v) => (Array.isArray(v) ? v.length : Number.isFinite(Number(v)) ? Number(v) : 0);

// "settings, keys, 1 theme and 2 accounts" (empty: nothing of theirs came).
export function migrationParts(m, accounts) {
  const files = Array.isArray(m?.files) ? m.files : [];
  const parts = [];
  if (m?.settings ?? files.includes("settings.json")) parts.push("settings");
  if (m?.keys ?? files.includes("keys.json")) parts.push("keys");
  for (const [k, word] of [["themes", "theme"], ["layouts", "layout"], ["mods", "mod"]]) {
    const n = count(m?.[k]);
    if (n > 0) parts.push(plural(n, word));
  }
  const acc = Number.isFinite(m?.accounts) ? m.accounts : accounts;
  if (acc > 0) parts.push(plural(acc, "account"));
  return parts;
}

export function joinAnd(parts) {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ---- coding agents ------------------------------------------------------------------------

// The agents the Agents step lists first, installed or not, with how to install each.
export const FEATURED = ["claude", "codex", "gemini", "opencode", "pi"];
const NAMES = { claude: "Claude Code", codex: "Codex", gemini: "Gemini", opencode: "OpenCode", pi: "Pi" };
const ICONS = { claude: "icons/claude.svg", codex: "icons/codex.svg", gemini: "icons/gemini.svg", opencode: "icons/opencode.svg", pi: "icons/pi.svg" };

export function installCommand(key) {
  switch (key) {
    case "claude":
      return isWindows() ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";
    case "codex":
      return "npm i -g @openai/codex";
    case "gemini":
      return "npm i -g @google/gemini-cli";
    case "opencode":
      return "npm i -g opencode-ai";
    case "pi":
      return "npm i -g @mariozechner/pi-coding-agent";
    default:
      return null;
  }
}

// The command an agent's launcher wraps (Fedra starts Claude Code and Codex through the account
// launchers in accounts/, so their `run` is a script path, and checking that says nothing).
const WRAPPED = { claude: "claude", codex: "codex" };
const isPath = (cmd) => /[\\/]/.test(String(cmd ?? ""));

// Which of these commands this computer has: where.exe on Windows (PATH and PATHEXT, quicker to
// start than a PowerShell), the login shell's `command -v` elsewhere.
async function have(commands) {
  const safe = commands.filter((c) => /^[A-Za-z0-9._-]+$/.test(c));
  if (!safe.length) return new Set();
  try {
    if (isWindows()) {
      const r = await exec("where.exe", safe);
      const found = new Set();
      for (const line of r.stdout.split(/\r?\n/)) {
        const name = line.trim().split(/[\\/]/).pop()?.replace(/\.[^.]*$/, "").toLowerCase();
        const hit = safe.find((c) => c.toLowerCase() === name);
        if (hit) found.add(hit);
      }
      return found;
    }
    const r = await exec("sh", ["-lc", safe.map((c) => `command -v '${c}' >/dev/null 2>&1 && echo '${c}'`).join("; ")]);
    return new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

// [{ key, name, icon, tint, tile, color, run, installed, featured }]: the featured ones in their
// order, then any other agent this computer has.
export async function findAgents() {
  let list = [];
  try { list = await knownAgents(); } catch {}
  const wrapped = list.filter((a) => WRAPPED[a.key] && isPath(a.run?.[0]));
  if (wrapped.length) {
    const found = await have(wrapped.map((a) => WRAPPED[a.key]));
    for (const a of wrapped) a.installed = found.has(WRAPPED[a.key]);
  }
  const byKey = new Map(list.map((a) => [a.key, a]));
  const stock = (key) => ({ key, name: NAMES[key], icon: ICONS[key], tint: key !== "claude" && key !== "codex", tile: "#1c1d21", color: "#ffffff", installed: false });
  const featured = FEATURED.map((key) => ({ ...(byKey.get(key) ?? stock(key)), featured: true }));
  const others = list.filter((a) => !FEATURED.includes(a.key) && a.installed);
  return [...featured, ...others];
}

// ---- YOLO: agents start without permission prompts ----------------------------------------

// The flag that skips each agent's approval prompts (the same set Fedra installs).
export const YOLO = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  gemini: "--yolo",
  opencode: "--auto",
  antigravity: "--dangerously-skip-permissions",
};
// The built-in table's `run` for each (src: defaults/programs.json): an override equal to it is dropped.
const STOCK_RUN = { claude: ["claude"], codex: ["codex"], gemini: ["gemini"], opencode: ["opencode"], antigravity: ["agy"] };

const programsFile = () => `${slash(appHome())}/programs.json`;

export async function readPrograms() {
  const raw = await readTextFile(programsFile()).catch(() => null);
  if (!raw) return { raw: null, doc: {} };
  try {
    const doc = JSON.parse(raw);
    return { raw, doc: doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {} };
  } catch {
    return { raw, doc: null, error: "programs.json isn't valid JSON, so it was left as it is." };
  }
}

// "on" when every agent in YOLO that this computer has starts with its flag ("mixed": some).
export function yoloState(doc, installed) {
  const progs = doc?.programs ?? {};
  let keys = Object.keys(YOLO).filter((k) => installed?.has(k));
  if (!keys.length) keys = Object.keys(YOLO);
  const on = keys.map((k) => Array.isArray(progs[k]?.run) && progs[k].run.includes(YOLO[k]));
  return on.every(Boolean) ? "on" : on.some(Boolean) ? "mixed" : "off";
}

// What an agent runs before its flag when programs.json doesn't say: Claude Code and Codex go
// through the account launcher when it's there (so Settings > Accounts picks the account).
async function baseRun(key) {
  const tool = WRAPPED[key];
  if (tool) {
    const dir = appHome();
    const sep = isWindows() ? "\\" : "/";
    const launcher = `${String(dir).replace(/[\\/]+$/, "")}${sep}accounts${sep}${tool}.${isWindows() ? "ps1" : "sh"}`;
    if (await readTextFile(launcher).catch(() => null)) return [launcher];
  }
  return STOCK_RUN[key] ?? [key];
}

// Adds or removes each agent's flag in programs.json's `run`, keeping every other entry and
// field. Written only if nobody changed the file meanwhile (else read again). Resolves true when
// the file says what was asked.
export async function setYolo(on) {
  const bases = {};
  for (const k of Object.keys(YOLO)) bases[k] = await baseRun(k);
  for (let attempt = 0; attempt < 4; attempt++) {
    const { raw, doc, error } = await readPrograms();
    if (error) throw new Error(error);
    const next = JSON.parse(JSON.stringify(doc));
    if (!next.programs || typeof next.programs !== "object" || Array.isArray(next.programs)) next.programs = {};
    for (const [k, flag] of Object.entries(YOLO)) {
      const entry = next.programs[k] && typeof next.programs[k] === "object" ? next.programs[k] : {};
      const own = Array.isArray(entry.run) && entry.run.length ? entry.run.filter((x) => x !== flag) : null;
      if (on) {
        entry.run = [...(own && own.length ? own : bases[k]), flag];
        next.programs[k] = entry;
      } else if (own) {
        if (JSON.stringify(own) === JSON.stringify(STOCK_RUN[k]) || !own.length) delete entry.run;
        else entry.run = own;
        if (Object.keys(entry).length) next.programs[k] = entry;
        else delete next.programs[k];
      }
    }
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (text === raw) return true;
    try {
      await writeTextFile(programsFile(), text, raw);
      return true;
    } catch {}
  }
  return false;
}

// ---- accounts (read only) ------------------------------------------------------------------

export const TOOLS = {
  claude: { name: "Claude Code", icon: "icons/claude.svg", main: ".claude" },
  codex: { name: "Codex", icon: "icons/codex.svg", main: ".codex" },
};

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function b64url(s) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = [];
  let bits = 0, val = 0;
  for (const ch of s) {
    const i = chars.indexOf(ch === "+" ? "-" : ch === "/" ? "_" : ch);
    if (i < 0) continue;
    val = ((val << 6) | i) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((val >> bits) & 0xff); }
  }
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else out += String.fromCodePoint(((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
  }
  return out;
}

// A JWT's payload (only non-secret claims are used: email, plan, exp).
function claims(token) {
  try { return JSON.parse(b64url(String(token ?? "").split(".")[1] ?? "")); } catch { return null; }
}

const homeOf = (a) => (a.id === "default" || !a.dir ? `${slash(home())}/${TOOLS[a.tool].main}` : slash(a.dir));

// { state: "in" | "out" | "expired" | "apikey", plan, email }: from the login files' plain fields,
// as accounts-core.js reads them (macOS keeps Claude Code's login in the Keychain: there the usage
// card's last answer says, so this never asks the Keychain).
async function login(a) {
  if (a.tool === "claude") {
    const o = (await readJson(`${homeOf(a)}/.credentials.json`))?.claudeAiOauth;
    const emailFile = a.id === "default" || !a.dir ? `${slash(home())}/.claude.json` : `${homeOf(a)}/.claude.json`;
    const email = (await readJson(emailFile))?.oauthAccount?.emailAddress ?? null;
    if (!o?.accessToken && !o?.refreshToken) {
      const u = (shared("accounts.usage") ?? {})[`claude:${a.id}`];
      if (isMac() && u?.login === "in") return { state: "in", plan: u.plan ?? "", email: email ?? u.who ?? null };
      return { state: "out", plan: "", email: null };
    }
    const tier = /max_(\d+x)/.exec(o.rateLimitTier ?? "")?.[1];
    const plan = [cap(o.subscriptionType), tier].filter(Boolean).join(" ");
    if (o.refreshTokenExpiresAt && o.refreshTokenExpiresAt < Date.now()) return { state: "expired", plan, email };
    return { state: "in", plan, email };
  }
  const auth = await readJson(`${homeOf(a)}/auth.json`);
  if (auth?.tokens?.access_token) {
    const c = claims(auth.tokens.id_token);
    return { state: "in", plan: cap(c?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? ""), email: c?.email ?? null };
  }
  if (auth?.OPENAI_API_KEY) return { state: "apikey", plan: "API key", email: null };
  return { state: "out", plan: "", email: null };
}

// accounts/state.json as Settings > Accounts keeps it (see my-settings/accounts-core.js), read
// only: { exists, active: { claude, codex }, accounts: [{ tool, id, name, email, state, plan,
// active, pending }], extra } where `extra` counts the signed-in accounts besides the main ones.
export async function readAccounts() {
  const raw = await readJson(`${slash(appHome())}/accounts/state.json`);
  const active = { claude: "default", codex: "default", ...(raw?.active ?? {}) };
  const list = (Array.isArray(raw?.accounts) ? raw.accounts : []).filter((a) => a && TOOLS[a.tool] && a.id);
  for (const tool of Object.keys(TOOLS)) {
    if (!list.some((a) => a.tool === tool && a.id === "default")) list.unshift({ tool, id: "default" });
  }
  const accounts = [];
  for (const a of list) {
    const info = await login(a).catch(() => ({ state: "out", plan: "", email: null }));
    accounts.push({
      tool: a.tool, id: a.id, name: a.name && a.name !== "Main" ? a.name : null,
      email: info.email ?? a.email ?? null, state: info.state, plan: info.plan,
      pending: Boolean(a.pending), active: active[a.tool] === a.id,
    });
  }
  const extra = accounts.filter((a) => a.id !== "default" && !a.pending).length;
  return { exists: Boolean(raw), active, accounts, extra };
}

// ---- the atrous-browser agent skill ---------------------------------------------------------

// { shipped, install, tools: { claude: { installed, linked }, codex: {...} } }: the skill is
// linked for a tool when its SKILL.md shows through ~/.<tool>/skills/atrous-browser (as the
// brand mod checks it at start).
export async function skillStatus() {
  const skill = `${slash(appHome())}/skills/atrous-browser`;
  const install = `${skill}/install.mjs`;
  const shipped = Boolean(await readTextFile(install).catch(() => null));
  const h = slash(home());
  const tools = {};
  for (const [k, dir] of [["claude", ".claude"], ["codex", ".codex"]]) {
    const installed = await fs.readdir(`${h}/${dir}`).then(() => true, () => false);
    const linked = installed && Boolean(await readTextFile(`${h}/${dir}/skills/atrous-browser/SKILL.md`).catch(() => null));
    tools[k] = { installed, linked };
  }
  return { shipped, install, tools };
}

// Links (or unlinks) the skill for both tools with its own install.mjs: a junction / symlink,
// never a copy, never another skill.
export async function linkSkill(install, on) {
  const r = await exec("node", on ? [install] : [install, "--remove"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "node install.mjs failed").trim().split(/\r?\n/).pop());
  return r.stdout;
}

// ---- settings.json --------------------------------------------------------------------------

const settingsFile = () => `${slash(appHome())}/settings.json`;

export async function readAppearance() {
  return (await readJson(settingsFile()))?.appearance ?? null;
}

// Sets (null: removes) settings.json's `appearance`, the way Settings changes that file.
export async function writeAppearance(value) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await readTextFile(settingsFile()).catch(() => null);
    let p = {};
    try { p = raw ? JSON.parse(raw) : {}; } catch { return false; }
    if (value === null) delete p.appearance;
    else p.appearance = value;
    try {
      await writeTextFile(settingsFile(), `${JSON.stringify(p, null, 2)}\n`, raw);
      return true;
    } catch {}
  }
  return false;
}

// ---- keys -------------------------------------------------------------------------------------

// The keys bound to the first of these actions, as people press them: ["Ctrl", "Shift", "P"].
export function keysFor(bindings, actions) {
  for (const action of actions) {
    const k = bindings.find((b) => b.section === "global" && b.action === action);
    if (!k) continue;
    return k.keys.split("-").map((p) => (p === "" ? "-" : p === "cmd" ? "⌘" : p === "alt" && isMac() ? "⌥" : p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)));
  }
  return null;
}
