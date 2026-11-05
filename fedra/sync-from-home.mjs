#!/usr/bin/env node
// Copies Fedra's files from a working Atrous home (~/.config/atrous) into fedra/home/,
// so the repo can be committed. The reverse of install.mjs. Never copies app state, account
// state/folders, usage data, or files Atrous generates (.d.ts, jsconfig.json).
//
//   node sync-from-home.mjs [--home <path>] [--add <mod>]...
//
// Which mods and layouts: the ones already in fedra/home (each mods/<name>/ and
// layouts/<name>.json there), so a mod or layout another change added is never dropped.
// A new mod comes in with --add <name> (or by creating its folder in fedra/home/mods).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf("--home");
const home = at > 0 ? process.argv[at + 1] : process.env.ATROUS_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "atrous");
const out = path.join(here, "home");

const added = process.argv.flatMap((a, i) => (a === "--add" ? [process.argv[i + 1]] : [])).filter(Boolean);
const listed = (dir, test) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(test).map((e) => e.name) : []);
// Fedra's mods: every folder in fedra/home/mods (onboarding, flow-canvas, my-*, ...), plus --add.
const MODS = [...new Set([...listed(path.join(out, "mods"), (e) => e.isDirectory()), ...added])].sort();
// Fedra's layouts: every layouts/<name>.json in fedra/home (fedra, flow, ...).
const LAYOUTS = listed(path.join(out, "layouts"), (e) => e.isFile() && e.name.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
const SKIP = (name) => name.endsWith(".d.ts") || name === "jsconfig.json" || name === "node_modules"
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

// Each mod is replaced whole; one the home doesn't have stays as the repo has it.
for (const m of MODS) {
  const from = path.join(home, "mods", m);
  if (!fs.existsSync(from)) { console.warn(`  missing mods/${m} in the home: kept as it is here`); continue; }
  fs.rmSync(path.join(out, "mods", m), { recursive: true, force: true });
  copyDir(from, path.join(out, "mods", m));
  console.log(`  mods/${m}/`);
}

// The layouts, without this machine's state: a quick terminal shows a placeholder until a
// shell of the new machine is attached, and starts hidden. (Atrous keeps the quick terminal's
// state as clicks in layouts/.state, so a home's layout file normally has none.)
fs.mkdirSync(path.join(out, "layouts"), { recursive: true });
for (const name of LAYOUTS) {
  const file = path.join(home, "layouts", `${name}.json`);
  if (!fs.existsSync(file)) { console.warn(`  missing layouts/${name}.json in the home: kept as it is here`); continue; }
  const layout = JSON.parse(fs.readFileSync(file, "utf8"));
  const term = find(layout, "quick-terminal-term");
  if (term) term.content = { mod: "my-status", props: { part: "terminal-empty" } };
  const qt = find(layout, "quick-terminal");
  if (qt) qt.hidden = true;
  fs.writeFileSync(path.join(out, "layouts", `${name}.json`), `${JSON.stringify(layout, null, 2)}\n`);
  const svg = path.join(home, "layouts", `${name}.svg`);
  if (fs.existsSync(svg)) fs.copyFileSync(svg, path.join(out, "layouts", `${name}.svg`));
  console.log(`  layouts/${name}.json${fs.existsSync(svg) ? `, ${name}.svg` : ""}`);
}

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
