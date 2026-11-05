#!/usr/bin/env node
// Puts Atrous's OpenCode status plugin (atrous-status.js beside this file) into OpenCode's global
// plugin folder, or takes it out. Run by Settings > Privacy > Agents ("OpenCode status in
// Atrous", my-settings) and, on start, by the status bar (my-status) while that switch is on.
//
//   node install.mjs install   copy it there (only when OpenCode's config folder exists, or --force)
//   node install.mjs remove    delete it, if it's ours
//   node install.mjs status    print where it goes and whether it's there and current
//   --home <dir>               the home folder (Atrous passes its own; default: this user's)
//
// Where: $XDG_CONFIG_HOME/opencode/plugins/atrous-status.js, else <home>/.config/opencode/plugins/
// (OpenCode's global config folder on Windows, macOS and Linux alike). It touches only that one
// file, and only one that says it's Atrous's: someone's own file of the same name is left alone.
// Prints one line of JSON.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "atrous-status.js");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const config = path.join(process.env.XDG_CONFIG_HOME || path.join(arg("--home") || os.homedir(), ".config"), "opencode");
const target = path.join(config, "plugins", "atrous-status.js");
const MARK = "atrous-opencode-status";

const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const print = (o) => process.stdout.write(JSON.stringify({ target, ...o }));

const op = process.argv[2] ?? "status";
const want = read(source);
const have = read(target);
const ours = have != null && have.includes(MARK);

if (op === "status") {
  print({ opencode: fs.existsSync(config), installed: ours, current: ours && have === want, foreign: have != null && !ours });
} else if (op === "install") {
  if (!want) print({ ok: false, why: "no atrous-status.js beside install.mjs" });
  else if (!fs.existsSync(config) && !process.argv.includes("--force")) print({ ok: false, why: "OpenCode isn't set up here (no config folder)" });
  else if (have != null && !ours) print({ ok: false, why: "a file of that name that isn't Atrous's is there" });
  else if (have === want) print({ ok: true, changed: false });
  else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.atrous-tmp`;
    fs.writeFileSync(tmp, want);
    fs.renameSync(tmp, target);
    print({ ok: true, changed: true });
  }
} else if (op === "remove") {
  if (have == null) print({ ok: true, changed: false });
  else if (!ours) print({ ok: false, why: "that file isn't Atrous's" });
  else { fs.unlinkSync(target); print({ ok: true, changed: true }); }
} else {
  print({ ok: false, why: `unknown operation ${op}` });
  process.exitCode = 2;
}
