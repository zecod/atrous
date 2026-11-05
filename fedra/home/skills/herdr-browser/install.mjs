#!/usr/bin/env node
// Makes the herdr-browser skill visible to Claude Code (~/.claude/skills) and Codex
// (~/.codex/skills) as a link to this folder, so updates here reach both at once.
// A junction on Windows (no admin rights needed), a symlink elsewhere. Never replaces a real
// folder of the same name; an existing link is pointed here again. Account profiles made by
// herdr's Settings > Accounts share these skills folders, so they see it too.
//
//   node install.mjs [--remove]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = "herdr-browser";
const remove = process.argv.includes("--remove");
const roots = [
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "skills"),
  path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills"),
];

for (const [i, root] of roots.entries()) {
  const tool = i === 0 ? "Claude Code" : "Codex";
  if (!fs.existsSync(path.dirname(root))) { console.log(`${tool}: not installed here (${path.dirname(root)} missing), skipped`); continue; }
  const at = path.join(root, NAME);
  let st = null;
  try { st = fs.lstatSync(at); } catch {}
  if (st && !st.isSymbolicLink()) {
    console.log(`${tool}: ${at} is a real folder, left alone`);
    continue;
  }
  // Remove the link itself, never what it points to.
  if (st) process.platform === "win32" ? fs.rmdirSync(at) : fs.unlinkSync(at);
  if (remove) { console.log(`${tool}: removed ${at}`); continue; }
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(HERE, at, process.platform === "win32" ? "junction" : "dir");
  console.log(`${tool}: ${at} -> ${HERE}`);
}
