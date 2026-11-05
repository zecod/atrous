// Project start: what a new project shows first, in place of a bare shell. A big button for each
// installed coding agent (Claude Code, Codex, Pi, OpenCode first, then the others by how often
// they're started: agent-order.js), and a smaller Terminal. A pick starts it in this space (`argv` =
// programs.json `run`, with its flags and account launcher) and closes this tab, so nothing is left
// behind. While it shows, the side panel (Fedra's `panel`: Files, Changes, Browser) is closed so the
// buttons get the width; after a pick it's put back as it was before the project opened.
//
// Opening a project with it (space.new always starts a terminal, so the start tab replaces it):
//   const existing = spaces().map((s) => s.id);
//   run("space.new", { folder, machine: machine ?? "" });
//   run("tab.new", { name: "Start", mod: "start",
//     props: { folder, machine, fresh: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, existing, panel } });
// `panel`: the side panel's shown child before the project opened ("files", ...; null: closed;
// left out where the layout has no `panel`).
// Both are queued in order and space.new makes the new space the shown one, so the tab lands there.
// When this pane first starts it closes the shell tab space.new made, once per `fresh` token and
// only when it's sure: a space that wasn't in `existing`, in that folder, whose only other tab is
// one plain terminal.
//
// The panel is closed and put back with layout clicks (layout.hide / layout.select + layout.show),
// never by editing the layout file. my-tabs remembers the panel per space from what it sees, so
// putting it back also puts back that memory.
//
// As a dialog, for layouts that show no tabs (Flow: flow-canvas opens it when a start tab
// appears): props { tab, space, pending? } name the start tab it stands for. It closes the space's
// fresh shell tab the same way (once per start tab, only when the space holds just the two), a
// pick replaces the start tab, and `pending` (Flow's "flow.pending") hands the new terminal over
// so the canvas shows it at once. Esc or the x closes it and leaves the project as it is.
//
// Props: { folder?, machine?, fresh?, existing?, panel? } (folder: else the space's). Keys while it has the
// keyboard: 1-9 start the agent with that number, T a terminal. Commands (`start.<name>`):
// focus, start:<agent key>, terminal.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, theme, props, spaces, panes, terminals, shared, setShared, layout, nextCommand, openOverlay, closeOverlay, window } from "atrous";
import { agentOrder, noteAgentUse, cachedAgents, loadAgents } from "./agent-order.js";

const MOD = "start";
const CLEANED = "start.cleaned"; // shared: { "<fresh token>" | "tab:<start tab>": ms }, the shell tabs already closed
const I = (name) => `mods/start/${name}.svg`;
const GAP = 12;
const CARD_MIN = 140; // px: the narrowest a card gets before a column goes
const COLS = 4; // at most: Claude Code, Codex, Pi, OpenCode share the first row
const CARD_MAX = 172;

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const samePath = (a, b) => (window()?.platform === "windows" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b));

function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const f = find(c, id);
    if (f) return f;
  }
  return null;
}

// The side panel and the stack inside it that picks Files / Changes / Browser.
function sidePanel() {
  const panel = find(layout(), "panel");
  const body = panel && (find(panel, "panel-body") ?? (panel.children ?? []).find((c) => c.type === "stack"));
  return panel ? { panel, body } : null;
}

export default class ProjectStart extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.dialog = Boolean(p.overlay && p.tab && p.space); // standing in for a start tab the layout can't show
    this.machine = p.machine ?? (this.dialog ? spaces().find((s) => s.id === p.space)?.machine : null) ?? null;
    this.agents = cachedAgents(this.machine); // the last list, at once; checked again below
    this.loaded = false;
    this.starting = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    if (!this.dialog) this.hidePanel();
    this.settle(cx, 0);
    cx.spawn(async (cx) => {
      try {
        this.agents = await loadAgents(this.machine);
      } catch {
        this.failed = true;
      }
      this.loaded = true;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        if (c === "focus") this.handle.focus();
        else if (c === "terminal") this.start(null, cx);
        else if (c.startsWith("start:")) {
          const a = agentOrder(this.agents).installed.find((x) => x.key === c.slice(6));
          if (a) this.start(a, cx);
        }
        cx.notify();
      }
    });
  }

  // This pane's tab and space, once settle() found them (null until then).
  whoAmI() {
    return this.me ?? null;
  }

  // Which start pane this is, or null if the live data can't tell yet: when a copy starts, the
  // spaces and panes it reads can still be the ones from before its space existed. A new project's
  // (props.existing): the one start pane in a space that wasn't there before, in its folder, and
  // nothing else. Otherwise (a start tab after a restart) the active space's active tab: a tab's mod
  // starts the first time it shows. Never focused(), which lags behind a new space too.
  identify() {
    const p = props() ?? {};
    if (this.dialog) return { tab: p.tab, space: p.space };
    const mine = panes().filter((x) => x.mod === MOD);
    const spaceOf = (tab) => spaces().find((s) => (s.tabs ?? []).some((t) => t.id === tab));
    let pane = null;
    if (Array.isArray(p.existing)) {
      const fits = mine.filter((x) => {
        const s = spaceOf(x.tab);
        return s && !p.existing.includes(s.id) && (!p.folder || samePath(s.folder, p.folder));
      });
      pane = fits.length === 1 ? fits[0] : null;
    } else {
      const shown = spaces().find((s) => s.active);
      const tab = (shown?.tabs ?? []).find((t) => t.active)?.id;
      pane = mine.find((x) => x.tab === tab) ?? null;
    }
    const space = pane && spaceOf(pane.tab);
    return space ? { tab: pane.tab, space: space.id } : null;
  }

  // Finds itself (tries for 3 s while the live data catches up), then closes the shell tab
  // space.new made. The first look waits a moment for the same reason.
  settle(cx, tries) {
    const me = tries > 0 || this.dialog ? this.identify() : null;
    if (me) {
      this.me = me;
      this.cleanUp();
      return;
    }
    if (tries < 30) cx.timer.after(100, (cx) => { this.settle(cx, tries + 1); cx.notify(); });
  }

  cleanUp() {
    const p = props() ?? {};
    const token = p.fresh ?? (this.dialog ? `tab:${p.tab}` : null);
    if (!token) return;
    const done = shared(CLEANED) ?? {};
    if (done[token]) return;
    const me = this.me;
    const space = spaces().find((s) => s.id === me.space);
    const others = (space?.tabs ?? []).filter((t) => t.id !== me.tab);
    // The dialog can't see the start tab's props: the space holding just it and a plain shell says enough.
    const made = this.dialog || (Array.isArray(p.existing) && !p.existing.includes(me.space));
    const here = !p.folder || samePath(space?.folder, p.folder);
    const lone = others.length === 1 ? panes().filter((x) => x.tab === others[0].id) : [];
    const plainShell = lone.length === 1 && Boolean(lone[0].terminal) && !lone[0].status && !lone[0].app;
    if (made && here && plainShell) run("tab.close", { id: others[0].id });
    const kept = Object.entries({ ...done, [token]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 40);
    setShared(CLEANED, Object.fromEntries(kept));
  }

  // Closes the side panel while this shows (it starts when it first shows: a new project, or this
  // tab after a restart). The panel's state before is kept for when no opener said.
  hidePanel() {
    const side = sidePanel();
    if (!side) return;
    this.panelBefore = side.panel.hidden ? null : side.body?.active ?? null;
    if (!side.panel.hidden) run("layout.hide", { id: side.panel.id });
  }

  // The side panel as it was before the project opened (props.panel), else before this showed.
  restorePanel() {
    const p = props() ?? {};
    const want = typeof p.panel === "string" || p.panel === null ? p.panel : this.panelBefore;
    const side = sidePanel();
    if (!want || !side?.body || !find(side.body, want)) return;
    run("layout.select", { stack: side.body.id, child: want });
    run("layout.show", { id: side.panel.id });
  }

  space() {
    const me = this.whoAmI();
    return me ? spaces().find((s) => s.id === me.space) ?? null : null;
  }

  folder() {
    return props()?.folder || this.space()?.folder || "";
  }

  // Starts the agent (null: a terminal) in this project, then closes this tab. The close is not
  // confirmed, so if the new tab didn't come, the space's last tab stays (and so does the space).
  start(agent, cx) {
    const me = this.whoAmI();
    if (this.starting || !me) return;
    this.starting = true;
    const folder = this.folder();
    const pending = props()?.pending;
    if (this.dialog && pending) {
      const before = terminals().filter((k) => k.labels?.["atrous.space"] === me.space).map((k) => k.address);
      setShared(pending, { space: me.space, before, at: Date.now() });
    }
    run("tab.new", { space: me.space, ...(folder ? { folder } : {}), ...(agent ? { name: agent.name, argv: agent.run } : {}) });
    if (agent) noteAgentUse(agent.key);
    run("tab.close", { id: me.tab });
    if (this.dialog) closeOverlay(props().overlay);
    else this.restorePanel();
    // Still here a moment later (the tab couldn't start): the buttons work again.
    cx.timer.after(3000, (cx) => { this.starting = false; cx.notify(); });
    cx.notify();
  }

  // ---- drawing ----

  tile(a, size) {
    const glyph = Math.round(size * 0.58);
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

  keycap(t, k) {
    return div()
      .h(20)
      .min_w(20)
      .px(5)
      .flex()
      .items_center()
      .justify_center()
      .rounded(5)
      .border_1()
      .border_color(t.border)
      .text_size(11)
      .font_medium()
      .text_color(t.dim)
      .child(k);
  }

  // A big button: a card with the agent's tile above its name; `compact` (a narrow pane): one line.
  card(t, a, i, w, compact) {
    if (compact)
      return h_flex()
        .id(`ps-agent-${a.key}`)
        .w(w)
        .h(58)
        .px(12)
        .gap(12)
        .items_center()
        .rounded(12)
        .border_1()
        .border_color(t.border)
        .bg(t.surface)
        .cursor_pointer()
        .when(this.starting, (el) => el.opacity(0.6))
        .hover((s) => s.bg(t.raised).border_color(t.input))
        .on_click((_e, cx) => this.start(a, cx))
        .child(this.tile(a, 32))
        .tooltip(a.name)
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(a.name))
        .when(i < 9, (el) => el.child(this.keycap(t, String(i + 1))));
    return v_flex()
      .id(`ps-agent-${a.key}`)
      .w(w)
      .h(98)
      .p(14)
      .justify_between()
      .rounded(12)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .cursor_pointer()
      .when(this.starting, (el) => el.opacity(0.6))
      .hover((s) => s.bg(t.raised).border_color(t.input))
      .on_click((_e, cx) => this.start(a, cx))
      .child(h_flex().items_start().justify_between().child(this.tile(a, 34)).when(i < 9, (el) => el.child(this.keycap(t, String(i + 1)))))
      .child(div().truncate().text_size(14).font_semibold().text_color(t.foreground).child(a.name));
  }

  terminalButton(t) {
    return h_flex()
      .id("ps-terminal")
      .h(32)
      .px(12)
      .gap(8)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .text_size(13)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.start(null, cx))
      .child(svg(I("terminal")).size(14))
      .child("Open a terminal")
      .child(this.keycap(t, "T"));
  }

  render() {
    const t = theme();
    const installed = agentOrder(this.agents).installed;
    const none = this.loaded && !installed.length;
    // As many columns as fit (up to 4), the cards sharing the width.
    const avail = Math.max(CARD_MIN, Math.min((this.width ?? 700) - 48, COLS * CARD_MAX + (COLS - 1) * GAP));
    const cols = Math.max(1, Math.min(COLS, Math.floor((avail + GAP) / (CARD_MIN + GAP))));
    const compact = cols <= 2;
    const cardW = compact ? Math.floor((avail - GAP * (cols - 1)) / cols) : Math.min(CARD_MAX, Math.floor((avail - GAP * (cols - 1)) / cols));
    const body = installed.length
      ? h_flex().w_full().flex_wrap().gap(GAP).children(installed.map((a, i) => this.card(t, a, i, cardW, compact)))
      : none
        ? v_flex()
            .gap(10)
            .p(16)
            .rounded(12)
            .border_1()
            .border_dashed()
            .border_color(t.input)
            .child(div().text_size(13.5).text_color(t.foreground).child(this.failed ? "Couldn't check which agents are installed." : "No coding agents on this computer yet."))
            .child(div().text_size(12.5).line_height("18px").text_color(t.dim).child("Claude Code, Codex, Pi and OpenCode install with one command each."))
            .child(
              h_flex()
                .id("ps-install")
                .h(28)
                .px(10)
                .gap(6)
                .items_center()
                .self_start()
                .rounded(7)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .text_size(12.5)
                .font_medium()
                .text_color(t.foreground)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() => openOverlay({ mod: "onboarding", kind: "window", width: 760, height: 540, props: { step: "agents" } }))
                .child(svg(I("download")).size(13).text_color(t.muted))
                .child("How to install them"),
            )
        : h_flex().gap(8).items_center().py(10)
            .child(svg(I("spinner")).size(13).text_color(t.muted).spin(900))
            .child(div().text_size(12.5).text_color(t.dim).child("Looking for your agents…"));
    const name = this.space()?.name || "this project";
    return v_flex()
      .id("start-root")
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (Math.abs((this.width ?? 0) - size.width) < 1) return;
        this.width = size.width;
        cx.notify();
      })
      .when(!this.dialog, (el) => el.size_full().bg(t.background).items_center().justify_center().p(24))
      .when(this.dialog, (el) => el.w_full().bg(t.popover).items_center().px(24).pt(18).pb(22))
      .on_key_down((e, cx) => {
        const m = e.modifiers ?? {};
        if (m.control || m.alt || m.platform) return;
        const k = String(e.key ?? "").toLowerCase();
        if (/^[1-9]$/.test(k) && installed[Number(k) - 1]) this.start(installed[Number(k) - 1], cx);
        else if (k === "t") this.start(null, cx);
        else return;
        cx.stop_propagation();
      })
      .on_mouse_down("left", () => this.handle.focus())
      .child(
        v_flex()
          // As wide as the buttons in a row, so a few stay centered.
          .w(Math.max(1, Math.min(cols, installed.length || cols)) * (cardW + GAP) - GAP)
          .when(!this.dialog, (el) => el.pb(40).child(div().pb(12).text_size(11.5).font_semibold().text_color(t.dim).child("START AN AGENT")))
          .when(this.dialog, (el) =>
            el.child(
              h_flex()
                .pb(14)
                .gap(8)
                .items_center()
                .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().text_color(t.foreground).child(`Start an agent in ${name}`))
                .child(
                  div()
                    .id("ps-close")
                    .size(26)
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(7)
                    .cursor_pointer()
                    .text_color(t.muted)
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click(() => closeOverlay(props().overlay))
                    .child(svg(I("x")).size(13)),
                ),
            ),
          )
          .child(body)
          .child(h_flex().pt(18).child(this.terminalButton(t))),
      );
  }
}
