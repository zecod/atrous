// The Changes panel: what changed in the focused pane's git repository, the diff of the
// picked file, and a commit box. Drawn like the Files panel (my-files):
// - the same git marks in the same colors: M modified, A added, D deleted, U untracked,
//   C conflict; a file's name takes its mark's color;
// - it looks at the disk (git status, its numbers, the shown diff) only while someone can
//   see it: its block in front (not under a hidden node, the stack's shown child) and, for
//   the 10 s look and file events, the window in front too. A change meanwhile is
//   remembered and looked at the moment it shows again. Bursts of file events (a build)
//   look at most every 2 s, and the panel redraws only when what it shows changed.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, layout } from "atrous";

const MOD = "changes";
const GAP = 2000; // ms: file events look at most this often
const MARK_TIP = { C: "Conflict", D: "Deleted", M: "Modified", A: "Added", U: "Untracked" };
const markColor = (t, m) => (m === "C" || m === "D" ? t.ansi1 : m === "M" ? t.ansi3 : t.ansi2);

// Whether a block showing this mod is on screen: not under a hidden node, and the child in
// front wherever it sits in a stack. Not in the layout at all (a pane, a dialog): shown.
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

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// A short fingerprint of the diff, so a refresh that found the same one doesn't redraw.
function fingerprint(lines) {
  let h = 2166136261;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 10, 16777619);
  }
  return `${lines.length}:${h >>> 0}`;
}

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.diffSig = ""; this.message = ""; this.handle = cx.focus_handle();
    this.lastRefresh = 0; this.stale = false; this.again = false; this.trailing = false; this.found = null;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.reset(key());
    // The first look (and a new folder's) as soon as the panel shows; then the timer and
    // file events only while the window is in front as well.
    if (this.visible()) this.refresh(cx);
    else this.stale = true;
    cx.timer.every(10000, (cx) => this.poke(cx));
  }

  // Its block is on screen (in the layout: in front; a pane or a dialog: always).
  visible() {
    return shownIn(layout(), MOD) !== false;
  }

  // Someone can see it: its block is in front and the window is in front.
  live() {
    return this.visible() && window()?.active !== false;
  }

  // A look when it's worth one: now if visible (at most every GAP ms), else when it shows.
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
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.poke(cx);
        }
      } catch { if (this.watched === root) this.watched = null; }
    });
  }

  // Another folder: forget the last one's files, diff and message.
  reset(context) {
    this.context = context; this.root = null; this.files = []; this.open = null;
    this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
  }

  // What a look found; the panel redraws only when it differs from the last one
  // (clicks, typing and a commit redraw on their own).
  changed(cx) {
    const now = JSON.stringify([this.context, this.root, this.files, this.error, this.limited, this.open, this.diffSig, this.loading && !this.files.length]);
    if (now === this.found) return;
    this.found = now;
    cx.notify();
  }

  refresh(cx) {
    const { cwd, on } = location(), context = key();
    if (context !== this.context) this.reset(context);
    if (!cwd) return;
    // One at a time (and never during a commit); a change seen meanwhile gets its own look right after.
    if (this.loading || this.busy) { this.again = true; return; }
    this.loading = true; this.stale = false; this.again = false; this.lastRefresh = Date.now();
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          // The Files panel's marks: untracked U, conflict C, then deleted, added, modified.
          const s = fresh ? "U" : /U|AA|DD/.test(xy) ? "C" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          // An untracked file's lines, once its diff has been shown (git has no numbers for it).
          const known = fresh ? this.files.find((f) => f.path === path && f.fresh) : null;
          files.push({ path, status: s, fresh, ...stat, ...(known ? { add: known.add } : {}) });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        this.changed(cx);
        if (this.again && this.context === key()) { this.again = false; this.poke(cx); }
      }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffSig = fingerprint(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 70));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // One changed file: its icon, name (in its mark's color) and folder, the lines it adds and
  // removes, and its mark, where the Files panel puts it.
  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop(), tint = markColor(t, f.status), on = this.open === f.path;
    return h_flex().id(`change-${f.path}`).h(28).flex_none().pl(8).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
      .tooltip(`${MARK_TIP[f.status]} · ${f.path}`)
      .on_click((_e, cx) => this.pick(f.path, cx))
      .child(svg("mods/changes/file.svg").size(14).flex_none().text_color(t.muted))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_none().max_w(260).truncate().text_color(tint).when(f.status === "D", (e) => e.line_through()).child(name))
        .when(parts.length > 0, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(parts.join("/")))))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
      .child(div().w(14).flex_none().text_right().text_size(11).font_semibold().text_color(tint).child(f.status));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().flex().items_center().bg(t.raised).text_color(t.dim).child(div().truncate().child(text));
    const add = kind === "+", del = kind === "-";
    return h_flex().w_full().h(20).flex_none().gap(6).items_center()
      .when(add, (e) => e.bg(t.ansi2 + "1f")).when(del, (e) => e.bg(t.ansi1 + "1f"))
      .child(div().w(36).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(12).flex_none().text_center().text_color(add ? t.ansi2 : del ? t.ansi1 : t.dim).child(add ? "+" : del ? "−" : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // Fedra's button: h32, rounded 8, solid (primary) or raised (secondary), a spinner while busy.
  button(id, label, enabled, busy, action, t) {
    return h_flex().id(id).h(32).px(14).gap(7).flex_none().items_center().rounded(8).border_1()
      .border_color(t.solid).bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_medium()
      .when(!enabled && !busy, (el) => el.opacity(0.45))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .when(busy, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.solid_foreground).spin(900)))
      .child(label);
  }

  render(cx) {
    // Another folder: a look now if the panel shows (else when it does). Shown again (panel
    // opened, window back in front) after a change it skipped: a look now.
    if (key() !== this.context) {
      if (this.visible()) this.refresh(cx);
      else { this.reset(key()); this.stale = true; }
    } else if (this.stale && !this.loading && this.live()) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const empty = this.error || (this.loading ? "Looking for changes…" : this.root ? "No uncommitted changes" : location().cwd ? "Looking for changes…" : "No folder");
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .when(this.files.length > 0, (e) => e.child(div().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(11).text_color(t.muted)
          .child(`${this.files.length}${this.limited ? "+" : ""} file${this.files.length === 1 ? "" : "s"}`)))
        .child(div().flex_1())
        .when(add > 0, (e) => e.child(div().text_size(12).text_color(t.ansi2).child(`+${add}`)))
        .when(del > 0, (e) => e.child(div().text_size(12).text_color(t.ansi1).child(`−${del}`)))
        .when(!add && !del, (e) => e.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? ""))))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border)
        .children(this.files.map((f) => this.fileRow(f, t)))
        .when(!this.files.length, (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child(empty))))
      .when(this.limited, el => el.child(div().px(14).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11.5)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(10).left(0).right(0).px(14).font_family(settings().ui_font_family ?? "Geist").text_size(12).text_color(t.dim).child("Pick a file to see what changed in it"))))
      .when(Boolean(this.note), (e) => e.child(div().px(14).py(6).text_size(12).text_color(t.blocked).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.input).bg(t.background).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)))
        .child(this.button("commit", this.busy ? "Committing…" : "Commit", enabled, Boolean(this.busy), (_e, cx) => this.commit(cx), t)));
  }
}
