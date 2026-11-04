// herdr accounts: makes, refreshes and removes the folders behind extra Claude Code / Codex
// accounts. Plain Node (run by mods/my-settings and by launch.ps1), not a mod module.
//
//   node profile.mjs create <claude|codex> <id>   make accounts/<tool>/<id>
//   node profile.mjs sync   <claude|codex> <dir>  refresh its copies of your main settings
//   node profile.mjs remove <claude|codex> <id>   delete it (its links first, never their targets)
//   node profile.mjs info   <claude|codex> <dir>  what it shares and whether its links are intact
// Each prints one line of JSON: { ok: true, ... } or { error }.
//
// An account is a config home: CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex. Each one
// keeps its own login (.credentials.json / auth.json, written only by `claude auth login` /
// `codex login` in that folder) and its own caches, history and state. The main account stays
// ~/.claude and ~/.codex: this script only reads them and never writes inside them.
//
// Shared with the main account through directory junctions (no admin rights needed; they point
// into ~/.claude or ~/.codex, so what an agent writes there lands in the main folders):
//   Claude Code: projects (transcripts, /resume, auto-memory), sessions (one file per running
//     process), file-history (rewind of resumed sessions), todos, plans, agents, skills, commands,
//     output-styles, hooks, plugins, ide (IDE lock files). Usage stats (ccusage) and tokens/s
//     (my-spaces/speed.js) read ~/.claude/projects and ~/.claude/sessions, so they see agents of
//     every account without knowing about accounts.
//   Codex: sessions (rollouts: `codex resume`, ccusage, speed.js), archived_sessions, skills,
//     plugins, prompts, rules, vendor_imports.
//   Only folders that exist in the main account are linked; `sync` links ones that appear later.
// Copied (a file can't be a junction; a hard link would split silently on the first atomic save):
//   Claude Code: settings.json (hooks, permissions, plugins, statusLine, model, theme), with
//     secret-looking `env` entries (TOKEN, KEY, SECRET, PASSWORD...) left out; settings.local.json,
//     CLAUDE.md, keybindings.json as they are. ~/.claude.json lives outside ~/.claude, and Claude
//     Code reads $CLAUDE_CONFIG_DIR/.claude.json instead: the new one gets your user MCP servers,
//     each project's trust, allowed tools and MCP choices, and the onboarding flags; never
//     oauthAccount, userID or caches.
//   Codex: config.toml (model, MCP servers, project trust, plugins, notify), AGENTS.md,
//     instructions.md.
//   `sync` copies a file again when the main one is newer than this account's copy (so an edit
//   made in this account stays until the main file changes again), and brings user MCP servers
//   added or removed in the main account across (servers added in this account stay).
// Never copied: .credentials.json, auth.json, ~/.claude/config.json (an old API key), history,
// sqlite state, caches, daemon/jobs/session-env/shell-snapshots (per account by design).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACCOUNTS = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const MARKER = ".herdr-account.json";

const TOOLS = {
  claude: {
    main: path.join(HOME, ".claude"),
    required: ["projects", "sessions"],
    share: ["projects", "sessions", "file-history", "todos", "plans", "agents", "skills", "commands", "output-styles", "hooks", "plugins", "ide"],
    files: ["settings.json", "settings.local.json", "CLAUDE.md", "keybindings.json"],
    global: path.join(HOME, ".claude.json"),
  },
  codex: {
    main: path.join(HOME, ".codex"),
    required: ["sessions"],
    share: ["sessions", "archived_sessions", "skills", "plugins", "prompts", "rules", "vendor_imports"],
    files: ["config.toml", "AGENTS.md", "instructions.md"],
  },
};

// ~/.claude.json fields a new Claude Code account starts with.
const GLOBAL_KEYS = ["hasCompletedOnboarding", "lastOnboardingVersion", "installMethod", "autoUpdates", "editorMode", "autoCompactEnabled", "showExpandedTodos", "claudeInChromeDefaultEnabled"];
const PROJECT_KEYS = ["allowedTools", "mcpContextUris", "mcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "disabledMcpServers", "hasTrustDialogAccepted", "hasClaudeMdExternalIncludesApproved", "hasClaudeMdExternalIncludesWarningShown"];
const SECRET = /TOKEN|SECRET|PASSW|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH/i;

const out = (v) => { process.stdout.write(JSON.stringify(v) + "\n"); };
const fail = (error) => { out({ error }); process.exit(1); };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// The account folder for a tool and id, refusing anything but accounts/<tool>/<id>.
function folderFor(tool, id) {
  if (!TOOLS[tool]) fail(`unknown tool: ${tool}`);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id ?? "") || id === "default") fail(`bad account id: ${id}`);
  return path.join(ACCOUNTS, tool, id);
}

// An existing account folder given by path: must be accounts/<tool>/<id> with our marker.
function checkFolder(tool, dir) {
  if (!TOOLS[tool]) fail(`unknown tool: ${tool}`);
  const resolved = path.resolve(dir ?? "");
  if (!same(path.dirname(resolved), path.join(ACCOUNTS, tool))) fail(`not an account folder: ${dir}`);
  const marker = readJson(path.join(resolved, MARKER));
  if (!marker || marker.tool !== tool) fail(`no account marker in ${dir}`);
  return { dir: resolved, marker };
}

function link(tool, dir, name) {
  const target = path.join(TOOLS[tool].main, name);
  const at = path.join(dir, name);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return null;
  if (exists(at)) return isLink(at) ? name : null; // already linked, or this account has its own
  fs.symlinkSync(target, at, "junction");
  return name;
}

// settings.json without secret-looking env entries (the main file is never changed).
function settingsText(src) {
  const raw = fs.readFileSync(src, "utf8");
  let s;
  try { s = JSON.parse(raw); } catch { return { text: raw, dropped: [] }; }
  const dropped = [];
  if (s && s.env && typeof s.env === "object") {
    for (const k of Object.keys(s.env)) if (SECRET.test(k)) { delete s.env[k]; dropped.push(k); }
  }
  return { text: JSON.stringify(s, null, 2) + "\n", dropped };
}

function copyFiles(tool, dir, onlyNewer) {
  const copied = [], dropped = [];
  for (const name of TOOLS[tool].files) {
    const src = path.join(TOOLS[tool].main, name);
    const dst = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    if (onlyNewer && fs.existsSync(dst) && fs.statSync(src).mtimeMs <= fs.statSync(dst).mtimeMs) continue;
    if (tool === "claude" && name === "settings.json") {
      const r = settingsText(src);
      writeAtomic(dst, r.text);
      dropped.push(...r.dropped);
    } else {
      fs.copyFileSync(src, dst);
    }
    copied.push(name);
  }
  return { copied, dropped };
}

// The new account's .claude.json: onboarding flags, user MCP servers, per-project trust and MCP.
function seedGlobal(dir) {
  const main = readJson(TOOLS.claude.global) ?? {};
  const seed = {};
  for (const k of GLOBAL_KEYS) if (main[k] !== undefined) seed[k] = main[k];
  if (main.mcpServers) seed.mcpServers = main.mcpServers;
  const projects = {};
  for (const [p, v] of Object.entries(main.projects ?? {})) {
    const keep = {};
    for (const k of PROJECT_KEYS) if (v?.[k] !== undefined) keep[k] = v[k];
    if (Object.keys(keep).length) projects[p] = keep;
  }
  if (Object.keys(projects).length) seed.projects = projects;
  const file = path.join(dir, ".claude.json");
  const now = readJson(file) ?? {};
  writeAtomic(file, JSON.stringify({ ...seed, ...now }, null, 2) + "\n");
  return Object.keys(main.mcpServers ?? {});
}

// User MCP servers added or removed in the main account since the last sync.
function syncMcp(dir, marker) {
  const main = readJson(TOOLS.claude.global)?.mcpServers ?? {};
  const before = new Set(marker.mcp ?? []);
  const names = Object.keys(main);
  const file = path.join(dir, ".claude.json");
  const g = readJson(file);
  if (!g) return names;
  const mine = { ...(g.mcpServers ?? {}) };
  let changed = false;
  for (const n of names) {
    if (JSON.stringify(mine[n]) !== JSON.stringify(main[n])) { mine[n] = main[n]; changed = true; }
  }
  for (const n of before) if (!(n in main) && n in mine) { delete mine[n]; changed = true; }
  if (changed) writeAtomic(file, JSON.stringify({ ...readJson(file), mcpServers: mine }, null, 2) + "\n");
  return names;
}

function sources(tool) {
  const t = TOOLS[tool];
  return [...t.files.map((f) => path.join(t.main, f)), ...(t.global ? [t.global] : [])];
}

function writeMarker(dir, marker) {
  writeAtomic(path.join(dir, MARKER), JSON.stringify(marker, null, 2) + "\n");
}

function create(tool, id) {
  const dir = folderFor(tool, id);
  const t = TOOLS[tool];
  for (const r of t.required) {
    if (!fs.existsSync(path.join(t.main, r))) fail(`${path.join(t.main, r)} doesn't exist: start ${tool} once with your main account first`);
  }
  if (exists(dir)) fail(`${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const shared = t.share.map((n) => link(tool, dir, n)).filter(Boolean);
    for (const r of t.required) if (!shared.includes(r)) throw new Error(`couldn't link ${r}`);
    const { copied, dropped } = copyFiles(tool, dir, false);
    const mcp = tool === "claude" ? seedGlobal(dir) : [];
    writeMarker(dir, { tool, id, created: Date.now(), sources: sources(tool), shared, mcp });
    out({ ok: true, dir, shared, copied, dropped });
  } catch (e) {
    removeTree(dir);
    fail(String(e?.message ?? e));
  }
}

function sync(tool, given) {
  const { dir, marker } = checkFolder(tool, given);
  const shared = TOOLS[tool].share.filter((n) => isLink(path.join(dir, n)));
  for (const n of TOOLS[tool].share) if (!exists(path.join(dir, n)) && link(tool, dir, n)) shared.push(n);
  const { copied, dropped } = copyFiles(tool, dir, true);
  const mcp = tool === "claude" ? syncMcp(dir, marker) : [];
  writeMarker(dir, { ...marker, sources: sources(tool), shared, mcp, synced: Date.now() });
  out({ ok: true, dir, shared, copied, dropped });
}

function info(tool, given) {
  const { dir, marker } = checkFolder(tool, given);
  const links = TOOLS[tool].share.filter((n) => isLink(path.join(dir, n)));
  const broken = links.filter((n) => !fs.existsSync(path.join(dir, n)));
  const own = TOOLS[tool].share.filter((n) => exists(path.join(dir, n)) && !isLink(path.join(dir, n)));
  out({ ok: true, dir, created: marker.created, shared: links, broken, own });
}

// Deletes a folder without ever following a link or junction: links are removed as links.
function removeTree(p) {
  let st;
  try { st = fs.lstatSync(p); } catch { return; }
  if (st.isSymbolicLink()) {
    try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); }
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) removeTree(path.join(p, name));
    fs.rmdirSync(p);
    return;
  }
  fs.unlinkSync(p);
}

function remove(tool, id) {
  const dir = folderFor(tool, id);
  if (!exists(dir)) return out({ ok: true, dir, removed: false });
  checkFolder(tool, dir);
  const main = TOOLS[tool].main;
  const before = TOOLS[tool].required.map((r) => fs.readdirSync(path.join(main, r)).length);
  // Links first, so the walk below can't reach the main account.
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (isLink(p)) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } }
  }
  removeTree(dir);
  const after = TOOLS[tool].required.map((r) => fs.existsSync(path.join(main, r)));
  if (after.some((x) => !x)) fail("a main folder is missing after removal: check ~/.claude / ~/.codex");
  out({ ok: true, dir, removed: true, mainEntries: before });
}

const [cmd, tool, arg] = process.argv.slice(2);
try {
  if (cmd === "create") create(tool, arg);
  else if (cmd === "sync") sync(tool, arg);
  else if (cmd === "remove") remove(tool, arg);
  else if (cmd === "info") info(tool, arg);
  else fail("usage: node profile.mjs create|sync|remove|info <claude|codex> <id|dir>");
} catch (e) {
  fail(String(e?.message ?? e));
}
