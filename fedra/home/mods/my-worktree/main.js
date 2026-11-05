// Worktree dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space; optional { branch, tab, argv }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, core, home, appHome, readTextFile, writeTextFile, layout } from "atrous";

// The side panel as it is now (Fedra's Files / Changes / Browser; null: closed; undefined: the
// layout has none). The start screen closes it while it shows and puts this back after a pick.
function panelNow() {
  const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).reduce((f, c) => f ?? find(c, id), null));
  const panel = find(layout(), "panel");
  if (!panel) return undefined;
  return panel.hidden ? null : find(panel, "panel-body")?.active ?? null;
}

// A worktree's new space opens on the start screen (mods/start: a button per installed agent),
// not on a bare shell: space.new always starts a terminal, and the start tab, queued right after
// it into the space it made, closes that terminal's tab when it first shows.
function openProject(folder, machine) {
  const existing = spaces().map((s) => s.id);
  const panel = panelNow();
  run("space.new", { folder, machine: machine ?? "" });
  const fresh = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  run("tab.new", { name: "Start", mod: "start", props: { folder, machine: machine || null, fresh, existing, panel } });
}

// What each dialog did, newest last (data/: Atrous doesn't reload mods for writes there).
function trace(line) {
  const file = `${appHome()}/data/my-worktree-trace.log`;
  return (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const old = await readTextFile(file);
        const lines = (old ?? "").split("\n").filter(Boolean).slice(-79);
        lines.push(`${new Date().toISOString()} ${line}`);
        await writeTextFile(file, lines.join("\n") + "\n", old ?? null);
        return;
      } catch {}
    }
  })();
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Checkouts go to <ROOT>/<repo>/<branch, slashes as dashes>.
const ROOT = (home) => `${home}/.atrous/worktrees`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaces().find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.opened = Date.now();
    trace(`open ${props()?.action ?? "new"} space=${props()?.space ?? "-"} folder=${props()?.folder ?? "-"}`);
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.text = props()?.branch ?? "";
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    if (props()?.action !== "remove") {
      this.input.focus();
      cx.timer.after(50, () => this.input.focus()); // once the input is on screen
      cx.timer.after(600, () => this.input.focus());
    }
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    this.handle = cx.focus_handle();
    if (props()?.action === "remove") this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const repo = await repoOf(this.folder, this.on);
        if (repo && props().action === "remove") {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          this.unpushed = (await submodules(repo.top, this.on)).unpushed;
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        this.repo = repo;
        trace(`${props().action} in ${this.folder}: ${repo ? `repo ${repo.main}` : "not a repo"} after ${Date.now() - this.opened}ms`);
        cx.notify();
        // An input focused before it is on screen doesn't keep the keyboard: focus it
        // again now that it shows (the open list appears only now; a slow disk makes
        // the 600 ms retry above too early).
        if (props()?.action !== "remove") cx.timer.after(50, () => this.input.focus());
        // "from <branch>": what a new branch starts from (HEAD of this checkout).
        if (repo && !this.opening && props()?.action !== "remove") {
          const head = await git(repo.top, ["rev-parse", "--abbrev-ref", "HEAD"], this.on);
          this.from = head.ok && head.out !== "HEAD" ? head.out : (await git(repo.top, ["rev-parse", "--short", "HEAD"], this.on)).out || "HEAD";
          cx.notify();
        }
        // Enter pressed while the repo was still being read: do it now.
        if (this.queued) { this.queued = false; this.progress = null; cx.notify(); if (repo) await this.work(cx); }
        if (props().branch) await this.work(cx);
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(cx) {
    trace(`enter: "${this.text.trim()}" busy=${this.busy} repo=${this.repo === undefined ? "reading" : this.repo ? "yes" : "no"}`);
    if (this.busy) return;
    // The open list's filter submits too: Enter there opens the chosen checkout, never creates.
    if (this.opening) return this.open(this.shown()[this.at]);
    // Still reading the repo: keep the Enter for when it's known, instead of dropping it.
    if (this.repo === undefined) { this.queued = true; this.progress = "Reading the repository…"; cx.notify(); return; }
    if (!this.repo) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = props().action === "remove" ? await this.remove() : await this.create(cx); }
    catch (error) { this.error = String(error); }
    // Closing cancels this copy's tasks: let the line land first (300 ms at most).
    await Promise.race([trace(this.error ? `${props().action} failed: ${this.error}` : `${props().action} done: "${this.text.trim()}"`), cx.sleep(300)]);
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  // `git worktree add` runs in a background atrous-core terminal: checking out a big repo on a
  // slow disk can take longer than exec's 30 s (xgestAI.Cowork: 4,195 files, ~9 s idle, far
  // more while agents build), and the dialog shows git's progress meanwhile.
  async create(cx) {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    const path = `${ROOT(this.userHome)}/${this.repo.name}/${slug(branch)}`.replaceAll("\\", "/");
    const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
    const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
    const args = ["run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", this.repo.top];
    if (this.on) args.push("--on", this.on);
    const started = await core([...args, "--", "git", ...add]);
    if (started.code !== 0) return (started.stderr || started.stdout || "Couldn't start git.").trim();
    const job = JSON.parse(started.stdout).address;
    this.progress = "Preparing the checkout…";
    cx.notify();
    const wait = (ms) => new Promise((resolve) => cx.timer.after(ms, () => resolve()));
    let lines = [];
    for (;;) {
      await wait(400);
      const g = await core(["get", job, "--json"]).catch(() => null);
      const info = g?.code === 0 ? JSON.parse(g.stdout) : null;
      const screen = info ? await core(["read", job]).catch(() => null) : null;
      if (screen) lines = screen.stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
      const last = (lines[lines.length - 1] ?? "").split("\r").pop().trim();
      if (info && info.state !== "finished") {
        this.progress = last || "Checking out files…";
        cx.notify();
        continue;
      }
      await core(["rm", job]).catch(() => {});
      this.progress = null;
      if (info?.exit_code !== 0) return lines.filter((l) => /fatal|error|already/i.test(l)).slice(-2).join("\n") || lines.slice(-2).join("\n") || "git worktree add failed.";
      break;
    }
    const p = props();
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo. Asked for
    // an agent (props argv): it starts there; else the start screen offers them.
    if (p.argv) run("space.new", { folder: path, machine: this.on, tab: p.tab, argv: p.argv });
    else openProject(path, this.on);
    return "";
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c || this.chosen) return; // Enter reaches both the filter's submit and the list's keys
    this.chosen = true;
    this.close();
    const s = spaceOf(c.path, this.list, this.on);
    if (s) run("space.select", { id: s.id });
    else openProject(c.path, this.on);
  }

  async remove() {
    const s = this.space();
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    // git refuses a worktree with submodules unless forced, because their
    // history goes with it. The popup already showed what's at risk; only
    // risk that appeared since it opened gets one more warning.
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some((name) => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Enter again removes it anyway.";
    // Terminals first: a shell sitting in the folder keeps it busy on Windows.
    run("space.close", { id: s.id, confirmed: true });
    const force = this.dirty || mods.length > 0;
    const r = await git(this.repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), this.repo.top], this.on);
    return r.ok ? "" : r.err || "git worktree remove failed.";
  }

  key(e, cx) {
    if (e.key === "escape") { if (this.busy) return cx.stop_propagation(); return this.close(); }
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "enter" && props()?.action === "remove") return this.go(cx);
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 esc close"));
  }

  // add-project's button: h32, rounded 8, solid (primary) or raised (secondary).
  // danger: the destructive primary (Remove), in the theme's needs-you red.
  button(id, label, primary, enabled, action, t, busy = false, danger = false) {
    const fill = danger ? t.blocked : t.solid, ink = danger ? t.background : t.solid_foreground;
    return h_flex().id(id).h(32).px(14).gap(7).items_center().rounded(8).border_1()
      .border_color(primary ? fill : t.input).bg(primary ? fill : t.raised)
      .text_color(primary ? ink : t.foreground).text_size(12.5).font_medium()
      .when(!enabled && !busy, (el) => el.opacity(0.45)) // busy: full strength, just not clickable
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .when(busy, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(primary ? ink : t.foreground).spin(900)))
      .child(label);
  }

  render(cx) {
    const t = theme();
    if (this.opening) return this.renderOpen(t);
    const remove = props()?.action === "remove";
    const s = this.space();
    const r = this.repo;
    const title = remove ? `Remove worktree ${s?.name ?? ""}?` : `New worktree${r ? ` of ${r.name}` : ""}`;
    const line =
      r === undefined
        ? "Reading the repository…"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`
          : remove
            ? !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : `Closes the space and deletes ${tilde(r.top, this.userHome)}. The branch stays.`
            : `A checkout in ${tilde(ROOT(this.userHome), this.userHome)}/${r.name}/, opened as its own space. An existing branch is checked out as is.`;
    const typed = this.text.trim().length > 0;
    const canGo = !this.busy && (remove ? Boolean(r?.linked) : r !== null && typed);
    // Cancel stays off while git runs: closing then would leave a checkout behind with no space.
    const cancel = this.button("wt-cancel", r === null || (remove && r && !r.linked) ? "Close" : "Cancel", false, !this.busy, () => this.close(), t);
    const go = this.button("wt-go", this.busy ? (remove ? "Removing…" : "Creating…") : remove ? "Remove" : "Create worktree", true, canGo, (_e, cx) => this.go(cx), t, this.busy, remove);
    const showGo = !(r === null || (remove && r && !r.linked));
    const hint = this.busy ? "Keep this open until it's done" : showGo ? (remove ? "Enter to remove · Esc to cancel" : "Enter to create · Esc to cancel") : "Esc to close";
    // The content above may shrink and scroll; the footer below never leaves the dialog.
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .max_h_full()
      .bg(t.popover)
      .text_size(13)
      .child(
        v_flex()
          .id("wt-body")
          .flex_shrink(1)
          .min_h(0)
          .overflow_y_scroll()
          .px(18)
          .pt(18)
          .pb(14)
          .gap(10)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
          .child(div().text_color(t.muted).child(line))
          .when(remove && this.dirty, (el) => el.child(div().text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
          .when(remove && this.unpushed.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
          // Shown while the repo is still being read too, so it has the keyboard from the start.
          .when(!remove && r !== null, (el) =>
            el.child(
              v_flex().gap(6)
                .child(Input.new(this.input).h(34).px(10).items_center().rounded(8).border(1)
                  .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
                .when(Boolean(r), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate()
                  .child(`from ${this.from ?? "…"} · ${r.name}`))),
            ),
          )
          .when(Boolean(this.progress), (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
            .when(this.busy, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
            .child(div().flex_1().min_w(0).truncate().child(this.progress))))
          .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error))),
      )
      .child(
        h_flex()
          .flex_none()
          .w_full()
          .px(16)
          .py(12)
          .gap(8)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(hint))
          .child(cancel)
          .when(showGo, (el) => el.child(go)),
      );
  }
}
