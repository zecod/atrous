// Worktree dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space; optional { branch, tab, argv }.
// Drawn like Fedra's dialogs: the title and what it does, the field, then a footer with the
// keys and the buttons (Remove in red); while git works, a spinner and its step.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home } from "atrous";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
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
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
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
        cx.notify();
        if (props().branch) return await this.work(cx);
        // Enter pressed while the repo was still being read: do it now.
        if (this.queued) { this.queued = false; if (repo) return await this.work(cx); }
        // What a new branch starts from: this checkout's branch (or commit).
        if (repo && !this.opening && props().action !== "remove") {
          const head = await git(repo.top, ["rev-parse", "--abbrev-ref", "HEAD"], this.on);
          this.from = head.ok && head.out !== "HEAD" ? head.out : (await git(repo.top, ["rev-parse", "--short", "HEAD"], this.on)).out || "HEAD";
          cx.notify();
        }
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
    // The open list's filter submits too: its Enter is the list's (key()), never a create.
    if (this.busy || this.opening) return;
    // Still reading the repo: keep the Enter for when it's known, instead of dropping it.
    if (this.repo === undefined) { this.queued = true; cx.notify(); return; }
    if (!this.repo) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = props().action === "remove" ? await this.remove() : await this.create(); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create() {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    const path = `${ROOT(this.userHome)}/${this.repo.name}/${slug(branch)}`;
    const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
    const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
    const r = await git(this.repo.top, add, this.on);
    if (!r.ok) return r.err || "git worktree add failed.";
    const p = props();
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
    run("space.new", { folder: path, machine: this.on, tab: p.tab, argv: p.argv });
    return "";
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path, machine: this.on });
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
    // Not while git works: closing then would leave a checkout behind with no space.
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
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, spaceList, paneList);
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
            .when(c.main, (el) => el.child(div().flex_none().px(5).h(16).flex().items_center().rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const plural = all.length === 1 ? "" : "s";
    const count = rows.length === all.length ? `${all.length} checkout${plural}` : `${rows.length} of ${all.length} checkout${plural}`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .bg(t.popover)
      .text_size(13)
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .px(18)
          .pt(18)
          .pb(12)
          .gap(10)
          .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r && this.list ? count : "")))
          .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("Reading the repository\u2026")))
          .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
          .when(Boolean(r && this.list), (el) =>
            el
              .child(Input.new(this.input).h(34).px(10).items_center().rounded(8).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
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
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .px(16)
          .py(12)
          .gap(8)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child("Enter to open \u00b7 Esc to close")),
      );
  }

  // Fedra's button: h32, rounded 8, solid (primary) or raised (secondary).
  // danger: the destructive primary (Remove), in the theme's needs-you red.
  button(id, label, primary, enabled, action, t, busy = false, danger = false) {
    const fill = danger ? t.blocked : t.solid, ink = danger ? t.background : t.solid_foreground;
    return h_flex().id(id).h(32).px(14).gap(7).flex_none().items_center().rounded(8).border_1()
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
        ? "Reading the repository\u2026"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`
          : remove
            ? !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : `Closes the space and deletes ${tilde(r.top, this.userHome)}. The branch stays.`
            : `A checkout in ${tilde(ROOT(this.userHome), this.userHome)}/${r.name}/, opened as its own space. A branch that exists is checked out; a new one starts from here.`;
    const typed = this.text.trim().length > 0;
    const showGo = !(r === null || (remove && r && !r.linked));
    const canGo = !this.busy && (remove ? Boolean(r?.linked) : r !== null && typed);
    // Cancel stays off while git runs: closing then would leave a checkout behind with no space.
    const cancel = this.button("wt-cancel", showGo ? "Cancel" : "Close", false, !this.busy, () => this.close(), t);
    const go = this.button("wt-go", this.busy ? (remove ? "Removing\u2026" : "Creating\u2026") : remove ? "Remove" : "Create worktree", true, canGo, (_e, cx) => this.go(cx), t, this.busy, remove);
    const hint = this.busy ? "Keep this open until it's done" : this.queued ? "Reading the repository\u2026" : showGo ? (remove ? "Enter to remove \u00b7 Esc to cancel" : "Enter to create \u00b7 Esc to cancel") : "Esc to close";
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
          .child(div().text_size(12.8).line_height("18px").text_color(t.muted).child(line))
          .when(remove && this.dirty && Boolean(r?.linked), (el) => el.child(div().text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
          .when(remove && this.unpushed.length > 0 && Boolean(r?.linked), (el) => el.child(div().text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
          // Shown while the repo is still being read too, so it has the keyboard from the start.
          .when(!remove && r !== null, (el) =>
            el.child(
              v_flex()
                .gap(6)
                .child(Input.new(this.input).h(34).px(10).items_center().rounded(8).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
                .when(Boolean(r), (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(`from ${this.from ?? "\u2026"} \u00b7 ${r.name}`))),
            ),
          )
          .when(this.busy, (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
            .child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))
            .child(div().flex_1().min_w(0).truncate().child(remove ? "Removing the checkout\u2026" : "Checking out the branch\u2026"))))
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
