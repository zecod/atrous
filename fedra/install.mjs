#!/usr/bin/env node
// Installs Fedra into herdr-app's home (~/.config/herdr-app, or $HERDR_APP_HOME):
// the Fedra layout, its mods, the account launchers, and the few keys/programs entries it needs.
//
//   node install.mjs            install or update
//   node install.mjs --dry-run  show what would change
//
// What it touches:
// - layouts/fedra.json + fedra.svg, mods/<each Fedra mod>/ (replaced whole: they're Fedra's files),
//   accounts/*.sh|*.ps1|profile.mjs (never accounts/state.json or account folders),
//   skills/<name>/ (agent skills, e.g. herdr-browser), linked into ~/.claude/skills and ~/.codex/skills.
// - keys.json: adds two bindings (quick terminal; Settings opens Fedra's settings), keeps yours.
// - programs.json: Claude Code / Codex start through the account launchers; agents start in
//   "yolo" mode (skip permission prompts). Edit programs.json afterwards if you don't want that.
// - shared.json: makes Fedra the shown layout (or asks the running app to switch).
// Everything replaced is backed up to <home>/fedra-backup-<time>/ first.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "home");
const home = process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
const dry = process.argv.includes("--dry-run");
const win = process.platform === "win32";
const mac = process.platform === "darwin";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(home, `fedra-backup-${stamp}`);
const log = (...a) => console.log(...a);

function saveBackup(rel) {
  const from = path.join(home, rel);
  if (!fs.existsSync(from)) return;
  const to = path.join(backup, rel);
  if (dry) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

// Atomic write: herdr watches these files and must never read half of one.
function writeAtomic(rel, text) {
  const file = path.join(home, rel);
  if (dry) return log(`  would write ${rel}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.fedra-tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(home, rel), "utf8")); } catch { return fallback; }
}

if (!fs.existsSync(src)) {
  console.error(`Fedra files not found next to this script (${src}).`);
  process.exit(1);
}
log(`Fedra -> ${home}${dry ? "  (dry run)" : ""}`);
if (!dry) fs.mkdirSync(home, { recursive: true });

// 1. Layout and mods: Fedra's own files, replaced whole.
if (!dry) fs.mkdirSync(path.join(home, "layouts"), { recursive: true });
for (const f of fs.readdirSync(path.join(src, "layouts"))) {
  saveBackup(path.join("layouts", f));
  if (!dry) fs.copyFileSync(path.join(src, "layouts", f), path.join(home, "layouts", f));
  log(`  layouts/${f}`);
}
if (!dry) fs.mkdirSync(path.join(home, "mods"), { recursive: true });
for (const m of fs.readdirSync(path.join(src, "mods"))) {
  const to = path.join(home, "mods", m);
  saveBackup(path.join("mods", m));
  if (!dry) {
    // mod.json first: herdr docks a mod folder it sees without one into the shown layout.
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    const modJson = path.join(src, "mods", m, "mod.json");
    if (fs.existsSync(modJson)) fs.copyFileSync(modJson, path.join(to, "mod.json"));
    fs.cpSync(path.join(src, "mods", m), to, { recursive: true });
  }
  log(`  mods/${m}/`);
}

// 2. Account launchers (scripts only; your account state and folders stay).
const acc = path.join(src, "accounts");
if (!dry) fs.mkdirSync(path.join(home, "accounts"), { recursive: true });
for (const f of fs.readdirSync(acc)) {
  if (!dry) {
    fs.copyFileSync(path.join(acc, f), path.join(home, "accounts", f));
    if (f.endsWith(".sh") && !win) fs.chmodSync(path.join(home, "accounts", f), 0o755);
  }
  log(`  accounts/${f}`);
}

// 2b. Agent skills (skills/<name>/): copied whole, then linked into ~/.claude/skills and
// ~/.codex/skills by each skill's own install.mjs (a link, so later syncs reach the agents).
const skills = path.join(src, "skills");
if (fs.existsSync(skills)) {
  for (const s of fs.readdirSync(skills)) {
    const to = path.join(home, "skills", s);
    saveBackup(path.join("skills", s));
    if (!dry) {
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(path.join(skills, s), to, { recursive: true });
      const inst = path.join(to, "install.mjs");
      if (fs.existsSync(inst)) {
        const r = spawnSync(process.execPath, [inst], { encoding: "utf8" });
        for (const line of `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").filter(Boolean)) log(`    ${line}`);
      }
    }
    log(`  skills/${s}/`);
  }
}

// 3. keys.json: two bindings, added only where you haven't bound the key yourself.
saveBackup("keys.json");
const keys = readJson("keys.json", {});
keys.global = keys.global ?? {};
const want = { "ctrl-`": "my-status.toggle", [mac ? "cmd-," : "ctrl-,"]: "mod.open:my-settings" };
for (const [k, action] of Object.entries(want)) {
  const mine = keys.global[k];
  if (mine && mine !== action && mine !== "app.settings") { log(`  keys.json: kept your ${k} = ${mine}`); continue; }
  keys.global[k] = action;
}
writeAtomic("keys.json", `${JSON.stringify(keys, null, 2)}\n`);
log("  keys.json: Ctrl+` quick terminal, " + (mac ? "Cmd+," : "Ctrl+,") + " Settings");

// 4. programs.json: agents start through the account launchers, in yolo mode.
saveBackup("programs.json");
const programs = readJson("programs.json", {});
programs.programs = programs.programs ?? {};
const launcher = (tool) => path.join(home, "accounts", win ? `${tool}.ps1` : `${tool}.sh`);
const yolo = {
  claude: [launcher("claude"), "--dangerously-skip-permissions"],
  codex: [launcher("codex"), "--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["gemini", "--yolo"],
  opencode: ["opencode", "--auto"],
  antigravity: ["agy", "--dangerously-skip-permissions"],
};
for (const [k, run] of Object.entries(yolo)) programs.programs[k] = { ...(programs.programs[k] ?? {}), run };
writeAtomic("programs.json", `${JSON.stringify(programs, null, 2)}\n`);
log("  programs.json: Claude Code / Codex through the account launchers, yolo flags");

// 5. Fedra as the shown layout: ask a running app, else set it for the next start.
let switched = false;
if (!dry) {
  try {
    execFileSync("herdr-app", ["do", "layout.switch", "--name", "fedra"], { stdio: "ignore", timeout: 8000 });
    switched = true;
  } catch {}
}
if (!switched) {
  const shared = readJson("shared.json", {});
  shared.layout = "fedra";
  writeAtomic("shared.json", `${JSON.stringify(shared)}\n`);
}
log(`  layout: Fedra ${switched ? "(switched the running app)" : "(shown at the next start)"}`);

if (!dry && fs.existsSync(backup)) log(`\nBackup of what was replaced: ${backup}`);
log("\nDone. Needs Node.js on PATH (folder listing, tokens/s, usage stats, browser helper).");
if (!switched) log("Start herdr-app; Fedra shows. Ctrl+Shift+L cycles layouts.");
