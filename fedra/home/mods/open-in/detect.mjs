#!/usr/bin/env node
// Finds the code editors / IDEs installed on this machine, with their real icons, for the tab
// bar's "Open" button (mods/my-tabs) and its menu (mods/open-in). Writes and prints JSON:
//   { updated, platform, ides: [{ id, name, exe | app | cmd, icon: "data/ide-icons/<id>.png" | null }] }
// to <app home>/data/ides.json.  Usage: node detect.mjs <app home>
// Windows: known install folders, JetBrains Toolbox scripts, Visual Studio (vswhere); icons are
// pulled out of each .exe. macOS: /Applications and ~/Applications; icons from the app's .icns.
// Linux: editors on PATH. The system file manager is always last.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const appHome = process.argv[2] || path.join(os.homedir(), ".config", "herdr-app");
const iconDir = path.join(appHome, "data", "ide-icons");
const exists = (p) => { try { return Boolean(p) && fs.existsSync(p); } catch { return false; } };
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 }).trim(); } catch { return ""; } };
const found = [];
const add = (ide) => { if (!found.some((x) => x.id === ide.id)) found.push(ide); };

function windows() {
  const L = process.env.LOCALAPPDATA ?? "", PF = process.env.ProgramFiles ?? "C:\\Program Files", PF86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  // id, name, folders to look in, exe name
  const known = [
    ["vscode", "VS Code", [`${L}\\Programs\\Microsoft VS Code`, `${PF}\\Microsoft VS Code`], "Code.exe"],
    ["vscode-insiders", "VS Code Insiders", [`${L}\\Programs\\Microsoft VS Code Insiders`, `${PF}\\Microsoft VS Code Insiders`], "Code - Insiders.exe"],
    ["cursor", "Cursor", [`${L}\\Programs\\cursor`, `${PF}\\Cursor`], "Cursor.exe"],
    ["windsurf", "Windsurf", [`${L}\\Programs\\Windsurf`], "Windsurf.exe"],
    ["zed", "Zed", [`${L}\\Programs\\Zed`], "Zed.exe"],
    ["antigravity", "Antigravity", [`${L}\\Programs\\antigravity`, `${L}\\Programs\\Antigravity`], "Antigravity.exe"],
    ["kiro", "Kiro", [`${L}\\Programs\\Kiro`], "Kiro.exe"],
    ["trae", "Trae", [`${L}\\Programs\\Trae`], "Trae.exe"],
    ["vscodium", "VSCodium", [`${L}\\Programs\\VSCodium`, `${PF}\\VSCodium`], "VSCodium.exe"],
    ["sublime", "Sublime Text", [`${PF}\\Sublime Text`, `${PF}\\Sublime Text 3`], "sublime_text.exe"],
    ["fleet", "Fleet", [`${L}\\Programs\\Fleet`], "Fleet.exe"],
  ];
  for (const [id, name, dirs, exe] of known) {
    const hit = dirs.map((d) => path.join(d, exe)).find(exists);
    if (hit) add({ id, name, exe: hit });
  }
  // JetBrains Toolbox: scripts/<tool>.cmd hold the real exe path.
  const JB = { rider: "Rider", idea: "IntelliJ IDEA", pycharm: "PyCharm", webstorm: "WebStorm", goland: "GoLand", clion: "CLion",
    phpstorm: "PhpStorm", rubymine: "RubyMine", rustrover: "RustRover", datagrip: "DataGrip", studio: "Android Studio", fleet: "Fleet" };
  const scripts = path.join(L, "JetBrains", "Toolbox", "scripts");
  if (exists(scripts)) {
    for (const f of fs.readdirSync(scripts).filter((f) => f.toLowerCase().endsWith(".cmd"))) {
      const key = f.slice(0, -4).toLowerCase();
      const text = fs.readFileSync(path.join(scripts, f), "utf8");
      const exe = /"([^"]+\.exe)"/i.exec(text)?.[1];
      if (exe && exists(exe)) add({ id: key === "fleet" ? "fleet" : `jb-${key}`, name: JB[key] ?? f.slice(0, -4), exe });
    }
  }
  // JetBrains standalone installs: Program Files\JetBrains\<product>\bin\*64.exe
  for (const root of [path.join(PF, "JetBrains"), path.join(PF86, "JetBrains")]) {
    if (!exists(root)) continue;
    for (const product of fs.readdirSync(root)) {
      const bin = path.join(root, product, "bin");
      if (!exists(bin)) continue;
      const exe = fs.readdirSync(bin).find((f) => /64\.exe$/i.test(f) && !/fsnotifier|elevator|restarter|jetbrains_client|remote-dev|launcher/i.test(f));
      if (exe) add({ id: `jb-${exe.replace(/64\.exe$/i, "").toLowerCase()}`, name: product.replace(/\s+\d[\d.]*$/, ""), exe: path.join(bin, exe) });
    }
  }
  // Visual Studio (opens a folder with `devenv <folder>`).
  const vswhere = path.join(PF86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (exists(vswhere)) {
    const devenv = run(vswhere, ["-latest", "-property", "productPath"]).split(/\r?\n/)[0];
    if (devenv && exists(devenv)) add({ id: "visualstudio", name: "Visual Studio", exe: devenv });
  }
  add({ id: "explorer", name: "File Explorer", exe: "explorer.exe", system: true });

  // Real icons, pulled out of each exe (one PowerShell for all of them).
  fs.mkdirSync(iconDir, { recursive: true });
  const jobs = found.filter((i) => !i.system).map((i) => ({ exe: i.exe, out: path.join(iconDir, `${i.id}.png`) }));
  if (jobs.length) {
    const list = jobs.map((j) => `@('${j.exe.replace(/'/g, "''")}','${j.out.replace(/'/g, "''")}')`).join(",");
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -AssemblyName System.Drawing; foreach ($j in @(${list})) { try { $i = [System.Drawing.Icon]::ExtractAssociatedIcon($j[0]); $i.ToBitmap().Save($j[1], [System.Drawing.Imaging.ImageFormat]::Png) } catch {} }`]);
  }
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Add-Type -AssemblyName System.Drawing; try { [System.Drawing.Icon]::ExtractAssociatedIcon("$env:WINDIR\\explorer.exe").ToBitmap().Save('${path.join(iconDir, "explorer.png").replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) } catch {}`]);
}

function mac() {
  const apps = [
    ["vscode", "VS Code", "Visual Studio Code"], ["vscode-insiders", "VS Code Insiders", "Visual Studio Code - Insiders"],
    ["cursor", "Cursor", "Cursor"], ["windsurf", "Windsurf", "Windsurf"], ["zed", "Zed", "Zed"], ["antigravity", "Antigravity", "Antigravity"],
    ["kiro", "Kiro", "Kiro"], ["trae", "Trae", "Trae"], ["vscodium", "VSCodium", "VSCodium"], ["sublime", "Sublime Text", "Sublime Text"],
    ["xcode", "Xcode", "Xcode"], ["nova", "Nova", "Nova"], ["fleet", "Fleet", "Fleet"],
    ["jb-rider", "Rider", "Rider"], ["jb-idea", "IntelliJ IDEA", "IntelliJ IDEA"], ["jb-idea-ce", "IntelliJ IDEA CE", "IntelliJ IDEA CE"],
    ["jb-webstorm", "WebStorm", "WebStorm"], ["jb-pycharm", "PyCharm", "PyCharm"], ["jb-pycharm-ce", "PyCharm CE", "PyCharm CE"],
    ["jb-goland", "GoLand", "GoLand"], ["jb-clion", "CLion", "CLion"], ["jb-phpstorm", "PhpStorm", "PhpStorm"], ["jb-rustrover", "RustRover", "RustRover"],
    ["android-studio", "Android Studio", "Android Studio"],
  ];
  const roots = ["/Applications", path.join(os.homedir(), "Applications"), path.join(os.homedir(), "Applications", "JetBrains Toolbox")];
  fs.mkdirSync(iconDir, { recursive: true });
  for (const [id, name, bundle] of apps) {
    const app = roots.map((r) => path.join(r, `${bundle}.app`)).find(exists);
    if (!app) continue;
    add({ id, name, app });
    const iconName = run("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", path.join(app, "Contents", "Info.plist")]);
    const icns = iconName && path.join(app, "Contents", "Resources", iconName.endsWith(".icns") ? iconName : `${iconName}.icns`);
    if (icns && exists(icns)) run("/usr/bin/sips", ["-s", "format", "png", "-z", "64", "64", icns, "--out", path.join(iconDir, `${id}.png`)]);
  }
  add({ id: "finder", name: "Finder", app: "/System/Library/CoreServices/Finder.app", system: true });
}

function linux() {
  const bins = [["vscode", "VS Code", "code"], ["cursor", "Cursor", "cursor"], ["windsurf", "Windsurf", "windsurf"], ["zed", "Zed", "zed"],
    ["vscodium", "VSCodium", "codium"], ["sublime", "Sublime Text", "subl"], ["jb-idea", "IntelliJ IDEA", "idea"], ["jb-rider", "Rider", "rider"],
    ["jb-webstorm", "WebStorm", "webstorm"], ["jb-pycharm", "PyCharm", "pycharm"]];
  for (const [id, name, bin] of bins) { const p = run("sh", ["-c", `command -v ${bin}`]); if (p) add({ id, name, cmd: p }); }
  add({ id: "files", name: "Files", cmd: "xdg-open", system: true });
}

if (process.platform === "win32") windows();
else if (process.platform === "darwin") mac();
else linux();

const rel = (id) => (exists(path.join(iconDir, `${id}.png`)) ? `data/ide-icons/${id}.png` : null);
const result = { updated: Date.now(), platform: process.platform, ides: found.map((i) => ({ ...i, icon: rel(i.id) })) };
const outFile = path.join(appHome, "data", "ides.json");
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(`${outFile}.tmp`, JSON.stringify(result, null, 1));
fs.renameSync(`${outFile}.tmp`, outFile);
process.stdout.write(JSON.stringify(result));
