#!/usr/bin/env node
// Copies Fedra's files from a working herdr-app home (~/.config/herdr-app) into fedra/home/,
// so the repo can be committed. The reverse of install.mjs. Never copies app state, account
// state/folders, usage data, or files herdr generates (.d.ts, jsconfig.json).
//
//   node sync-from-home.mjs [--home <path>]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf("--home");
const home = at > 0 ? process.argv[at + 1] : process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app");
const out = path.join(here, "home");

const MODS = [
  "accounts", "add-project", "agent-menu", "browser-panel", "my-chrome", "my-files", "my-menu",
  "my-new-menu", "my-pane", "my-settings", "my-spaces", "my-status", "my-tabs", "my-worktree", "open-in",
  "snap-split", "usage-card", "usage-stats",
];
const SKIP = (name) => name === "gpui-kit.d.ts" || name === "jsconfig.json" || name === "node_modules"
  || name === "bin" || name === "obj" || name.startsWith(".")
  || /\.(tmp|error|log|fedra-tmp)$/.test(name) || /\.(exe|dll|pdb)$/i.test(name);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP(e.name)) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

fs.rmSync(path.join(out, "mods"), { recursive: true, force: true });
for (const m of MODS) {
  const from = path.join(home, "mods", m);
  if (!fs.existsSync(from)) { console.warn(`  missing mods/${m}`); continue; }
  copyDir(from, path.join(out, "mods", m));
  console.log(`  mods/${m}/`);
}

// The layout, without this machine's state: the quick terminal shows a placeholder until a
// shell of the new machine is attached, and starts hidden.
fs.mkdirSync(path.join(out, "layouts"), { recursive: true });
const layout = JSON.parse(fs.readFileSync(path.join(home, "layouts", "fedra.json"), "utf8"));
const term = find(layout, "quick-terminal-term");
if (term) term.content = { mod: "my-status", props: { part: "terminal-empty" } };
const qt = find(layout, "quick-terminal");
if (qt) qt.hidden = true;
fs.writeFileSync(path.join(out, "layouts", "fedra.json"), `${JSON.stringify(layout, null, 2)}\n`);
fs.copyFileSync(path.join(home, "layouts", "fedra.svg"), path.join(out, "layouts", "fedra.svg"));
console.log("  layouts/fedra.json, fedra.svg");

// Agent skills (skills/<name>/): SKILL.md, their scripts and docs.
fs.rmSync(path.join(out, "skills"), { recursive: true, force: true });
for (const s of fs.existsSync(path.join(home, "skills")) ? fs.readdirSync(path.join(home, "skills")) : []) {
  copyDir(path.join(home, "skills", s), path.join(out, "skills", s));
  console.log(`  skills/${s}/`);
}

fs.rmSync(path.join(out, "accounts"), { recursive: true, force: true });
fs.mkdirSync(path.join(out, "accounts"), { recursive: true });
for (const f of fs.readdirSync(path.join(home, "accounts"))) {
  if (!/\.(sh|ps1|mjs)$/.test(f)) continue; // never state.json or account folders
  fs.copyFileSync(path.join(home, "accounts", f), path.join(out, "accounts", f));
  console.log(`  accounts/${f}`);
}
console.log(`Synced from ${home}`);
