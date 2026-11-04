// A lazy file browser for the focused pane's folder, with bounded read-only previews.
// Personal copy of the shipped `files` mod (cloned from 0.1.12). Changes:
// - Windows folders are listed with Node (~0.1 s) instead of a new PowerShell
//   per folder (~0.5-1 s each, every expand and every 10 s refresh); PowerShell
//   stays the fallback when Node isn't installed.
// - Opening a file widens a narrow panel (back restores its width).
// - Markdown files open rendered, with Preview / Raw tabs.
// - Looks at the disk (Node listing + two git runs) only while someone can see it: not
//   while the panel is hidden or another panel is in front (the copy stays alive and its
//   timer kept spawning processes every 10 s), nor while the window is in the background.
//   A change meanwhile is remembered and refreshed the moment it shows again. Bursts of
//   file events (a build) refresh at most every 2 s, and the panel redraws only when
//   what it shows changed.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, layout, run } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Whether a block showing this mod is on screen: not under a hidden node, and the
// child in front wherever it sits in a stack. Not in the layout at all (a pane or a
// dialog): shown.
function shownIn(node, mod) {
  if (!node || typeof node !== "object") return null;
  if (node.content?.mod === mod) return !node.hidden;
  let found = null;
  for (const child of node.children ?? []) {
    const r = shownIn(child, mod);
    if (r === null) continue;
    const ok = r && !node.hidden && (node.type !== "stack" || !node.active || node.active === child.id);
    if (ok) return true;
    found = false;
  }
  return found;
}

const GAP = 2000; // ms: file events refresh at most this often (a build writes a lot)
const WIDE = 680; // px: the panel's width while a file is open, when it was narrower
// Git marks, most important first when a folder sums up what's under it.
const RANK = { C: 5, D: 4, M: 3, A: 2, U: 1 };
const MARK_TIP = { C: "Conflict", D: "Deleted inside", M: "Modified", A: "Added", U: "Untracked" };
const markColor = (t, m) => (m === "C" || m === "D" ? t.ansi1 : m === "M" ? t.ansi3 : t.ansi2);
const MARKDOWN = new Set(["md", "markdown", "mdx", "mdown"]);

// One folder's entries as JSON; links/junctions count as folders when their target is one.
const NODE_LIST = "const fs=require('fs'),path=require('path');const p=process.argv[1];const out=[];"
  + "for(const d of fs.readdirSync(p,{withFileTypes:true})){if(d.name==='.git')continue;let dir=d.isDirectory();"
  + "if(d.isSymbolicLink()){try{dir=fs.statSync(path.join(p,d.name)).isDirectory()}catch{dir=false}}"
  + "out.push({name:d.name,dir});if(out.length>500)break}process.stdout.write(JSON.stringify(out))";
let nodeWorks = true;

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  if (!on && window()?.platform === "windows" && nodeWorks) {
    let r = null;
    try { r = await exec("node", ["-e", NODE_LIST, path]); }
    catch { nodeWorks = false; } // no Node: PowerShell below from now on
    if (r && r.code === 0) return JSON.parse(r.stdout || "[]");
    if (r && r.code !== 0) throw new Error(r.stderr.split("\n").find((l) => /Error/.test(l)) || r.stderr || "Cannot list this folder");
  }
  if (!on && window()?.platform === "windows") {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Reparse points keep directory attributes even when dangling; check their target.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.lastRefresh = 0; this.stale = false; this.again = false; this.trailing = false; this.found = null;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.poke(cx));
  }

  // Someone can see it: its block is in front and the window is in front.
  live() {
    const inLayout = shownIn(layout(), "my-files");
    return inLayout !== false && window()?.active !== false;
  }

  // A refresh when it's worth one: now if visible (at most every GAP ms), else when it shows.
  poke(cx) {
    if (!this.live()) { this.stale = true; return; }
    const wait = this.lastRefresh + GAP - Date.now();
    if (wait <= 0) return this.refresh(cx);
    if (this.trailing) return;
    this.trailing = true;
    cx.timer.after(wait, (cx) => { this.trailing = false; this.poke(cx); });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.poke(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  // What a refresh found; the panel redraws only when it differs from the last one
  // (clicks, opening a file and a new folder redraw on their own).
  shownState() {
    return JSON.stringify([this.root, [...this.entries], this.marks, this.error, this.limited, this.loading && !this.entries.get("")?.length]);
  }

  changed(cx) {
    const now = this.shownState();
    if (now === this.found) return;
    this.found = now;
    cx.notify();
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd) return;
    // One at a time; a change seen meanwhile gets its own look right after.
    if (this.loading) { this.again = true; return; }
    const context = this.context;
    this.loading = true;
    this.limited = false;
    this.stale = false;
    this.again = false;
    this.lastRefresh = Date.now();
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          // Keyed by the path below the shown folder ("src/app.js"), so Windows' A:\ vs git's A:/ can't miss.
          // Every folder above a change gets the most important mark under it, as in VS Code.
          const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
          const base = norm(cwd), gitTop = norm(top.stdout.trim());
          const win = window()?.platform === "windows";
          const under = (full) => {
            const [a, b] = win ? [full.toLowerCase(), base.toLowerCase()] : [full, base];
            return a === b ? "" : a.startsWith(b + "/") ? full.slice(base.length + 1) : null;
          };
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            const mark = xy === "??" ? "U" : /U|AA|DD/.test(xy) ? "C" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
            const rel = under(`${gitTop}/${entry.slice(3).replace(/\/$/, "")}`);
            if (rel == null) continue;
            marks[rel] = mark;
            const parts = rel.split("/");
            for (let i = parts.length - 1; i > 0; i--) {
              const folder = parts.slice(0, i).join("/");
              if ((RANK[mark] ?? 0) > (RANK[marks[folder]] ?? 0)) marks[folder] = mark;
            }
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) this.loading = false;
        this.changed(cx);
        if (this.again && this.context === context) { this.again = false; this.poke(cx); }
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // From a click: widen a narrow panel so the file reads comfortably.
  open(path, cx) {
    const panel = find(layout(), "panel");
    const w = panel?.size?.px;
    if (w && w < WIDE) {
      this.restoreWidth ??= w;
      run("layout.resize", { id: "panel", px: WIDE });
    }
    this.mdMode = "preview";
    this.show(path, cx);
  }

  back(cx) {
    if (this.restoreWidth && find(layout(), "panel")) run("layout.resize", { id: "panel", px: this.restoreWidth });
    this.restoreWidth = null;
    this.show(null);
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null; this.text = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
        const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        if (MARKDOWN.has(ext)) this.text = value;
        this.code = EditorState.new({ language: MARKDOWN.has(ext) ? "markdown" : LANG[ext] ?? ext, readonly: true,
          value,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[path];
      const tint = mark ? markColor(t, mark) : null;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.open(path, cx))
        .child(entry.dir ? svg(`mods/my-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/my-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().when(Boolean(tint), el => el.text_color(tint)).child(entry.name))
        .when(Boolean(mark), el => el.tooltip(`${MARK_TIP[mark]}${entry.dir ? " (something inside)" : ""}`)
          .child(div().w(14).flex_none().text_right().text_size(11).font_semibold().text_color(tint).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    // Shown again (panel opened, window back in front) after a change it skipped.
    else if (this.stale && this.live()) this.refresh(cx);
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => this.back(cx)).child("←")))
        .child(div().font_semibold().child("Files"))
        .when(this.text != null, el => el.child(h_flex().ml(6).p(2).gap(2).rounded(7).bg(t.chrome).border_1().border_color(t.border)
          .children([["preview", "Preview"], ["raw", "Raw"]].map(([mode, label]) => div().id(`md-${mode}`).px(8).h(22).flex().items_center().rounded(5)
            .text_size(12).cursor_pointer()
            .bg(this.mdMode === mode ? t.raised : t.chrome).text_color(this.mdMode === mode ? t.foreground : t.muted)
            .hover(s => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.mdMode = mode; cx.notify(); }).child(label)))))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file) && this.text != null && this.mdMode !== "raw", el => el.child(
        v_flex().flex_1().min_h(0).px(18).py(12).child(TextView.markdown(`md-view-${this.file}`, this.text).flex_1().min_h(0).scrollable(true).selectable(true))))
      .when(Boolean(this.file) && !(this.text != null && this.mdMode !== "raw"), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}

// >>> PERF-PROBE (temporary, remove) >>>
import { writeTextFile as __pwrite, appHome as __phome, props as __pprops } from "herdr";
import * as __pfs from "fs/promises";
{
  const P = Files.prototype, r0 = P.render, i0 = P.init;
  const dir = `${String(__phome()).replace(/\\/g, "/")}/data/zz-perf-probe`;
  P.render = function (cx) {
    const S = this.__probe ??= { renders: 0, ms: 0, max: 0, slow: 0 };
    const t = Date.now();
    try { return r0.call(this, cx); }
    finally { const d = Date.now() - t; S.renders++; S.ms += d; if (d > S.max) S.max = d; if (d >= 16) S.slow++; }
  };
  P.init = function (props, cx) {
    const out = i0 ? i0.call(this, props, cx) : undefined;
    const S = this.__probe ??= { renders: 0, ms: 0, max: 0, slow: 0 };
    let label = "";
    try { const p = __pprops() ?? {}; label = p.part ?? (p.footer ? "footer" : "") ?? ""; } catch {}
    const id = `my-files${label ? "-" + label : ""}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const born = Date.now();
    let last = null;
    cx.timer.every(5000, (cx) => {
      cx.spawn(async () => {
        try {
          await __pfs.mkdir(dir, { recursive: true }).catch(() => {});
          const text = JSON.stringify({ mod: "my-files", label, id, born, at: Date.now(), ...S });
          await __pwrite(`${dir}/${id}.json`, text, last);
          last = text;
        } catch {}
      });
    });
    return out;
  };
}
// <<< PERF-PROBE <<<
