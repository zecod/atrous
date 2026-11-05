// Onboarding: Atrous's first-run flow. A window over the live app (mod.json: 760 x 540), so what
// each step changes shows behind it at once. Seven steps, each optional, listed on the left:
//   1 Welcome   the logo, one line about Atrous, and what came over from a previous home
//               (data/migration.json, written by the app; accounts counted from accounts/state.json)
//   2 Agents    the coding agents this computer has (knownAgents), install commands to copy for
//               the missing ones, and the YOLO switch (programs.json `run` flags; on by default)
//   3 Accounts  Claude Code / Codex logins (accounts/state.json and the login files, read only);
//               "Add account" opens Settings > Accounts, whose sign-in flow does the rest
//   4 Browser   the atrous-browser skill (linked into ~/.claude/skills and ~/.codex/skills by its
//               install.mjs), Import from Chrome (the Browser panel's own import), Settings > Skills
//   5 Look      appearance, themes (app.theme, live), and the sidebar wide or as a rail
//   6 Project   Open a folder (pickFolder -> a new space on the project start screen), Clone from
//               Git (the add-project dialog, on its clone form)
//   7 Ready     three keys worth knowing (read from keys.json), and Start
// Finishing or skipping sets shared "onboarding.done" (and "atrous.onboarded", which the app
// checks on start) to { version, at, outcome: "finished" | "skipped" }.
//
// Open it: `mod.open onboarding` or `app.welcome`. Props: { step?: "welcome" | "agents" |
// "accounts" | "browser" | "look" | "project" | "done" }. While it's open, `onboarding.<command>`
// (keys.json, `atrous do`): open (back to the start), step:<id or 1-7>, next, back, skip, finish,
// yolo:on|off, skill:on|off, theme:<name>, appearance:system|light|dark, sidebar:wide|rail,
// folder (the folder picker), clone, import (Import from Chrome), accounts, skills.
// Render reads only live data and what tasks loaded; files, programs and agents load in tasks.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { run, theme, themes, settings, shared, setShared, props, closeOverlay, openOverlay, nextCommand, pickFolder, spaces, layout, layouts, keys, window } from "atrous";
import {
  readMigration, migrationParts, joinAnd, findAgents, installCommand, readPrograms, yoloState, setYolo,
  readAccounts, TOOLS, skillStatus, linkSkill, readAppearance, writeAppearance, keysFor,
} from "./data.js";

const VERSION = 1;
const DONE = "onboarding.done";
const APP_DONE = "atrous.onboarded"; // what the app looks for on start (src/window.rs ONBOARDED)
const I = (name) => `mods/onboarding/${name}.svg`;
const LOGO = "mods/onboarding/logo.svg";

const STEPS = [
  { id: "welcome", title: "Welcome" },
  { id: "agents", title: "Agents" },
  { id: "accounts", title: "Accounts" },
  { id: "browser", title: "Browser & skills" },
  { id: "look", title: "Look" },
  { id: "project", title: "First project" },
  { id: "done", title: "Ready" },
];
const ROW_H = 34;
const ROW_GAP = 2;
const PAGE_H = 430; // the body's height inside its padding (540 - footer 60 - padding 50)
const APPEARANCES = [[null, "System"], ["light", "Light"], ["dark", "Dark"]];
const THEME_NAMES = { "atom-one-dark": "one dark" }; // short enough for a swatch

const alpha = (hex, aa) => (/^#[0-9a-f]{6}$/i.test(hex ?? "") ? `${hex}${aa}` : hex);
const stop = (_e, cx) => cx.stop_propagation();
const baseName = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p ?? "");
const samePath = (a, b) => {
  const n = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return window()?.platform === "windows" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

// The nodes from the root down to `id` (empty if it isn't there).
function pathTo(node, id, trail = []) {
  if (!node) return [];
  const here = [...trail, node];
  if (node.id === id) return here;
  for (const c of node.children ?? []) {
    const p = pathTo(c, id, here);
    if (p.length) return p;
  }
  return [];
}

// A new project opens on the start screen (mods/start: a button per installed agent), not
// on a bare shell. space.new always starts a terminal; the start tab, queued right after it into
// the space it made, closes that terminal's tab when it first shows.
function openProject(folder) {
  const existing = spaces().map((s) => s.id);
  // The side panel as it is now (null: closed): the start screen closes it while it shows, then puts this back.
  const side = find(layout(), "panel");
  const panel = side ? (side.hidden ? null : find(side, "panel-body")?.active ?? null) : undefined;
  run("space.new", folder ? { folder, machine: "" } : { machine: "" });
  const fresh = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  run("tab.new", { name: "Start", mod: "start", props: { ...(folder ? { folder } : {}), machine: null, fresh, existing, panel } });
}

const narrowSidebar = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class Onboarding extends View {
  init(_props, cx) {
    const asked = props()?.step;
    const at = STEPS.findIndex((s) => s.id === asked);
    this.step = at < 0 ? 0 : at;
    this.passed = new Set(); // steps left with Next (their mark turns into a check)
    this.migration = null;
    this.accounts = null;
    this.agents = null;
    this.yolo = null; // "on" | "off" | "mixed", from programs.json
    this.yoloBusy = false;
    this.yoloError = null;
    this.skill = null;
    this.skillBusy = false;
    this.skillError = null;
    this.copied = null;
    this.appearance = undefined; // settings.json's, once read (null: the system's)
    this.spacesBefore = null; // space ids when the project step showed (a new one = opened)
    this.notice = null; // { step, text }: a short line after an action that opens something elsewhere
    this.handle = cx.focus_handle();
    this.handle.focus();
    // A window doesn't take the keyboard when it opens, and the app's first pane takes it back
    // while starting: take it again once that's done.
    cx.timer.after(600, () => this.handle.focus());
    cx.spawn(async (cx) => {
      this.migration = await readMigration();
      this.appearance = await readAppearance();
      cx.notify();
      this.accounts = await readAccounts();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      this.skill = await skillStatus().catch(() => null);
      cx.notify();
    });
    // knownAgents asks a shell: start early so the Agents step is ready when it shows.
    cx.spawn(async (cx) => {
      await this.loadAgents();
      cx.notify();
    });
    // Accounts change while Settings is open over this window, and a previous home's accounts
    // arrive a moment after the first start (the accounts mods bring them over on first read).
    this.started = Date.now();
    cx.timer.every(2500, (cx) => {
      const id = STEPS[this.step].id;
      const want = id === "accounts" || (id === "welcome" && this.migration && Date.now() - this.started < 30000);
      if (!want || this.reading) return;
      this.reading = true;
      cx.spawn(async (cx) => {
        try {
          this.accounts = await readAccounts();
        } finally {
          this.reading = false;
        }
        cx.notify();
      });
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(String(c ?? ""), cx);
        cx.notify();
      }
    });
    this.enter(cx);
  }

  async loadAgents() {
    this.agents = await findAgents();
    const { doc, error } = await readPrograms();
    this.yoloError = error ?? null;
    this.yolo = doc ? yoloState(doc, this.installedKeys()) : "off";
  }

  installedKeys() {
    return new Set((this.agents ?? []).filter((a) => a.installed).map((a) => a.key));
  }

  // ---- moving between steps ----

  go(i, cx) {
    const next = Math.max(0, Math.min(STEPS.length - 1, i));
    if (next === this.step) return;
    if (next > this.step) for (let s = this.step; s < next; s++) this.passed.add(s);
    this.step = next;
    this.notice = null;
    this.handle.focus();
    this.enter(cx);
    cx.notify();
  }

  // What a step needs when it shows.
  enter(cx) {
    const id = STEPS[this.step].id;
    if (id === "agents") {
      cx.spawn(async (cx) => {
        if (!this.agents) await this.loadAgents();
        // On by default: the first time this step shows, agents start without prompts, unless the
        // person chose already (shared "onboarding.yolo", set by the switch).
        if (shared("onboarding.yolo") == null && this.yolo !== "on" && !this.yoloError) await this.applyYolo(true);
        cx.notify();
      });
    }
    if (id === "accounts") {
      cx.spawn(async (cx) => {
        this.accounts = await readAccounts();
        cx.notify();
      });
    }
    if (id === "browser") {
      cx.spawn(async (cx) => {
        this.skill = await skillStatus().catch(() => this.skill);
        cx.notify();
      });
    }
    if (id === "project" && !this.spacesBefore) this.spacesBefore = new Set(spaces().map((s) => s.id));
    if (id === "look") this.loadThemes();
  }

  // The themes the Look step offers, dark ones first. themes() builds every palette, so it's
  // asked once per visit of the step, not on each render. A theme named like a layout belongs
  // to that layout (Settings offers it only there).
  loadThemes() {
    const shown = shared("layout");
    const names = new Set(layouts());
    const keep = ["background", "terminal_foreground", "foreground", "muted", "dim", "accent", "ansi1", "ansi2", "ansi4"];
    const list = themes()
      .filter((x) => x.name === shown || !names.has(x.name))
      .map(({ name, light, colors }) => ({ name, light, colors: Object.fromEntries(keep.map((k) => [k, colors?.[k]])) }));
    this.themeList = [...list.filter((x) => !x.light), ...list.filter((x) => x.light)];
  }

  finish(outcome) {
    if (this.closing) return;
    this.closing = true;
    const mark = { version: VERSION, at: Date.now(), outcome };
    setShared(DONE, mark);
    setShared(APP_DONE, mark);
    const o = props()?.overlay;
    if (o) closeOverlay(o);
    // Started with nothing open: one space at home, so the window isn't empty.
    if (outcome === "finished" && spaces().length === 0) openProject(null);
  }

  key(e, cx) {
    const k = e.key;
    const m = e.modifiers ?? {};
    if (m.control || m.alt || m.platform || m.shift) return;
    const last = this.step === STEPS.length - 1;
    if (k === "escape") {
      cx.stop_propagation();
      this.finish("skipped");
      return;
    }
    if (k === "enter" || k === "right") {
      if (last) {
        if (k === "enter") this.finish("finished");
      } else this.go(this.step + 1, cx);
    } else if (k === "left") this.go(this.step - 1, cx);
    else return;
    cx.stop_propagation();
  }

  command(c, cx) {
    const i = c.indexOf(":");
    const name = i < 0 ? c : c.slice(0, i);
    const arg = i < 0 ? "" : c.slice(i + 1);
    if (name === "open" || name === "restart") this.go(0, cx);
    else if (name === "step") {
      const n = Number(arg);
      const at = Number.isInteger(n) && n >= 1 ? n - 1 : STEPS.findIndex((s) => s.id === arg);
      if (at >= 0) this.go(at, cx);
    } else if (name === "next") this.go(this.step + 1, cx);
    else if (name === "back") this.go(this.step - 1, cx);
    else if (name === "skip") this.finish("skipped");
    else if (name === "finish") this.finish("finished");
    else if (name === "yolo") this.toggleYolo(arg !== "off", cx);
    else if (name === "skill") this.toggleSkill(arg !== "off", cx);
    else if (name === "theme" && arg) this.pickTheme(themes().find((x) => x.name === arg), cx);
    else if (name === "appearance") this.setAppearance(arg === "light" || arg === "dark" ? arg : null, cx);
    else if (name === "sidebar") this.setSidebar(arg === "rail", cx);
    else if (name === "folder") this.openFolder(cx);
    else if (name === "clone") this.clone(cx);
    else if (name === "import") this.importChrome(cx);
    else if (name === "accounts") this.openSettings("accounts");
    else if (name === "skills") this.openSettings("skills");
  }

  // ---- actions ----

  async applyYolo(on) {
    this.yoloBusy = true;
    try {
      if (!(await setYolo(on))) throw new Error("programs.json kept changing; try again.");
      setShared("onboarding.yolo", on);
      const { doc, error } = await readPrograms();
      this.yolo = doc ? yoloState(doc, this.installedKeys()) : this.yolo;
      this.yoloError = error ?? null;
    } catch (e) {
      this.yoloError = String(e?.message ?? e);
    } finally {
      this.yoloBusy = false;
    }
  }

  toggleYolo(on, cx) {
    if (this.yoloBusy) return;
    this.yolo = on ? "on" : "off"; // the switch moves at once; the file follows
    cx.notify();
    cx.spawn(async (cx) => {
      await this.applyYolo(on);
      cx.notify();
    });
  }

  toggleSkill(on, cx) {
    const s = this.skill;
    if (this.skillBusy || !s?.shipped || !Object.values(s.tools ?? {}).some((x) => x.installed)) return;
    this.skillBusy = true;
    this.skillError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await linkSkill(s.install, on);
        // The brand mod links it again at start when it's missing; this says the person chose.
        setShared("atrous-browser.link", on);
      } catch (e) {
        this.skillError = `Couldn't ${on ? "link" : "unlink"} it: ${String(e?.message ?? e)}`;
      }
      this.skill = await skillStatus().catch(() => s);
      this.skillBusy = false;
      cx.notify();
    });
  }

  openSettings(section) {
    openOverlay({ mod: "my-settings", kind: "dialog", width: 960, height: 660, props: { section } });
  }

  // The Browser panel, shown, then its own Import from Chrome (it asks before anything is copied).
  importChrome(cx) {
    const L = layout();
    const path = pathTo(L, "browser");
    const stack = path[path.length - 2];
    if (!path.length || stack?.type !== "stack") return;
    run("layout.select", { stack: stack.id, child: "browser" });
    for (const n of path) if (n.hidden && n.id) run("layout.show", { id: n.id });
    this.notice = { step: "browser", text: "The Browser panel asks before it copies anything: drag this window aside." };
    // The panel's copy starts when it first shows: give it a moment before the command.
    cx.timer.after(800, () => run("browser-panel.import"));
    cx.notify();
  }

  pickTheme(x, cx) {
    if (!x) return;
    run("app.theme", { name: x.name });
    // A light theme on a dark window (or the reverse) wouldn't show: switch the appearance too.
    if (Boolean(x.light) === Boolean(settings().dark)) this.setAppearance(x.light ? "light" : "dark", cx);
    cx.notify();
  }

  setAppearance(value, cx) {
    this.appearance = value;
    cx.notify();
    cx.spawn(async (cx) => {
      await writeAppearance(value);
      cx.notify();
    });
  }

  // As the brand mod's sidebar button does it: a rail goes by width (44, 76 on macOS).
  setSidebar(rail, cx) {
    const node = find(layout(), "sidebar");
    if (!node || rail === narrowSidebar()) return;
    if (rail) setShared("sidebar.width", node.size?.px);
    setShared("sidebar.collapsed", rail);
    run("layout.resize", { id: "sidebar", px: rail ? (window()?.platform === "macos" ? 76 : 44) : (shared("sidebar.width") ?? 268) });
    cx.notify();
  }

  openFolder(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Open" });
      if (!folder) return;
      const found = spaces().find((s) => !s.machine && samePath(s.folder, folder));
      if (found) run("space.select", { id: found.id });
      else openProject(folder);
      this.notice = { step: "project", text: `Opened ${baseName(folder)}. It's in the sidebar.` };
      this.handle.focus();
      cx.notify();
    });
  }

  clone(cx) {
    openOverlay({ mod: "add-project", kind: "dialog", width: 520, props: { machine: null, view: "clone" } });
    cx.notify();
  }

  copy(text, id, cx) {
    cx.write_to_clipboard(text);
    this.copied = id;
    cx.notify();
  }

  // ---- pieces ----

  title(t, text, sub) {
    return v_flex()
      .gap(6)
      .pb(20)
      .child(div().text_size(20).font_semibold().text_color(t.foreground).child(text))
      .when(Boolean(sub), (el) => el.child(div().text_size(13).line_height("20px").text_color(t.muted).child(sub)));
  }

  primary(t, id, label, onClick, icon) {
    return h_flex()
      .id(id)
      .h(32)
      .px(14)
      .gap(7)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .bg(t.solid)
      .text_color(t.solid_foreground)
      .text_size(13)
      .font_medium()
      .hover((s) => s.opacity(0.88))
      .on_mouse_down("left", stop)
      .on_click(onClick)
      .child(label)
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(14)));
  }

  ghost(t, id, label, onClick, icon) {
    return h_flex()
      .id(id)
      .h(32)
      .px(12)
      .gap(6)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .text_size(13)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click(onClick)
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(14)))
      .child(label);
  }

  // Settings' secondary button, a little smaller.
  button(t, id, label, onClick, icon, disabled) {
    return h_flex()
      .id(id)
      .flex_none()
      .h(28)
      .px(10)
      .gap(6)
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .text_size(12.5)
      .font_medium()
      .text_color(t.foreground)
      .on_mouse_down("left", stop)
      .when(Boolean(disabled), (el) => el.opacity(0.45))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(13).text_color(t.muted)))
      .child(label);
  }

  iconButton(t, id, icon, tip, onClick, on) {
    return div()
      .id(id)
      .size(28)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .cursor_pointer()
      .text_color(on ? t.accent : t.muted)
      .hover((s) => s.bg(t.hover).text_color(on ? t.accent : t.foreground))
      .tooltip(tip)
      .on_mouse_down("left", stop)
      .on_click(onClick)
      .child(svg(I(icon)).size(14));
  }

  // Atrous's switch; the knob slides natively.
  toggle(t, id, on, onClick, busy) {
    return div()
      .id(id)
      .relative()
      .flex_none()
      .w(36)
      .h(20)
      .rounded(10)
      .cursor_pointer()
      .bg(on ? t.accent : t.hover)
      .when(Boolean(busy), (el) => el.opacity(0.6))
      .on_mouse_down("left", stop)
      .on_click(onClick)
      .child(
        div()
          .id(`${id}-knob`)
          .absolute()
          .top(2)
          .left(on ? 18 : 2)
          .w(16)
          .h(16)
          .rounded(8)
          .bg(on ? t.accent_foreground : t.muted)
          .transition("left", { duration: 160, easing: "ease-out" }),
      );
  }

  segment(t, id, items, now, onPick) {
    return h_flex()
      .flex_none()
      .p(2)
      .gap(2)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .children(
        items.map(([value, label]) =>
          div()
            .id(`${id}-${label}`)
            .px(11)
            .py(4)
            .rounded(6)
            .text_size(12.5)
            .cursor_pointer()
            .when(now === value, (el) => el.bg(t.raised).text_color(t.foreground).border_1().border_color(t.border))
            .when(now !== value, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_mouse_down("left", stop)
            .on_click((_e, cx) => onPick(value, cx))
            .child(label),
        ),
      );
  }

  // One setting in a card: what it is on the left, the control on the right.
  row(t, title, about, control, first, aboutColor) {
    return h_flex()
      .w_full()
      .px(16)
      .py(12)
      .gap(16)
      .items_center()
      .when(!first, (el) => el.border_t(1).border_color(t.border))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().text_size(13.5).font_medium().text_color(t.foreground).child(title))
          .when(Boolean(about), (el) => el.child(div().text_size(12.5).line_height("18px").text_color(aboutColor ?? t.dim).child(about))),
      )
      .child(div().flex_none().child(control));
  }

  card(t, rows) {
    return v_flex().w_full().rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden().children(rows);
  }

  spinner(t, text) {
    return h_flex()
      .gap(8)
      .items_center()
      .py(10)
      .child(svg(I("spinner")).size(13).flex_none().text_color(t.muted).spin(900))
      .when(Boolean(text), (el) => el.child(div().text_size(12.5).text_color(t.dim).child(text)));
  }

  note(t) {
    const n = this.notice;
    if (!n || n.step !== STEPS[this.step].id) return null;
    return h_flex()
      .mt(12)
      .gap(8)
      .items_center()
      .child(svg(I("circle-check")).size(14).flex_none().text_color(t.accent))
      .child(div().text_size(12.5).text_color(t.muted).child(n.text));
  }

  // A program's tile with its glyph, as the app's program table draws it.
  programTile(a, size) {
    const glyph = Math.round(size * 0.6);
    return div()
      .size(size)
      .flex_none()
      .rounded(Math.round(size * 0.27))
      .bg(a.tile ?? "#1c1d21")
      .flex()
      .items_center()
      .justify_center()
      .child(a.tint ? svg(a.icon).size(glyph).text_color(a.color ?? "#ffffff") : image(a.icon).size(glyph));
  }

  // ---- the rail and the footer ----

  stepRow(t, s, i) {
    const now = i === this.step;
    const done = this.passed.has(i) && !now;
    const mark = done
      ? div().size(20).flex_none().rounded_full().bg(alpha(t.accent, "26")).flex().items_center().justify_center().child(svg(I("check")).size(11).text_color(t.accent))
      : div()
          .size(20)
          .flex_none()
          .rounded_full()
          .flex()
          .items_center()
          .justify_center()
          .text_size(11)
          .font_semibold()
          .when(now, (el) => el.bg(t.accent).text_color(t.accent_foreground))
          .when(!now, (el) => el.border_1().border_color(t.input).text_color(t.dim))
          .child(String(i + 1));
    return h_flex()
      .id(`onb-s-${s.id}`)
      .h(ROW_H)
      .px(8)
      .gap(10)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .when(!now, (el) => el.hover((st) => st.bg(t.hover)))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => this.go(i, cx))
      .child(mark)
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(13)
          .when(now, (el) => el.font_medium())
          .text_color(now ? t.foreground : done ? t.muted : t.dim)
          .child(s.title),
      );
  }

  // The steps on the left; the highlight slides to the current one. Its brand row and empty space
  // move the window (they don't stop the press).
  rail(t) {
    return v_flex()
      .w(196)
      .flex_none()
      .h_full()
      .bg(t.chrome)
      .border_r(1)
      .border_color(t.border)
      .child(
        h_flex()
          .h(64)
          .px(16)
          .gap(10)
          .items_center()
          .cursor_grab()
          .child(image(LOGO).size(30).flex_none())
          .child(
            v_flex()
              .gap(1)
              .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Atrous"))
              .child(div().text_size(11.5).text_color(t.dim).child("Setup")),
          ),
      )
      .child(
        div()
          .relative()
          .mx(10)
          .mt(4)
          .child(
            div()
              .id("onb-highlight")
              .absolute()
              .left(0)
              .right(0)
              .top(this.step * (ROW_H + ROW_GAP))
              .h(ROW_H)
              .rounded(8)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .transition("top", { duration: 220, easing: "ease-out" }),
          )
          .child(v_flex().gap(ROW_GAP).children(STEPS.map((s, i) => this.stepRow(t, s, i)))),
      )
      .child(div().flex_1())
      .child(div().px(18).pb(16).text_size(11.5).text_color(t.dim).child(`Step ${this.step + 1} of ${STEPS.length}`));
  }

  footer(t) {
    const first = this.step === 0;
    const last = this.step === STEPS.length - 1;
    return h_flex()
      .h(60)
      .flex_none()
      .px(20)
      .gap(6)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .when(!last, (el) => el.child(this.ghost(t, "onb-skip", "Skip setup", () => this.finish("skipped"))))
      .child(div().flex_1())
      .when(!first, (el) => el.child(this.ghost(t, "onb-back", "Back", (_e, cx) => this.go(this.step - 1, cx), "chevron-left")))
      .child(
        last
          ? this.primary(t, "onb-start", "Start using Atrous", () => this.finish("finished"), "arrow-right")
          : this.primary(t, "onb-next", first ? "Get started" : "Next", (_e, cx) => this.go(this.step + 1, cx), "arrow-right"),
      );
  }

  // ---- 1 Welcome ----

  welcome(t) {
    const m = this.migration;
    return v_flex()
      .h(PAGE_H)
      .items_center()
      .justify_center()
      .child(image(LOGO).size(88))
      .child(div().pt(14).text_size(26).font_semibold().text_color(t.foreground).child("Welcome to Atrous"))
      .child(
        div()
          .pt(8)
          .max_w(430)
          .text_center()
          .text_size(14)
          .line_height("22px")
          .text_color(t.muted)
          .child("Your coding agents, side by side. They keep working in the background, even with this window closed."),
      )
      .when(Boolean(m), (el) => el.child(this.broughtOver(t, m)))
      .child(div().pt(m ? 22 : 30).text_size(12.5).text_color(t.dim).child("A few short steps, each one optional."));
  }

  broughtOver(t, m) {
    const parts = migrationParts(m, this.accounts?.extra ?? 0);
    const from = typeof m.from === "string" && m.from.trim() ? m.from.trim() : "your previous setup";
    const what = parts.length ? `${joinAnd(parts).replace(/^./, (c) => c.toUpperCase())}. ` : "";
    return h_flex()
      .mt(26)
      .w(440)
      .px(14)
      .py(11)
      .gap(12)
      .items_center()
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(div().size(28).flex_none().rounded_full().bg(alpha(t.accent, "1f")).flex().items_center().justify_center().child(svg(I("check")).size(14).text_color(t.accent)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().text_size(13).font_medium().text_color(t.foreground).child(`Brought over from ${from}`))
          .child(div().text_size(12).line_height("17px").text_color(t.dim).child(`${what}The old folder is unchanged.`)),
      );
  }

  // ---- 2 Agents ----

  agentRow(t, a, first) {
    const cmd = a.installed ? null : installCommand(a.key);
    const id = `onb-copy-${a.key}`;
    const copied = this.copied === id;
    return h_flex()
      .h(42)
      .px(14)
      .gap(12)
      .items_center()
      .when(!first, (el) => el.border_t(1).border_color(t.border))
      .child(this.programTile(a, 24))
      .child(div().w(92).flex_none().truncate().text_size(13.5).font_medium().text_color(a.installed ? t.foreground : t.muted).child(a.name))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .when(Boolean(cmd), (el) =>
            el.child(
              div()
                .id(`${id}-cmd`)
                .h(26)
                .px(9)
                .flex()
                .items_center()
                .rounded(6)
                .border_1()
                .border_color(t.border)
                .bg(t.background)
                .tooltip(cmd)
                .child(div().min_w(0).truncate().font_family("JetBrains Mono").text_size(11).text_color(t.muted).child(cmd)),
            ),
          ),
      )
      .child(
        a.installed
          ? h_flex().w(84).flex_none().gap(6).items_center().justify_end().child(svg(I("check")).size(13).text_color(t.ansi2)).child(div().text_size(12.5).text_color(t.muted).child("Installed"))
          : cmd
            ? this.iconButton(t, id, copied ? "check" : "copy", copied ? "Copied" : "Copy the command", (_e, cx) => this.copy(cmd, id, cx), copied)
            : div().w(84).flex_none().text_size(12.5).text_color(t.dim).child("Not found"),
      );
  }

  yoloCard(t) {
    const on = this.yolo === "on";
    const about = this.yoloError
      ?? (this.yolo === "mixed"
        ? "Some of your agents ask first and some don't. Switch it on to have them all skip the prompts."
        : "Agents edit files and run commands without asking you first.");
    return h_flex()
      .mt(16)
      .px(14)
      .py(12)
      .gap(14)
      .items_center()
      .rounded(10)
      .border_1()
      .border_color(on ? alpha(t.accent, "66") : t.border)
      .bg(t.surface)
      .child(div().size(30).flex_none().rounded(8).bg(alpha(t.accent, "1f")).flex().items_center().justify_center().child(svg(I("zap")).size(15).text_color(t.accent)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().text_size(13.5).font_medium().text_color(t.foreground).child("Start agents without permission prompts (YOLO)"))
          .child(div().text_size(12.5).line_height("18px").text_color(this.yoloError ? t.blocked : t.dim).child(about)),
      )
      .child(this.yolo === null ? svg(I("spinner")).size(13).text_color(t.muted).spin(900) : this.toggle(t, "onb-yolo", on, (_e, cx) => this.toggleYolo(!on, cx), this.yoloBusy));
  }

  agentsPage(t) {
    const list = this.agents;
    const featured = (list ?? []).filter((a) => a.featured);
    const others = (list ?? []).filter((a) => !a.featured);
    const missing = featured.filter((a) => !a.installed).length;
    return v_flex()
      .child(this.title(t, "Your coding agents", "Start any of them from the + menu, each in its own tab."))
      .child(list ? this.card(t, featured.map((a, i) => this.agentRow(t, a, i === 0))) : this.spinner(t, "Looking for agents…"))
      .when(Boolean(list) && (others.length > 0 || missing > 0), (el) =>
        el.child(
          div()
            .pt(8)
            .text_size(12)
            .line_height("17px")
            .text_color(t.dim)
            .child(
              [others.length ? `Also here: ${others.map((a) => a.name).join(", ")}.` : null, missing ? "Paste an install command in any terminal, then reopen this step." : null]
                .filter(Boolean)
                .join(" "),
            ),
        ),
      )
      .child(this.yoloCard(t));
  }

  // ---- 3 Accounts ----

  avatar(t, a) {
    const signedIn = a.state === "in" || a.state === "apikey";
    if (!signedIn) return div().size(28).flex_none().rounded_full().border_1().border_dashed().border_color(t.input);
    const seed = a.email ?? `${a.tool}:${a.id}`;
    const palette = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1].filter(Boolean);
    let h = 0;
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const c = palette[h % palette.length] ?? t.accent;
    const text = a.name && !a.name.includes("@") ? a.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2) : (a.email ?? "?")[0];
    return div()
      .size(28)
      .flex_none()
      .rounded_full()
      .flex()
      .items_center()
      .justify_center()
      .bg(alpha(c, "26"))
      .border_1()
      .border_color(alpha(c, "4d"))
      .text_size(12)
      .font_semibold()
      .text_color(c)
      .child(String(text).toUpperCase());
  }

  chip(t, text, accent) {
    return div()
      .flex_none()
      .px(6)
      .py(1)
      .rounded(5)
      .border_1()
      .border_color(accent ? alpha(t.accent, "59") : t.border)
      .bg(accent ? alpha(t.accent, "1a") : "#00000000")
      .text_size(10.5)
      .font_medium()
      .text_color(accent ? t.accent : t.muted)
      .child(text);
  }

  accountRow(t, a) {
    const signedIn = a.state === "in" || a.state === "apikey";
    const name = !signedIn ? "Not signed in yet" : a.name ?? a.email ?? (a.id === "default" ? "Main account" : "Account");
    const second = a.state === "expired" ? "The login expired: sign in again in Settings › Accounts." : signedIn && a.name && a.email ? a.email : !signedIn ? "Add an account to sign in." : null;
    return h_flex()
      .h(48)
      .px(14)
      .gap(12)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .child(this.avatar(t, a))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(1)
          .child(div().min_w(0).truncate().text_size(13).font_medium().text_color(signedIn ? t.foreground : t.muted).child(name))
          .when(Boolean(second), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(a.state === "expired" ? t.blocked : t.dim).child(second))),
      )
      .when(signedIn && Boolean(a.plan), (el) => el.child(this.chip(t, a.plan, false)))
      .when(signedIn && a.active, (el) => el.child(this.chip(t, "In use", true)));
  }

  accountCard(t, tool) {
    const all = this.accounts.accounts.filter((a) => a.tool === tool && !a.pending);
    const shown = all.filter((a) => a.id === "default" || a.state !== "out");
    const signedIn = shown.filter((a) => a.state === "in" || a.state === "apikey").length;
    return v_flex()
      .w_full()
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .overflow_hidden()
      .child(
        h_flex()
          .h(42)
          .px(14)
          .gap(10)
          .items_center()
          .child(image(TOOLS[tool].icon).size(16).flex_none())
          .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(TOOLS[tool].name))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(signedIn ? `${signedIn} signed in` : ""))
          .child(this.button(t, `onb-add-${tool}`, "Add account", () => this.openSettings("accounts"), "plus")),
      )
      .children(shown.map((a) => this.accountRow(t, a)));
  }

  accountsPage(t) {
    return v_flex()
      .child(this.title(t, "Your accounts", "The Claude Code and Codex logins Atrous found. New agents start on the one marked In use."))
      .child(this.accounts ? v_flex().gap(12).child(this.accountCard(t, "claude")).child(this.accountCard(t, "codex")) : this.spinner(t, "Reading your accounts…"))
      .child(div().pt(12).text_size(12.5).line_height("18px").text_color(t.dim).child("In Settings › Accounts you can pick another one, or let Atrous switch when one reaches its limit."));
  }

  // ---- 4 Browser & skills ----

  skillRow(t) {
    const s = this.skill;
    const tools = s?.tools ?? {};
    const present = ["claude", "codex"].filter((k) => tools[k]?.installed);
    const linked = present.filter((k) => tools[k]?.linked);
    const on = present.length > 0 && linked.length === present.length;
    const names = (ks) => joinAnd(ks.map((k) => TOOLS[k].name));
    const status = this.skillError
      ?? (!s ? "Checking…"
        : !s.shipped ? "The atrous-browser skill isn't in this home yet."
        : !present.length ? "Claude Code and Codex aren't set up on this computer yet."
        : on ? `${names(linked)} can use it.`
        : linked.length ? `Only ${names(linked)} can use it now.`
        : `Off: ${names(present)} won't see it.`);
    const control = this.skillBusy
      ? svg(I("spinner")).size(13).text_color(t.muted).spin(900)
      : this.toggle(t, "onb-skill", on, (_e, cx) => this.toggleSkill(!on, cx), !s?.shipped || !present.length);
    return this.row(t, "Link the skill for Claude Code and Codex", status, control, true, this.skillError ? t.blocked : t.dim);
  }

  browserPage(t) {
    const canImport = pathTo(layout(), "browser").length > 0;
    const rows = [this.skillRow(t)];
    if (canImport)
      rows.push(this.row(t, "Import from Chrome", "Bookmarks, history and saved logins. Optional.", this.button(t, "onb-import", "Import…", (_e, cx) => this.importChrome(cx), "download")));
    rows.push(this.row(t, "Find more skills", "Settings › Skills searches skills.sh for more.", this.button(t, "onb-skills", "Open Skills", () => this.openSettings("skills"), "sparkles")));
    return v_flex()
      .child(
        h_flex()
          .gap(14)
          .items_start()
          .pb(20)
          .child(div().size(40).flex_none().rounded(10).bg(alpha(t.accent, "1f")).flex().items_center().justify_center().child(svg(I("globe")).size(20).text_color(t.accent)))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .child(div().text_size(20).font_semibold().text_color(t.foreground).child("Agents can use the browser"))
              .child(
                div()
                  .text_size(13)
                  .line_height("20px")
                  .text_color(t.muted)
                  .child("The Browser panel is a real Chrome you share with your agents. With the atrous-browser skill they open pages, click and type, read the console and network, and take screenshots while you watch."),
              ),
          ),
      )
      .child(this.card(t, rows))
      .when(Boolean(this.note(t)), (el) => el.child(this.note(t)));
  }

  // ---- 5 Look ----

  themeCard(t, x, current) {
    const on = x.name === current;
    const c = x.colors ?? {};
    const dot = (color) => div().w(7).h(7).rounded(4).bg(color ?? t.dim);
    return v_flex()
      .id(`onb-t-${x.name}`)
      .w(94)
      .gap(6)
      .p(5)
      .rounded(10)
      .border_2()
      .border_color(on ? t.accent : "#00000000")
      .cursor_pointer()
      .hover((s) => s.bg(t.raised))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => this.pickTheme(x, cx))
      .child(
        v_flex()
          .h(50)
          .w_full()
          .p(7)
          .gap(5)
          .rounded(6)
          .border_1()
          .border_color(t.border)
          .bg(c.background ?? t.background)
          .child(div().h(4).w(40).rounded(2).bg(c.terminal_foreground ?? c.foreground ?? t.foreground))
          .child(div().h(4).w(26).rounded(2).bg(c.muted ?? c.dim ?? t.dim))
          .child(h_flex().pt(2).gap(4).child(dot(c.accent)).child(dot(c.ansi1)).child(dot(c.ansi2)).child(dot(c.ansi4))),
      )
      .child(
        h_flex()
          .px(2)
          .gap(4)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(on ? t.foreground : t.muted).child(THEME_NAMES[x.name] ?? x.name.replace(/-/g, " ")))
          .when(on, (el) => el.child(svg(I("check")).size(11).flex_none().text_color(t.accent))),
      );
  }

  lookPage(t) {
    const s = settings();
    if (!this.themeList) this.loadThemes();
    const sidebar = find(layout(), "sidebar");
    const rows = [
      this.row(t, "Appearance", "Light or dark, or as your system is.", this.segment(t, "onb-ap", APPEARANCES, this.appearance ?? null, (v, cx) => this.setAppearance(v, cx)), true),
    ];
    if (sidebar)
      rows.push(this.row(t, "Sidebar", "Wide with names, or a narrow rail of tiles.", this.segment(t, "onb-sb", [[false, "Wide"], [true, "Rail"]], narrowSidebar(), (v, cx) => this.setSidebar(v, cx))));
    return v_flex()
      .child(this.title(t, "Make it yours", "Click a theme to try it. Fonts and layouts are in Settings › Look."))
      .child(h_flex().w_full().flex_wrap().gap(6).pb(16).children(this.themeList.map((x) => this.themeCard(t, x, s.theme))))
      .child(this.card(t, rows));
  }

  // ---- 6 First project ----

  option(t, id, icon, title, detail, onClick, first) {
    return h_flex()
      .id(id)
      .px(16)
      .py(14)
      .gap(14)
      .items_center()
      .cursor_pointer()
      .when(!first, (el) => el.border_t(1).border_color(t.border))
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop)
      .on_click(onClick)
      .child(div().size(34).flex_none().rounded(9).bg(t.raised).border_1().border_color(t.border).flex().items_center().justify_center().child(svg(I(icon)).size(17).text_color(t.muted)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(title))
          .child(div().text_size(12).text_color(t.dim).truncate().child(detail)),
      )
      .child(svg(I("chevron-right")).size(15).flex_none().text_color(t.dim));
  }

  projectPage(t) {
    const before = this.spacesBefore;
    const fresh = before ? spaces().find((s) => !before.has(s.id)) : null;
    const open = spaces().length;
    return v_flex()
      .child(this.title(t, "Open your first project", "A project is a folder you work in. Atrous opens it as a space, where its terminals and agents live."))
      .child(
        this.card(t, [
          this.option(t, "onb-open", "folder-open", "Open a folder", "A project on this computer, a Git repo, or a folder of repos", (_e, cx) => this.openFolder(cx), true),
          this.option(t, "onb-clone", "git-branch", "Clone from Git", "Copy a repository from GitHub or any Git URL", (_e, cx) => this.clone(cx), false),
        ]),
      )
      .when(Boolean(fresh), (el) =>
        el.child(
          h_flex()
            .mt(14)
            .px(14)
            .py(10)
            .gap(10)
            .items_center()
            .rounded(10)
            .border_1()
            .border_color(alpha(t.accent, "59"))
            .bg(alpha(t.accent, "14"))
            .child(svg(I("circle-check")).size(15).flex_none().text_color(t.accent))
            .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(`${fresh.name} is open. Its space is in the sidebar.`)),
        ),
      )
      .when(!fresh, (el) => el.when(Boolean(this.note(t)), (e) => e.child(this.note(t))))
      .child(
        div()
          .pt(14)
          .text_size(12.5)
          .line_height("18px")
          .text_color(t.dim)
          .child(fresh ? "The + in the sidebar adds more anytime." : open ? `${open === 1 ? "One project is" : `${open} projects are`} open already. The + in the sidebar adds more anytime.` : "Not now? The + in the sidebar adds a project anytime."),
      );
  }

  // ---- 7 Ready ----

  keycap(t, k) {
    return div()
      .h(24)
      .min_w(24)
      .px(7)
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .border_1()
      .border_color(t.input)
      .bg(t.raised)
      .text_size(12)
      .font_medium()
      .text_color(t.foreground)
      .child(k);
  }

  donePage(t) {
    const bindings = keys();
    const tips = [
      [["app.palette"], "Command palette", "Every action, by name, with its key"],
      [["mod.open:my-settings", "app.settings"], "Settings", "Accounts, skills, look, and the rest"],
      [["my-status.toggle"], "Quick terminal", "A terminal under your agents, per project"],
      [["tab.new"], "New tab", "A terminal or an agent, in this project"],
    ]
      .map(([actions, title, about]) => ({ keys: keysFor(bindings, actions), title, about }))
      .filter((x) => x.keys)
      .slice(0, 3);
    return v_flex()
      .h(PAGE_H)
      .items_center()
      .justify_center()
      .child(div().size(56).rounded_full().bg(alpha(t.accent, "1f")).flex().items_center().justify_center().child(svg(I("check")).size(26).text_color(t.accent)))
      .child(div().pt(16).text_size(24).font_semibold().text_color(t.foreground).child("You're all set"))
      .child(div().pt(6).text_size(13.5).text_color(t.muted).child(tips.length ? `${tips.length === 3 ? "Three" : tips.length === 2 ? "Two" : "One"} key${tips.length === 1 ? "" : "s"} worth knowing:` : "Have fun."))
      .when(tips.length > 0, (el) =>
        el.child(
          v_flex()
            .mt(18)
            .w(420)
            .rounded(10)
            .border_1()
            .border_color(t.border)
            .bg(t.surface)
            .overflow_hidden()
            .children(
              tips.map((tip, i) =>
                h_flex()
                  .h(52)
                  .px(16)
                  .gap(14)
                  .items_center()
                  .when(i > 0, (e) => e.border_t(1).border_color(t.border))
                  .child(h_flex().w(118).flex_none().gap(4).children(tip.keys.map((k) => this.keycap(t, k))))
                  .child(
                    v_flex()
                      .flex_1()
                      .min_w(0)
                      .gap(1)
                      .child(div().text_size(13.5).font_medium().text_color(t.foreground).child(tip.title))
                      .child(div().truncate().text_size(12).text_color(t.dim).child(tip.about)),
                  ),
              ),
            ),
        ),
      )
      .child(div().pt(18).text_size(12).text_color(t.dim).child("Open this tour again from the command palette: Welcome."));
  }

  // ----------------------------------------------------------------------

  page(t) {
    switch (STEPS[this.step].id) {
      case "welcome": return this.welcome(t);
      case "agents": return this.agentsPage(t);
      case "accounts": return this.accountsPage(t);
      case "browser": return this.browserPage(t);
      case "look": return this.lookPage(t);
      case "project": return this.projectPage(t);
      default: return this.donePage(t);
    }
  }

  render() {
    const t = theme();
    const id = STEPS[this.step].id;
    return h_flex()
      .id("onboarding")
      .track_focus(this.handle)
      .size_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .on_key_down((e, cx) => this.key(e, cx))
      .child(this.rail(t))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .h_full()
          .on_mouse_down("left", stop)
          .child(
            // A bar only when a page is taller than the window (a big zoom).
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(div().id(`onb-body-${id}`).size_full().overflow_y_scroll().child(div().px(36).pt(30).pb(20).child(this.page(t))))
              .child(Scrollbar.vertical(`onb-body-${id}`).absolute().inset_0()),
          )
          .child(this.footer(t)),
      );
  }
}
