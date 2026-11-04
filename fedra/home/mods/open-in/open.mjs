#!/usr/bin/env node
// Opens a folder in one of the editors detect.mjs found, detached (returns at once).
//   node open.mjs '<ide json from data/ides.json>' <folder>
import { spawn } from "node:child_process";

const ide = JSON.parse(process.argv[2] ?? "{}");
const folder = process.argv[3];
if (!folder) { console.error("no folder"); process.exit(2); }

let cmd, args, shell = false;
if (ide.app) { cmd = "open"; args = ide.system ? [folder] : ["-a", ide.app, folder]; }
else if (ide.exe) { cmd = ide.exe; args = [folder]; shell = /\.(cmd|bat)$/i.test(ide.exe); }
else if (ide.cmd) { cmd = ide.cmd; args = [folder]; }
else { console.error("unknown editor"); process.exit(2); }

const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false, shell });
child.on("error", (e) => { console.error(String(e.message ?? e)); process.exit(1); });
child.unref();
setTimeout(() => process.exit(0), 300);
