// Right-click menu for an agent in the sidebar tree (opened by my-spaces).
// The point: hand one agent's session to ANOTHER agent so it can talk to it.
// - Copy agent ID: the atrous-core address (t11). Any agent can drive it with atc:
//   `atc send t11 "…"`, `atc wait t11`, `atc read t11`.
// - Copy session ID: the Claude Code / Codex session id (claude --resume <id>), when known.
// - Copy message for another agent: a ready-to-paste note with both and the exact commands.
// Plus Go to and Pin. Props: { address, title, program, cwd, sessionId, source, pinned, pane, overlay }.
// Close agent (last, in red): asks in the menu first, then closes its pane (its tab when that's
// the tab's only pane), or ends it (atc kill) when it has no pane (a sub-agent).
// smart split: "Move to this tab" (Left, Right, Top, Bottom, New tab) puts the agent
// beside the focused pane of the shown tab; mods/snap-split does the move.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, notify, openOverlay, panes, focused, spaces, agents, nextCommand } from "atrous"; // smart split: openOverlay..agents

// smart split: the five places, and a tiny drawing of each (a pane with its new half filled).
const MOVES = [["left", "Left"], ["right", "Right"], ["top", "Top"], ["bottom", "Bottom"], ["tab", "New tab"]];
const FILL = { left: [0, 0, 6, 9], right: [6, 0, 6, 9], top: [0, 0, 12, 4], bottom: [0, 5, 12, 4] };

// smart split: why this agent can't move into the shown tab, or null.
function cantMove(addr) {
  if (!addr) return "no agent";
  const sp = spaces();
  const agent = agents().find((a) => a.address === addr);
  const machine = addr.includes("/") ? addr.split("/")[0] : sp.find((s) => s.id === agent?.space)?.machine ?? null;
  if (machine) return `on ${machine}`;
  if (sp.find((s) => s.id === focused()?.space)?.machine) return "remote tab";
  const mine = panes().filter((p) => p.tab === focused()?.tab);
  if (mine.length === 1 && mine[0].terminal === addr) return "already here";
  return null;
}

const I = (name) => `mods/agent-menu/${name}.svg`;

function handoff(p) {
  const who = `${p.program ?? "agent"} session "${p.title}"`;
  const lines = [
    `You can talk to my ${who}. It runs in Atrous, terminal ${p.address}${p.cwd ? `, in ${p.cwd}` : ""}.`,
    `- Send it a message (pastes it and presses Enter):  atc send ${p.address} "<your message>"`,
    `- Wait until it has finished answering:            atc wait ${p.address}`,
    `- Read its answer (screen and recent history):     atc read ${p.address} --lines 150`,
    `Ask one clear question at a time, wait, then read before sending the next.`,
  ];
  if (p.sessionId) {
    lines.push(p.source === "codex"
      ? `Its Codex session id is ${p.sessionId} (codex resume ${p.sessionId}).`
      : `Its Claude Code session id is ${p.sessionId} (transcript readable with: claude --resume ${p.sessionId}).`);
  }
  return lines.join("\n");
}

// Ends the agent: its pane, or its tab when that's the tab's only pane (closing a space's last tab
// closes the space, as everywhere in Atrous), or, with no pane (a sub-agent), the terminal itself.
function closeAgent(p) {
  const ps = panes();
  const pane = p.pane ?? ps.find((x) => x.terminal === p.address)?.pane ?? null;
  if (!pane) return run("terminal.kill", { terminal: p.address });
  const tab = ps.find((x) => x.pane === pane)?.tab;
  if (tab && ps.filter((x) => x.tab === tab).length <= 1) run("tab.close", { id: tab, confirmed: true });
  else run("pane.close", { pane });
}

export default class AgentMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    // Test commands (`atrous do agent-menu.<cmd>`): close (what clicking "Close agent" does), confirm
    // (its Close button), cancel.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        const p = props() ?? {};
        if (c === "close") this.confirming = true;
        else if (c === "cancel") this.confirming = false;
        else if (c === "confirm" && this.confirming) { closeOverlay(p.overlay); closeAgent(p); }
        cx.notify();
      }
    });
  }

  items() {
    const p = props() ?? {};
    return [
      { icon: "copy", label: "Copy agent ID", hint: p.address, copy: () => p.address,
        done: `Copied ${p.address}. Other agents talk to it with atc send / wait / read ${p.address}.` },
      { icon: "copy", label: "Copy session ID", hint: p.sessionId ? "" : "unknown", enabled: Boolean(p.sessionId),
        copy: () => p.sessionId, done: "Copied the session id." },
      { icon: "message", label: "Copy message for another agent", hint: "", copy: () => handoff(p),
        done: "Copied. Paste it to another agent so it can talk to this session.", sep: true },
      { icon: "focus", label: "Go to agent", hint: "", act: () => run("pane.focus", { pane: p.pane }), enabled: Boolean(p.pane) },
      { icon: p.pinned ? "pin-off" : "pin", label: p.pinned ? "Unpin" : "Pin to the top", hint: "",
        act: () => run("terminal.pin", { terminal: p.address, pinned: !p.pinned }) },
    ];
  }

  choose(i, cx) {
    const it = this.items()[i];
    if (!it || it.enabled === false) return;
    const p = props();
    if (it.copy) {
      cx.write_to_clipboard(it.copy());
      notify({ title: it.done, level: "success", timeout: 3500 });
    } else it.act?.();
    closeOverlay(p.overlay);
  }

  // smart split: the menu goes, then snap-split moves the agent (same park/keep/swap as a drop).
  move(side) {
    const p = props();
    closeOverlay(p.overlay);
    openOverlay({ mod: "snap-split", kind: "window", frame: "none", width: 300, height: 40, props: { terminal: p.address, place: side } });
  }

  // smart split: "Move to this tab" and its five buttons, or why not.
  moveRow(t, p) {
    const why = cantMove(p.address);
    const glyph = (side, color) => side === "tab"
      ? div().h(11).flex().items_center().text_size(14).text_color(color).child("+")
      : div().relative().w(14).h(11).rounded(2).border_1().border_color(color)
        .child(div().absolute().left(FILL[side][0]).top(FILL[side][1]).w(FILL[side][2]).h(FILL[side][3]).rounded(1).bg(color));
    return v_flex().px(3).pb(2)
      .child(div().px(5).pt(2).pb(3).text_size(11).text_color(t.dim).truncate()
        .child(why ? `Move to this tab · ${why}` : "Move to this tab"))
      .child(h_flex().gap(2).children(MOVES.map(([side, word]) => v_flex().id(`am-move-${side}`).flex_1().h(36).gap(3)
        .items_center().justify_center().rounded(6)
        .when(Boolean(why), (el) => el.opacity(0.4))
        .when(!why, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.move(side)))
        .tooltip(why ? `Can't move it here: ${why}` : side === "tab" ? "Move it here as a new tab" : `Move it ${word.toLowerCase()} of the focused pane`)
        .child(glyph(side, why ? t.dim : t.foreground))
        .child(div().text_size(10.5).text_color(why ? t.dim : t.muted).child(word)))));
  }

  // The last row: "Close agent", or, once chosen, the question and its two buttons.
  closeRow(t, p) {
    const btn = (id, label, danger, action) => div().id(id).h(26).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(danger, (el) => el.bg(t.blocked).text_color(t.background).font_semibold().hover((s) => s.opacity(0.85)))
      .when(!danger, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(action).child(label);
    return v_flex().px(8).py(6).gap(8).rounded(7).bg(t.selected)
      .child(div().text_size(12.5).text_color(t.foreground).child(`Close ${p.title ?? p.address}? The agent stops.`))
      .child(h_flex().gap(6)
        .child(btn("am-close-yes", "Close", true, () => { closeOverlay(p.overlay); closeAgent(p); }))
        .child(btn("am-close-no", "Cancel", false, (_e, cx) => { this.confirming = false; cx.notify(); })));
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const list = this.items();
    return v_flex().id("agent-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % (list.length + 1);
        else if (e.key === "up") this.at = (this.at + list.length) % (list.length + 1);
        else if (e.key === "enter") {
          if (this.confirming) { closeOverlay(p.overlay); closeAgent(p); return; }
          if (this.at === list.length) { this.confirming = true; cx.notify(); return; }
          return this.choose(this.at, cx);
        } else if (e.key === "escape") {
          if (this.confirming) { this.confirming = false; cx.notify(); return; }
          return closeOverlay(p.overlay);
        }
        else return;
        cx.notify();
      })
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(`${p.title ?? p.address} · ${p.address}`))
      .children(list.map((it, i) => v_flex()
        .when(Boolean(it.sep), (el) => el)
        .child(h_flex().id(`am-${i}`).h(31).px(8).gap(9).rounded(7).items_center()
          .text_color(it.enabled === false ? t.dim : it.danger ? t.blocked : t.foreground)
          .when(i === this.at && it.enabled !== false, (el) => el.bg(t.selected))
          .when(it.enabled !== false, (el) => el.hover((s) => s.bg(t.hover)).cursor_pointer())
          .on_click((_e, cx) => this.choose(i, cx))
          .child(svg(I(it.icon)).size(14).flex_none().text_color(it.danger ? t.blocked : t.muted))
          .child(div().flex_1().truncate().child(it.label))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(it.hint ?? "")))
        .when(Boolean(it.sep), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))))
      .child(div().mx(7).my(4).h(1).bg(t.border)) // smart split
      .child(this.moveRow(t, p)) // smart split
      .child(div().mx(7).my(4).h(1).bg(t.border))
      .child(this.confirming ? this.closeRow(t, p) : h_flex().id("am-close").h(31).px(8).gap(9).rounded(7).items_center()
        .text_color(t.blocked).cursor_pointer().hover((s) => s.bg(t.hover))
        .when(this.at === list.length, (el) => el.bg(t.selected))
        .on_click((_e, cx) => { this.confirming = true; cx.notify(); })
        .child(svg(I("close")).size(14).flex_none().text_color(t.blocked))
        .child(div().flex_1().truncate().child("Close agent")));
  }
}
