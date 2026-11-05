// Personal copy of the shipped `workspace-status` mod (cloned from 0.1.12). Change:
// a "Terminal" button (and Ctrl+` via keys.json "my-status.toggle") that opens quick
// terminals under the work area, like VS Code's panel. Each space has its own list of
// shells (`atc run --bg --keep` terminals labelled atrous.quick=<space>, not tabs of the
// space), shown as tabs in the panel's header: "+" starts another (a backend, a
// frontend…), × ends one. They keep running while hidden; switching spaces shows that
// space's terminals. When the last one exits the panel closes.
//
// How it changes the window (learned the hard way):
// - Only the status-bar copy changes anything, one operation at a time (a queue). The
//   panel header (another copy of this mod) only sends commands: my-status.select:<t>, …
// - Showing, hiding and switching the shown shell are layout CLICKS, never edits of the
//   layout file: layout.terminal puts the shell in the "quick-terminal-term" block and
//   layout.show/hide open and close the "quick-terminal" node (its size is a click too).
//   Fedra's and Flow's layouts ship with Atrous, and a shipped layout whose file changed is
//   moved aside to <name>-edited on the next start; clicks live in layouts/.state instead.
//   Never layout.set with a tree from layout(): that round trip flattens single-child
//   columns and once lost the side panel.
// - Keyboard focus waits until the terminal block is really on screen.
// - Following the active space is event-driven: the status bar looks after each redraw
//   (spaces, terminals, layout changed); a 1 s timer covers time-only cases and does nothing
//   while the panel is closed (it used to read the whole layout every 400 ms).
// Commands: toggle | show (no focus) | hide | new | new-bg (no focus) | restart |
//           select:<address> | close:<address>.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, terminals, focused, theme, run, window, keys, layout, core, shared, setShared, props, nextCommand, knownAgents, exec, home, appHome, readTextFile } from "atrous";
import * as T from "./trust.js"; // which terminals are agents that haven't reported (yet): counted like Flow and the sidebar show them

// shared: space id -> { list: [address…], active: address, at: { address: started ms } }
// (an older version stored a bare address string).
const MAP = "quick-terminal.map";
const FRESH = 5000; // ms a new shell counts as running before terminals() lists it
const I = (name) => `mods/my-status/${name}.svg`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const live = (addr) => Boolean(addr) && terminals().some((k) => k.address === addr && k.state === "live");

function entry(spaceId) {
  const v = (shared(MAP) ?? {})[spaceId];
  if (!v) return { list: [], active: null, at: {} };
  if (typeof v === "string") return { list: [v], active: v, at: {} };
  return { list: v.list ?? [], active: v.active ?? null, at: v.at ?? {} };
}

// Only shells still running (or just started); the active one falls back to the last.
function prune(e) {
  const now = Date.now();
  const list = e.list.filter((a) => live(a) || now - (e.at[a] ?? 0) < FRESH);
  const at = Object.fromEntries(list.map((a) => [a, e.at[a] ?? 0]));
  return { list, active: list.includes(e.active) ? e.active : list[list.length - 1] ?? null, at };
}

function save(spaceId, e) {
  setShared(MAP, { ...(shared(MAP) ?? {}), [spaceId]: e });
}

const same = (a, b) => a.active === b.active && a.list.length === b.list.length && a.list.every((x, i) => x === b.list[i]);

// Tab id -> its name, for named tabs (an agent's tab is named after it: older builds' only clue).
function tabNames() {
  const m = new Map();
  for (const s of spaces()) for (const c of s.tabs ?? []) if (c.named) m.set(c.id, c.name);
  return (id) => m.get(id) ?? null;
}
const activeSpace = () => spaces().find((s) => s.active);

// OpenCode's status plugin (Settings > Privacy > Agents, my-settings/opencode): on start, while
// that switch is on (the default), put in when it's missing or older than this Atrous's. Reads
// two small files; runs node only when they differ. A scratch or test home (ATROUS_HOME
// elsewhere) never touches the person's OpenCode, like the browser skill (my-chrome).
const slash = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
async function ensureOpencodeStatus() {
  if (shared("agents.opencodeStatus") === false) return;
  const h = slash(home());
  const app = slash(appHome());
  if (app.toLowerCase() !== `${h}/.config/atrous`.toLowerCase()) return;
  const dir = `${app}/mods/my-settings/opencode`;
  const want = await readTextFile(`${dir}/atrous-status.js`).catch(() => null);
  if (!want) return; // not shipped here
  if ((await readTextFile(`${h}/.config/opencode/plugins/atrous-status.js`).catch(() => null)) === want) return;
  await exec("node", [`${dir}/install.mjs`, "install", "--home", h]).catch(() => null);
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.pending = 0;
    if (props()?.part) return;
    // The agents Atrous can start (what a terminal that hasn't reported is): the cached list at once,
    // then knownAgents() (the app asks the shell at most once a minute).
    this.known = shared("new-menu.agents")?.[""] ?? [];
    cx.spawn(async (cx) => { try { this.known = await knownAgents(); cx.notify(); } catch {} });
    cx.spawn(async () => { await ensureOpencodeStatus().catch(() => null); });
    // The panel follows the active space and its shells: the status bar redraws when
    // spaces, terminals or the layout change, and looks after each redraw (render). The
    // timer only covers what time alone changes (a fresh shell's grace, our own edits
    // landing), and reads nothing while the panel is closed.
    cx.timer.every(1000, (cx) => { if (this.shownNow || this.said) this.follow(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const [name, arg] = [c.split(":")[0], c.split(":").slice(1).join(":")];
        if (name === "toggle") this.enqueue(cx, (cx) => (this.visible() ? this.opHide(cx) : this.opOpen(cx, true)));
        else if (name === "show") this.enqueue(cx, (cx) => this.opOpen(cx, false));
        else if (name === "hide") this.enqueue(cx, (cx) => this.opHide(cx));
        else if (name === "new") this.enqueue(cx, (cx) => this.opAdd(cx, true));
        else if (name === "new-bg") this.enqueue(cx, (cx) => this.opAdd(cx, false));
        else if (name === "restart") this.enqueue(cx, (cx) => this.opRestart(cx));
        else if (name === "select" && arg) this.enqueue(cx, (cx) => this.opSelect(cx, arg));
        else if (name === "close" && arg) this.enqueue(cx, (cx) => this.opClose(cx, arg));
      }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  // ---- one operation at a time ----

  enqueue(cx, op) {
    const prev = this.queue ?? Promise.resolve();
    this.pending++;
    cx.notify();
    this.queue = new Promise((resolve) => {
      cx.spawn(async (cx) => {
        await prev;
        try {
          this.error = null;
          await op(cx);
        } catch (e) {
          this.error = String(e?.message ?? e);
        } finally {
          this.pending--;
          cx.notify();
          resolve();
        }
      });
    });
  }

  // ---- the window: clicks only (see the header) ----

  // A layout command; false where the shown layout has no quick terminal.
  click(command, args) {
    try { run(command, args); return true; } catch { return false; }
  }

  async showTerminal(addr) {
    this.said = { on: true, at: Date.now(), addr };
    if (this.click("layout.terminal", { id: "quick-terminal-term", terminal: addr })) {
      this.click("layout.show", { id: "quick-terminal" });
    }
  }

  // Visible as far as this copy knows: its own last change wins for a moment, since
  // layout() catches up with a file edit a little later.
  visible() {
    if (this.said && Date.now() - this.said.at < 2000) return this.said.on;
    const qt = find(layout(), "quick-terminal");
    return Boolean(qt) && !qt.hidden;
  }

  // Keyboard to `addr` once its block is on screen (asking earlier fails: "no such pane").
  focusWhenReady(addr, cx, tries = 0) {
    const tree = layout();
    const qt = find(tree, "quick-terminal");
    if (qt && !qt.hidden && find(tree, "quick-terminal-term")?.content?.terminal === addr) {
      run("pane.focus", { terminal: addr });
      return;
    }
    if (tries < 25) cx.timer.after(120, (cx) => this.focusWhenReady(addr, cx, tries + 1));
  }

  // ---- shells ----

  // A new shell for the space, in the focused pane's folder.
  async spawnShell(space) {
    const f = focused();
    const cwd = (f?.space === space.id ? f?.cwd : null) || panes().find((p) => space.tabs?.some((tb) => tb.id === p.tab) && p.cwd)?.cwd || space.folder;
    const local = space.id.includes("/") ? space.id.split("/").pop() : space.id;
    const args = ["run", "--bg", "--keep", "--json", "--no-parent", "--no-notify", "--label", `atrous.quick=${local}`];
    if (cwd) args.push("--cwd", cwd);
    if (space.machine) args.push("--on", space.machine);
    const r = await core(args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "couldn't start a shell").trim());
    return JSON.parse(r.stdout).address;
  }

  async opOpen(cx, focus) {
    const space = activeSpace();
    if (!space) return;
    let e = prune(entry(space.id));
    if (!e.active) {
      const addr = await this.spawnShell(space);
      e = prune(entry(space.id));
      e = { list: [...e.list, addr], active: addr, at: { ...e.at, [addr]: Date.now() } };
    }
    save(space.id, e);
    this.space = space.id;
    await this.showTerminal(e.active);
    if (focus) this.focusWhenReady(e.active, cx);
  }

  async opHide(_cx) {
    this.said = { on: false, at: Date.now() };
    this.click("layout.hide", { id: "quick-terminal" });
  }

  // "+": another shell for this space, shown (and focused, unless a script asked).
  async opAdd(cx, focus) {
    const space = activeSpace();
    if (!space) return;
    const addr = await this.spawnShell(space);
    const e = prune(entry(space.id));
    save(space.id, { list: [...e.list, addr], active: addr, at: { ...e.at, [addr]: Date.now() } });
    this.space = space.id;
    await this.showTerminal(addr);
    if (focus) this.focusWhenReady(addr, cx);
  }

  async opSelect(cx, addr) {
    const space = activeSpace();
    if (!space) return;
    const e = prune(entry(space.id));
    if (!e.list.includes(addr)) return;
    save(space.id, { ...e, active: addr });
    await this.showTerminal(addr);
    this.focusWhenReady(addr, cx);
  }

  // ×: ends that shell; the panel shows a neighbour, or closes with the last one.
  async opClose(cx, addr) {
    const space = activeSpace();
    if (!space) return;
    const e = prune(entry(space.id));
    const i = e.list.indexOf(addr);
    const list = e.list.filter((a) => a !== addr);
    const active = e.active === addr ? list[Math.min(Math.max(i, 0), list.length - 1)] ?? null : e.active;
    save(space.id, { list, active, at: e.at });
    run("terminal.kill", { terminal: addr });
    if (active) await this.showTerminal(active);
    else await this.opHide(cx);
  }

  // The active shell replaced by a fresh one, in the same place in the list.
  async opRestart(cx) {
    const space = activeSpace();
    if (!space) return;
    const old = prune(entry(space.id)).active;
    const addr = await this.spawnShell(space);
    const e = prune(entry(space.id));
    const list = e.list.map((a) => (a === old ? addr : a));
    if (!list.includes(addr)) list.push(addr);
    save(space.id, { list, active: addr, at: { ...e.at, [addr]: Date.now() } });
    if (old) run("terminal.kill", { terminal: old });
    await this.showTerminal(addr);
    this.focusWhenReady(addr, cx);
  }

  // After a redraw of the status bar, once.
  followSoon(cx) {
    if (this.followQueued) return;
    this.followQueued = true;
    cx.spawn(async (cx) => { this.followQueued = false; this.follow(cx); });
  }

  // While the panel shows: follow the active space, drop shells that exited, close with the last.
  follow(cx) {
    if (this.said && Date.now() - this.said.at > 3000) this.said = null; // our edit has landed (or never will)
    if (this.pending || !this.visible()) return;
    const space = activeSpace();
    if (!space) return;
    if (space.id !== this.space) return this.enqueue(cx, (cx) => this.opOpen(cx, false));
    const raw = entry(space.id);
    const e = prune(raw);
    if (!same(e, raw)) save(space.id, e);
    if (!e.active) return this.enqueue(cx, (cx) => this.opHide(cx));
    const fresh = this.said?.addr === e.active && Date.now() - this.said.at < 3000;
    if (!fresh && find(layout(), "quick-terminal-term")?.content?.terminal !== e.active) {
      this.enqueue(cx, () => this.showTerminal(e.active));
    }
  }

  // ---- drawing ----

  // The panel's header (its own copy of this mod): the space's shells as tabs, "+", hide.
  // It only sends commands; the status-bar copy does the work.
  header(t) {
    const space = activeSpace();
    const e = space ? entry(space.id) : { list: [], active: null, at: {} };
    const now = Date.now();
    const list = e.list.filter((a) => live(a) || now - (e.at[a] ?? 0) < FRESH);
    const terms = new Map(terminals().map((k) => [k.address, k]));
    const button = (id, icon, tip, action) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(action).child(svg(I(icon)).size(13));
    const tab = (addr, n) => {
      const k = terms.get(addr);
      const prog = k?.program?.shell === false && k?.program?.name ? k.program.name : (k?.foreground?.name ?? "shell").replace(/\.exe$/i, "");
      const on = addr === e.active;
      return h_flex().id(`qt-tab-${addr}`).h(22).pl(8).pr(4).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`${prog} · ${addr}${k?.cwd ? ` · ${k.cwd}` : ""}`)
        .on_click(() => run(`my-status.select:${addr}`))
        .child(div().text_size(11.5).child(`${n + 1}  ${prog}`))
        .child(div().id(`qt-close-${addr}`).size(16).flex().items_center().justify_center().rounded(4).text_color(t.dim)
          .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("End this shell")
          .on_click((_e, cx) => { cx.stop_propagation(); run(`my-status.close:${addr}`); })
          .child(svg(I("x")).size(10)));
    };
    return h_flex().size_full().px(8).gap(6).items_center().bg(t.background).border_b(1).border_color(t.border).text_size(12)
      .child(svg(I("terminal")).size(13).flex_none().text_color(t.muted))
      .child(h_flex().id("qt-tabs").flex_1().min_w(0).gap(3).items_center().overflow_x_scrollbar().children(list.map(tab))
        .child(button("qt-new", "plus", "New terminal", () => run("my-status.new"))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(space?.name ?? ""))
      .child(button("qt-hide", "x", "Hide (Ctrl+`)", () => run("my-status.hide")));
  }

  // Tokens per second of an agent's last finished turn (published by my-spaces as shared
  // "agents.speed"): the agent you're looking at, else the one that finished last.
  speedLine(list) {
    const speeds = shared("agents.speed") ?? {};
    const f = focused();
    const here = list.find((a) => a.address === f?.agent) ?? list.find((a) => a.focused);
    let addr = here && speeds[here.address] ? here.address : null;
    if (!addr) addr = Object.keys(speeds).filter((k) => list.some((a) => a.address === k))
      .sort((x, y) => (speeds[y].endedAt ?? 0) - (speeds[x].endedAt ?? 0))[0] ?? null;
    if (!addr) return null;
    const s = speeds[addr], a = list.find((x) => x.address === addr);
    const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${((ms ?? 0) / 1000).toFixed(1)}s`);
    const who = a ? (a.title || a.program?.name || addr) : addr;
    return {
      label: here && here.address === addr ? s.label : `${s.label} · ${who}`,
      tip: `${who}: last turn ${s.outputTokens ?? 0} output tokens in ${secs(s.modelMs)} of model time (${secs(s.wallMs)} in all)`,
    };
  }

  render(_cx) {
    const t = theme();
    const part = props()?.part;
    if (part === "terminal-header") return this.header(t);
    if (part === "terminal-empty") return div().size_full().bg(t.background).p(12).text_size(12).text_color(t.dim).child("Starting a shell…");
    const space = activeSpace();
    const list = agents();
    // Agents with no status report count too: starting (at a trust prompt), or never reporting
    // (OpenCode): atrous.agent label, launcher, argv or tab name (trust.js), as Flow and the sidebar.
    const known = [...(this.known ?? []), ...(shared("new-menu.agents")?.[""] ?? [])];
    const tab = tabNames();
    const quiet = terminals().filter((k) => !T.reported(k) && T.launchOf(k, known, tab) && !list.some((a) => a.address === k.address));
    const asks = shared("agents.prompts") ?? {};
    const total = list.length + quiet.length;
    const needs = list.filter(a => a.status === "blocked").length + quiet.filter((k) => asks[k.address]).length;
    const open = this.visible();
    const speed = this.speedLine(list);
    const qt = find(layout(), "quick-terminal");
    this.shownNow = Boolean(qt) && !qt.hidden;
    if (open || this.shownNow) this.followSoon(_cx);
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${total} agent${total === 1 ? "" : "s"}`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .when(Boolean(speed), el => el.child(h_flex().id("agent-speed").gap(5).items_center().text_color(t.muted)
        .tooltip(speed.tip).child(svg(I("zap")).size(12).text_color(t.ansi3)).child(speed.label)))
      .child(h_flex().id("quick-terminal-toggle").h(20).px(7).gap(5).items_center().rounded(5).cursor_pointer()
        .when(open, el => el.bg(t.selected).text_color(t.foreground))
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip(this.error ? `Couldn't open: ${this.error}` : open ? "Hide the terminal (Ctrl+`)" : "Open a terminal here (Ctrl+`)")
        .on_click(() => run("my-status.toggle"))
        .child(this.pending ? svg("mods/workspace-chrome/spinner.svg").size(12).spin(900) : svg(I("terminal")).size(13))
        .child("Terminal")
        .when(Boolean(this.error), el => el.child(div().size(6).rounded(3).bg(t.blocked))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
