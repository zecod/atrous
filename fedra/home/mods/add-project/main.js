// Add a project: what the Spaces "+" opens (my-spaces), or `mod.open add-project`.
// Browse for a folder with the system picker, clone a Git repository, create a
// new folder, or branch the current repo into a worktree. The project opens as
// a new space; if a space already shows that folder, that space is selected.
//
// Props: { machine } — the host to add on (null: this computer).
// Clones run in a background atrous-core terminal (`atc run --bg`), so a big repo
// isn't cut off by exec's 30 s limit; the dialog shows git's last line and
// stops the clone if it is closed or "Stop" is pressed.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, core, exec, home, pickFolder, spaces, panes, shared, setShared, window, nextCommand } from "atrous";

const I = (name) => `mods/add-project/${name}.svg`;
// Shared: host ("" = this computer) -> the folder the last project went in.
const PARENTS = "add-project.parents";

const repoName = (url) => url.trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "").split(/[\\/:]/).pop() ?? "";
const badName = (name) => !name || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name);
const quotePs = (s) => `'${s.replace(/'/g, "''")}'`;

function join(parent, name, win) {
  const sep = win && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
}

function parentOf(path) {
  const p = path.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return p;
  if (i === 0) return p.slice(0, 1);
  const up = p.slice(0, i);
  return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up;
}

function same(a, b, win) {
  const n = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return win ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function errorText(r) {
  try {
    const msg = JSON.parse(r.stdout || r.stderr)?.error?.message;
    if (msg) return msg;
  } catch {}
  return (r.stderr || r.stdout || "").trim();
}

const PLATFORM = { windows: "Windows", macos: "Mac", linux: "Linux" };

export default class AddProject extends View {
  init(_props, cx) {
    this.host = props()?.machine ?? null;
    this.hosts = [null];
    this.view = "home";
    this.error = null;
    this.busy = null; // what is happening now (git's last line while cloning)
    this.job = null; // { address, dest, parent } of a running clone
    this.git = true;
    this.vals = { url: "", loc: "", name: "", path: "" };
    this.focusedInput = null;
    this.autoName = "";
    this.nameTouched = false;
    this.inputs = {
      url: this.input("url", "https://github.com/owner/repo.git"),
      loc: this.input("loc", ""),
      name: this.input("name", ""),
      path: this.input("path", "/home/you/project"),
    };
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => { if (this.view === "home") this.handle.focus(); });
    cx.spawn(async (cx) => {
      try {
        const r = await core(["machine", "ls", "--json"]);
        if (r.code === 0) this.hosts = [null, ...(JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary).map((m) => m.name)];
      } catch {}
      if (!this.hosts.includes(this.host)) this.host = null;
      cx.notify();
    });
    cx.timer.every(700, (cx) => this.poll(cx));
    // keys.json / `atrous do`: add-project.home | add-project.clone | add-project.create
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (["home", "clone", "create"].includes(c) && !this.busy) this.go(c, cx);
      }
    });
  }

  input(key, placeholder) {
    const s = InputState.new({ placeholder });
    s.on("change", (_e, cx) => {
      this.vals[key] = s.value();
      if (key === "url" && !this.nameTouched) this.setVal("name", (this.autoName = repoName(this.vals.url)));
      if (key === "name") this.nameTouched = this.vals.name !== this.autoName;
      if (!this.busy) this.error = null;
      cx.notify();
    });
    s.on("submit", (_e, cx) => this.submit(cx));
    s.on("focus", (_e, cx) => { this.focusedInput = key; cx.notify(); });
    s.on("blur", (_e, cx) => { if (this.focusedInput === key) this.focusedInput = null; cx.notify(); });
    return s;
  }

  setVal(key, value) {
    this.vals[key] = value;
    this.inputs[key].set_value(value);
  }

  get local() { return !this.host; }
  get win() { return this.local && window()?.platform === "windows"; }

  hostLabel(host) {
    return host ?? `Local ${PLATFORM[window()?.platform] ?? "computer"}`;
  }

  // Where new projects go: the last place used on this host, else beside the
  // project you're in, else home.
  defaultParent() {
    const saved = (shared(PARENTS) ?? {})[this.host ?? ""];
    if (saved) return saved;
    if (!this.local) return "";
    const s = spaces().find((x) => x.active && !x.machine);
    const tabs = new Set((s?.tabs ?? []).map((t) => t.id));
    const cwd = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s?.folder;
    return !cwd || same(cwd, home(), this.win) ? home() : parentOf(cwd);
  }

  remember(parent) {
    setShared(PARENTS, { ...(shared(PARENTS) ?? {}), [this.host ?? ""]: parent });
  }

  go(view, cx) {
    this.view = view;
    this.error = null;
    if (view === "clone" || view === "create") {
      this.setVal("loc", this.defaultParent());
      this.autoName = view === "clone" ? repoName(this.vals.url) : "";
      this.nameTouched = false;
      this.setVal("name", this.autoName);
    }
    const first = { clone: "url", create: "name", path: "path" }[view];
    if (first) this.inputs[first].focus();
    else this.handle.focus();
    cx.notify();
  }

  fail(message, cx) {
    this.error = message;
    cx.notify();
  }

  submit(cx) {
    if (this.busy) return;
    if (this.view === "clone") this.clone(cx);
    else if (this.view === "create") this.create(cx);
    else if (this.view === "path") this.openTyped(cx);
  }

  nextHost(cx) {
    this.host = this.hosts[(this.hosts.indexOf(this.host) + 1) % this.hosts.length];
    this.error = null;
    cx.notify();
  }

  async exists(path) {
    if (this.win) {
      const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Test-Path -LiteralPath ${quotePs(path)}`]);
      return r.stdout.trim() === "True";
    }
    return (await exec("test", ["-e", path], { on: this.host })).code === 0;
  }

  // Opens the folder as a space, or selects the space already showing it.
  open(folder) {
    const win = this.win;
    const ps = panes();
    const shows = (s) => same(s.folder, folder, win)
      || (s.tabs ?? []).some((t) => ps.some((p) => p.tab === t.id && same(p.cwd, folder, win)));
    const found = spaces().find((s) => (s.machine ?? null) === this.host && shows(s));
    this.closed = true;
    closeOverlay(props().overlay);
    if (found) run("space.select", { id: found.id });
    else run("space.new", { folder, machine: this.host ?? "" });
  }

  browse(cx) {
    if (!this.local) return this.go("path", cx);
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Add project" });
      if (!folder) return;
      this.remember(parentOf(folder));
      this.open(folder);
    });
  }

  pickLocation(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Choose" });
      if (folder) this.setVal("loc", folder);
      cx.notify();
    });
  }

  worktree(space) {
    const folder = panes().find((p) => p.focused)?.cwd;
    this.closed = true;
    closeOverlay(props().overlay);
    openOverlay({ mod: "my-worktree", kind: "dialog", width: 460, props: { space: space.id, folder, action: "new" } });
  }

  // The form's folder: parent + name, checked before anything runs.
  target(cx) {
    const name = this.vals.name.trim();
    const parent = this.vals.loc.trim();
    if (badName(name)) return this.fail(name ? "That name can't be used as a folder name." : "Give the folder a name.", cx), null;
    if (!parent) return this.fail(this.local ? "Choose where to put it." : `Type the folder on ${this.host} to put it in.`, cx), null;
    return { name, parent, dest: join(parent, name, this.win) };
  }

  clone(cx) {
    const url = this.vals.url.trim();
    if (!url) return this.fail("Paste the repository's URL.", cx);
    const where = this.target(cx);
    if (!where) return;
    this.busy = "Starting git…";
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (await this.exists(where.dest)) throw new Error(`${where.name} already exists in ${where.parent}.`);
        const args = ["run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", where.parent];
        if (this.host) args.push("--on", this.host);
        args.push("--", "git", "clone", "--progress", url, where.name);
        const r = await core(args);
        if (r.code !== 0) throw new Error(errorText(r) || "Couldn't start git.");
        this.job = { address: JSON.parse(r.stdout).address, dest: where.dest, parent: where.parent };
        this.busy = "Cloning…";
      } catch (e) {
        this.busy = null;
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // While a clone runs: git's last line, then the space once it's done.
  poll(cx) {
    const job = this.job;
    if (!job || this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const g = await core(["get", job.address, "--json"]);
        const info = g.code === 0 ? JSON.parse(g.stdout) : null;
        const screen = info ? await core(["read", job.address]) : { stdout: "" };
        const lines = screen.stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
        if (this.job !== job) return;
        if (info && info.state !== "finished") {
          this.busy = lines[lines.length - 1] || "Cloning…";
          return;
        }
        this.job = null;
        if (info) await core(["rm", job.address]).catch(() => {});
        if (info?.exit_code === 0) {
          this.remember(job.parent);
          this.open(job.dest);
          return;
        }
        this.busy = null;
        this.error = lines.slice(-3).join("\n") || (info ? `git exited with code ${info.exit_code}.` : "git stopped before it finished.");
      } catch (e) {
        if (this.job === job) this.busy = `Cloning… (${String(e?.message ?? e)})`;
      } finally {
        this.polling = false;
        if (!this.closed) cx.notify();
      }
    });
  }

  stop(cx) {
    const job = this.job;
    this.job = null;
    this.busy = null;
    if (job) cx.spawn(async () => {
      await core(["kill", job.address]).catch(() => {});
      await core(["rm", job.address]).catch(() => {});
    });
    cx.notify();
  }

  create(cx) {
    const where = this.target(cx);
    if (!where) return;
    this.busy = "Creating…";
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (await this.exists(where.dest)) throw new Error(`${where.name} already exists in ${where.parent}.`);
        const r = this.git
          ? await exec("git", ["init", where.dest], { on: this.host })
          : this.win
            ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Directory -Path ${quotePs(where.dest)} | Out-Null`])
            : await exec("mkdir", ["-p", where.dest], { on: this.host });
        if (r.code !== 0) throw new Error(errorText(r) || "Couldn't create the folder.");
        this.remember(where.parent);
        this.open(where.dest);
      } catch (e) {
        this.busy = null;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  openTyped(cx) {
    const path = this.vals.path.trim();
    if (!path) return this.fail(`Type the folder's path on ${this.host}.`, cx);
    this.busy = "Looking…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!(await this.exists(path))) throw new Error(`There's no ${path} on ${this.host}.`);
        this.open(path);
      } catch (e) {
        this.busy = null;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  dismiss(cx) {
    if (this.job) this.stop(cx);
    this.closed = true;
    closeOverlay(props().overlay);
  }

  async close(_cx) {
    const job = this.job;
    this.job = null;
    if (job) await core(["kill", job.address]).catch(() => {});
  }

  key(e, cx) {
    if (e.key !== "escape") return;
    cx.stop_propagation();
    if (this.view !== "home" && !this.busy) this.go("home", cx);
    else this.dismiss(cx);
  }

  // ---- drawing ----

  iconButton(id, icon, t, action) {
    return div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(action).child(svg(I(icon)).size(16));
  }

  button(id, text, primary, enabled, action, t) {
    return h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .when(!enabled, (el) => el.opacity(0.45))
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .child(text);
  }

  header(t) {
    const titles = { home: "Add a project", clone: "Clone from URL", create: "Create new project", path: `Open a folder on ${this.host}` };
    return h_flex().items_center().gap(6).pb(16)
      .when(this.view !== "home", (el) => el.child(this.iconButton("ap-back", "chevron-left", t, (_e, cx) => { if (!this.busy) this.go("home", cx); })))
      .child(div().flex_1().text_size(17).font_bold().child(titles[this.view]))
      .child(this.iconButton("ap-close", "x", t, (_e, cx) => this.dismiss(cx)));
  }

  hostRow(t) {
    const many = this.hosts.length > 1;
    return h_flex().items_center().gap(10).pb(16)
      .child(div().text_size(12.5).text_color(t.muted).child("Host"))
      .child(h_flex().id("ap-host").h(28).px(10).gap(7).items_center().rounded(7).border_1().border_color(t.input).bg(t.raised)
        .text_size(12.5).font_semibold()
        .when(many, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Switch host").on_click((_e, cx) => this.nextHost(cx)))
        .child(svg(I(this.host ? "server" : "monitor")).size(13).text_color(t.muted))
        .child(this.hostLabel(this.host))
        .when(many, (el) => el.child(svg(I("chevrons-up-down")).size(12).text_color(t.dim))));
  }

  option(id, icon, title, detail, action, t, first) {
    return h_flex().id(id).px(16).py(13).gap(16).items_center().cursor_pointer()
      .when(!first, (el) => el.border_t(1).border_color(t.border))
      .hover((s) => s.bg(t.hover)).on_click(action)
      .child(svg(I(icon)).size(18).flex_none().text_color(t.muted))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(title))
        .child(div().text_size(12).text_color(t.dim).truncate().child(detail)));
  }

  card(t, rows) {
    return v_flex().rounded(10).border_1().border_color(t.border).bg(t.raised).overflow_hidden().children(rows);
  }

  home(t) {
    const active = spaces().find((s) => s.active);
    const others = [
      this.option("ap-clone", "globe", "Clone from URL", "Clone a remote Git repository", (_e, cx) => this.go("clone", cx), t, true),
      this.option("ap-create", "plus", "Create new project", "Start from an empty folder", (_e, cx) => this.go("create", cx), t, false),
    ];
    if (active?.branch && (active.machine ?? null) === this.host) {
      others.push(this.option("ap-worktree", "git-branch", "New worktree", `Branch ${active.name} into a new checkout`, () => this.worktree(active), t, false));
    }
    const browse = this.local
      ? this.option("ap-browse", "folder-open", "Browse folder", "Local project, Git repo, or folder with many repos", (_e, cx) => this.browse(cx), t, true)
      : this.option("ap-browse", "folder-open", "Open a folder", `A folder on ${this.host}, by its path`, (_e, cx) => this.browse(cx), t, true);
    return v_flex()
      .child(this.hostRow(t))
      .child(this.card(t, [browse]))
      .child(div().pt(20).pb(8).text_size(11).font_semibold().text_color(t.dim).child("OTHER WAYS TO ADD"))
      .child(this.card(t, others))
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(12).text_color(t.blocked).child(this.error)));
  }

  field(label, key, t, extra) {
    return v_flex().gap(6).pb(12)
      .child(div().text_size(12).font_medium().text_color(t.muted).child(label))
      .child(h_flex().gap(8).items_center()
        .child(Input.new(this.inputs[key]).flex_1().h(34).px(10).rounded(8).border_1()
          .border_color(this.focusedInput === key ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground))
        .when(Boolean(extra), (el) => el.child(extra)));
  }

  checkbox(t) {
    return h_flex().id("ap-git").gap(8).items_center().pb(6).cursor_pointer()
      .on_click((_e, cx) => { this.git = !this.git; cx.notify(); })
      .child(h_flex().size(16).flex_none().items_center().justify_center().rounded(4).border_1()
        .border_color(this.git ? t.accent : t.input).bg(this.git ? t.accent : t.background)
        .when(this.git, (el) => el.child(svg(I("check")).size(12).text_color(t.accent_foreground))))
      .child(div().text_size(12.5).text_color(t.foreground).child("Initialize a Git repository"));
  }

  status(t) {
    if (this.busy) {
      return h_flex().gap(8).items_center().min_h(20).text_size(12).text_color(t.muted)
        .child(svg(I("spinner")).size(12).flex_none().text_color(t.working).spin(900))
        .child(div().flex_1().min_w(0).truncate().child(this.busy));
    }
    if (this.error) {
      return v_flex().min_h(20).text_size(12).line_height("18px").text_color(t.blocked)
        .children(this.error.split("\n").map((line) => div().child(line)));
    }
    const name = this.vals.name.trim();
    const parent = this.vals.loc.trim();
    const dest = this.view !== "path" && name && parent && !badName(name) ? join(parent, name, this.win) : "";
    return div().min_h(20).text_size(12).text_color(t.dim).truncate()
      .child(dest ? `${this.view === "clone" ? "Clones into" : "Creates"} ${dest}` : "");
  }

  form(t) {
    const v = this.view;
    const loc = this.local ? "Location" : `Location on ${this.host}`;
    const browse = this.local ? this.button("ap-pick", "Browse…", false, !this.busy, (_e, cx) => this.pickLocation(cx), t) : null;
    const fields = v === "clone"
      ? [this.field("Repository URL", "url", t), this.field(loc, "loc", t, browse), this.field("Folder name", "name", t)]
      : v === "create"
        ? [this.field("Project name", "name", t), this.field(loc, "loc", t, browse)]
        : [this.field("Folder", "path", t)];
    const action = { clone: "Clone", create: "Create", path: "Open" }[v];
    return v_flex()
      .children(fields)
      .when(v === "create", (el) => el.child(this.checkbox(t)))
      .child(div().pt(2).child(this.status(t)))
      .child(h_flex().pt(16).gap(8).justify_end()
        .child(this.button("ap-cancel", this.job ? "Stop" : "Cancel", false, true, (_e, cx) => (this.job ? this.stop(cx) : this.dismiss(cx)), t))
        .child(this.button("ap-go", action, true, !this.busy, (_e, cx) => this.submit(cx), t)));
  }

  render() {
    const t = theme();
    return v_flex().id("add-project").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).px(20).pt(16).pb(20).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .child(this.view === "home" ? this.home(t) : this.form(t));
  }
}
