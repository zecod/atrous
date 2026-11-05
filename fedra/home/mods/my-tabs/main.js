import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, focused, exec, appHome, readTextFile, notify } from "atrous";
import { tabTerminal, armDrag, dragMove, dragLeft, disarm } from "./drag-out.js"; // smart split: drag a tab's agent down onto the tab

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Personal copy of the shipped `tabs` mod (cloned from 0.1.12). Change: a tab
// that nobody named (or that is only named after its program, as the + menu
// names them) shows its agent's session title, the one Claude Code, Codex and
// others set as the terminal title, so two "Claude Code" tabs read differently.

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// The pane that speaks for a tab: its agent, else the focused one, else the first.
function lead(tab, all) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

// An agent's own title, when it says something its program name doesn't.
export function sessionTitle(p) {
  if (!p?.program?.agent) return null;
  const live = clean(p.title);
  const prog = p.program?.name;
  if (!live || live === prog || live.toLowerCase() === p.program?.key) return null;
  if (/^[~/]|^[A-Za-z]:\\/.test(live) || live.includes("@")) return null;
  return live;
}

const home_ = () => appHome().replaceAll("\\", "/");

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // "Open in IDE": the editors found on this machine (mods/open-in/detect.mjs -> data/ides.json).
    this.ides = null;
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${home_()}/data/ides.json`).catch(() => null);
      this.ides = text ? JSON.parse(text) : null;
      cx.notify();
      if (!this.ides || Date.now() - (this.ides.updated ?? 0) > 7 * 86400000) {
        const r = await exec("node", [`${home_()}/mods/open-in/detect.mjs`, appHome()]).catch(() => null);
        if (r?.code === 0) { this.ides = JSON.parse(r.stdout); cx.notify(); }
      }
    });
  }

  // The shown project's folder: the focused terminal's git checkout (a worktree is its own),
  // else that terminal's folder, else the space's.
  async projectFolder() {
    const space = spaces().find((s) => s.active);
    const f = focused();
    const cwd = (f?.space === space?.id ? f?.cwd : null) || panes().find((p) => space?.tabs?.some((t) => t.id === p.tab) && p.cwd)?.cwd || space?.folder;
    if (!cwd) return null;
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
    return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
  }

  defaultIde() {
    const list = this.ides?.ides ?? [];
    return list.find((i) => i.id === shared("ide.default")) ?? list.find((i) => !i.system) ?? list[0] ?? null;
  }

  openIde(cx, ide) {
    if (!ide) return this.ideMenu(cx);
    cx.spawn(async () => {
      const folder = await this.projectFolder();
      if (!folder) return notify({ title: "No folder to open", level: "warning" });
      const r = await exec("node", [`${home_()}/mods/open-in/open.mjs`, JSON.stringify(ide), folder]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: `Couldn't open ${ide.name}`, body: (r.stderr ?? "").trim(), level: "error" });
    });
  }

  ideMenu(cx) {
    cx.spawn(async () => {
      const folder = await this.projectFolder();
      openOverlay({ mod: "open-in", kind: "popup", width: 240, height: 320, props: { folder } });
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // [ <default editor's icon> Open | ▾ ]: opens the shown project in that editor; ▾ lists the
  // editors installed here (mods/open-in) and picking one makes it the default.
  openButton(t, stop) {
    const ide = this.defaultIde();
    const half = (id) => h_flex().id(id).h(26).items_center().flex_none().text_size(12).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop);
    return h_flex().id("open-ide").h(26).flex_none().items_center().rounded(6).border_1().border_color(t.border).mr(4)
      .child(half("open-ide-main").pl(7).pr(8).gap(6).rounded_l(6)
        .tooltip(ide ? `Open the project in ${ide.name}` : "Open the project in an editor")
        .on_click((_e, cx) => this.openIde(cx, ide))
        .child(ide?.icon ? image(ide.icon).w(14).h(14).flex_none() : svg("mods/files/file.svg").size(14))
        .child("Open"))
      .child(div().w(1).h(16).bg(t.border))
      .child(half("open-ide-menu").px(5).rounded_r(6).tooltip("Choose an editor")
        .on_click((_e, cx) => this.ideMenu(cx))
        .child(svg("mods/my-tabs/chevron-down.svg").size(12)));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const ps = panes();
    const item = (c, i) => {
      const l = lead(c, ps);
      const program = l?.program ?? ps.find(p => p.tab === c.id)?.program;
      const auto = !c.named || /^tb\d+$/.test(c.name) || /^\d+$/.test(c.name) || c.name === program?.name;
      const name = auto ? sessionTitle(l) ?? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); armDrag(this, tabTerminal(c.id), e, { down: 12, from: "tab" }); }) // smart split: armDrag
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .tooltip(program?.name && name !== program.name ? `${name} · ${program.name}` : name)
        .child(div().max_w(200).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          // The layout can change between render and click (a stand-in while a layout file is
          // being rewritten has no side panel): only act on nodes that exist right now.
          const now = layout();
          if (!find(now, "panel") || !find(now, id)) return;
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; disarm(this); }) // smart split: disarm
      // smart split: a pressed pill dragged down (or out of the bar) becomes a snap-split drag, not a reorder
      .id("tab-bar").on_mouse_move((e) => { if (dragMove(this, e)) this.pressed = null; })
      .on_hover((over) => { if (!over && dragLeft(this)) this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "my-new-menu", kind: "popup", width: 250, height: 512 })))
      .child(this.openButton(t, stop))
      .when(Boolean(panel && find(root, "files")) && enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(Boolean(panel && find(root, "changes")) && enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      // A real Chrome in the side panel (mods/browser-panel); agents drive it over CDP at 127.0.0.1:9733.
      .when(Boolean(panel && find(root, "browser")), el => el.child(panelButton("browser", "Browser", "mods/browser-panel/icons/globe.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/my-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/my-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/my-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
