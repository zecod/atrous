// Smart split: where a dragged agent lands. The drag starts in the sidebar
// (mods/my-spaces/smart-split.js), which opens this mod as a frameless overlay
// window over the whole window while the button is still down; from then on the
// pointer is ours. Zones like Windows' snap layouts appear over the shown tab,
// the one under the pointer lights up, and letting go moves the agent's
// terminal there:
//   an edge of a pane: beside it, in half its room (from a corner of a pane
//   that is already half the tab: a quarter); the middle: a new tab here;
//   the snap bar over the tab bar (as Windows 11 shows one when a window is
//   dragged to the top): left | right, top / bottom, new tab, beside the focused pane.
//   Anywhere else, right-click or Esc: nothing moves.
// The move is terminal.park (if it has a pane) then terminal.keep beside the
// pane it was dropped on, then pane.swap for left and top. Only this computer's
// agents move: a terminal's pane stays on its own machine.
//
// Place mode (props.place: "left" | "right" | "top" | "bottom" | "tab"), as the
// agent menu opens it: no drag, the same move at once beside the focused pane,
// shown as a small pill. (A mod's own commands only reach copies that are shown,
// and this one never is, so the menu opens it as an overlay instead.)
//
// What each drag and move did goes to data/snap-split-trace.log (last 80 lines).
// Props: { terminal, x, y, t } (the pointer and time when the drag began) or
// { terminal, place }; overlay.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, run, notify, theme, agents, terminals, panes, focused, spaces, layout, appHome, readTextFile, writeTextFile } from "herdr";
import { tabArea, paneRects, readTabTree, zoneAt, zoneFor, zoneWords, snapBar, insideRect } from "./geometry.js";

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const isPath = (s) => /^[~/]|^[A-Za-z]:\\/.test(s) || s.includes("@");
// As the sidebar names it: the session title, else a named tab, else the program.
function title(a, term, addr) {
  const prog = a?.program?.name ?? term?.program?.name;
  const live = clean(a?.title ?? term?.title);
  if (live && live !== prog && live.toLowerCase() !== a?.program?.key && !isPath(live)) return live;
  if (a?.tab_name && !/^\d+$/.test(a.tab_name) && a.tab_name !== prog) return a.tab_name;
  return term?.name || prog || addr || "agent";
}
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}
// A theme color with an alpha, when it's #rrggbb.
const alpha = (c, a) => (/^#[0-9a-f]{6}/i.test(c ?? "") ? c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0") : c);

const IDLE_MS = 20000; // no pointer news for this long (a release we never saw): give up
const SIDE_WORDS = { left: "to the left", right: "to the right", top: "above", bottom: "below", tab: "into a new tab" };

// One line per step, newest last. Each line is its own read-append-write, retried
// when another line got there first (the write checks the text it read).
// Never under mods/: on Windows a write in a mod's folder reports the folder as
// changed, and herdr reloads every copy of that mod (killing a move in progress).
const TRACE_FILE = "data/snap-split-trace.log";
const pendingTraces = new Set();
function trace(line) {
  if (!TRACE_FILE) return;
  const text = `${new Date().toISOString()} ${line}`;
  const job = (async () => {
    const file = `${appHome()}/${TRACE_FILE}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const old = await readTextFile(file);
        const lines = (old ?? "").split("\n").filter(Boolean).slice(-79);
        lines.push(text);
        await writeTextFile(file, lines.join("\n") + "\n", old ?? null);
        return;
      } catch {}
    }
  })();
  pendingTraces.add(job);
  job.finally(() => pendingTraces.delete(job));
}
const tracesWritten = () => Promise.all([...pendingTraces]);

export default class SnapSplit extends View {
  init(_props, cx) {
    const p = this.input();
    this.mode = p.place ? "place" : "drag";
    this.pt = { x: p.x ?? -1, y: p.y ?? -1 };
    this.k = 1; // window px per mod px (zoom)
    this.size = null; // this overlay: the whole window when dragging
    this.tab = focused()?.tab ?? null;
    this.tree = null; // the shown tab's splits, once read
    this.moving = null; // { zone, who } once dropped
    this.done = false;
    this.seen = Date.now();
    this.opened = Date.now();
    this.moves = 0;
    const who = this.who();
    trace(`open ${this.mode} ${who.addr} "${who.name}"${p.place ? ` place=${p.place}` : ""} tab=${this.tab}${who.why ? ` why="${who.why}"` : ""}${p.t ? ` +${this.opened - p.t}ms after threshold` : ""}`);
    if (this.mode === "place") {
      this.h = cx.focus_handle(); // never takes the keyboard: a menu pick, not a gesture
      this.placeNow(p.place, cx);
      return;
    }
    this.grab(cx);
    cx.spawn(async (cx) => {
      this.tree = await readTabTree(this.tab).catch(() => null);
      cx.notify();
    });
    cx.timer.every(1000, () => {
      if (!this.moving && Date.now() - this.seen > IDLE_MS) { trace("cancel: no pointer news"); this.dismiss(cx); }
    });
  }

  input() {
    return props() ?? {};
  }

  // The keyboard, so Esc cancels here instead of reaching the terminal.
  grab(cx) {
    this.h = cx.focus_handle();
    this.h.focus();
  }

  // Who is dragged, and why it can't land here, if it can't.
  who() {
    const addr = this.input().terminal ?? null;
    const term = terminals().find((t) => t.address === addr);
    const agent = agents().find((a) => a.address === addr);
    const sp = spaces();
    const here = sp.find((s) => s.id === focused()?.space);
    const machine = addr?.includes("/") ? addr.split("/")[0] : sp.find((s) => s.id === agent?.space)?.machine ?? null;
    let why = null;
    if (!addr || !term || (term.state && term.state !== "live")) why = "it isn't running";
    else if (machine) why = `it runs on ${machine}`;
    else if (here?.machine) why = "this space is on another machine";
    return {
      addr,
      name: title(agent, term, addr),
      program: agent?.program ?? term?.program ?? null,
      own: panes().find((p) => p.terminal === addr) ?? null,
      why,
    };
  }

  // The panes it can land beside, each with where it is on screen.
  targets(area, gap, own) {
    const tab = focused()?.tab;
    const mine = panes().filter((p) => p.tab === tab);
    const others = mine.filter((p) => p.pane !== own?.pane);
    if (!others.length) return [];
    const zoomed = mine.find((p) => p.zoomed);
    if (zoomed || mine.length === 1) {
      const p = zoomed ?? mine[0];
      return others.includes(p) ? [{ pane: p.pane, rect: area, title: p.title, focused: true }] : [];
    }
    const rects = this.tree && tab === this.tab ? paneRects(this.tree, area, gap) : null;
    if (rects && mine.every((p) => rects.has(p.pane))) return others.map((p) => ({ pane: p.pane, rect: rects.get(p.pane), title: p.title, focused: p.focused }));
    // Splits unknown: the focused pane stands for the whole tab.
    const p = others.find((x) => x.focused) ?? others[0];
    return [{ pane: p.pane, rect: area, title: p.title, focused: true }];
  }

  plan() {
    const who = this.moving?.who ?? this.who();
    const at = this.size ? tabArea(layout(), this.size) : null;
    const area = at?.rect ?? null;
    const gap = at?.gap ?? 8;
    const targets = !who.why && area ? this.targets(area, gap, who.own) : [];
    const bar = targets.length ? snapBar(area) : null;
    const barTarget = targets.find((x) => x.focused) ?? targets[0] ?? null;
    const zone = this.moving?.zone ?? (targets.length ? zoneAt(this.pt, area, targets, gap, bar, barTarget) : null);
    const beside = targets.find((x) => x.pane === zone?.pane)?.title ?? "it";
    return { who, area, gap, targets, bar, zone, words: zone && area ? zoneWords(zone, area, targets.length === 1, beside) : "" };
  }

  move(e, cx) {
    this.seen = Date.now();
    const lp = e?.local_position;
    if (!lp || this.moving) return;
    if (this.moves++ === 0) trace(`first pointer event +${Date.now() - this.opened}ms after open`);
    if (e.bounds?.width && this.size?.width) this.k = e.bounds.width / this.size.width || 1;
    const pt = { x: lp.x / this.k, y: lp.y / this.k };
    if (Math.abs(pt.x - this.pt.x) < 1 && Math.abs(pt.y - this.pt.y) < 1) return;
    this.pt = pt;
    cx.notify();
  }

  drop(cx, how) {
    if (this.moving || this.done || this.ending) return;
    const { who, zone, area } = this.plan();
    const at = `(${Math.round(this.pt.x)},${Math.round(this.pt.y)})`;
    if (!zone) {
      const where = !area ? "no tab area yet" : insideRect(this.pt, area) ? "on its own pane or not a target" : "outside the tab";
      trace(`cancel: ${how} at ${at}, ${who.why ?? where}`);
      return this.dismiss(cx);
    }
    trace(`drop: ${how} at ${at} -> ${zone.cell ? "bar " : ""}${zone.side} of ${zone.pane}`);
    this.start(who, zone, cx);
  }

  start(who, zone, cx) {
    this.moving = { zone, who };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.perform(who, zone, cx);
      } catch (err) {
        trace(`error: ${err?.message ?? err}`);
        notify({ title: "Smart split", body: String(err?.message ?? err), level: "error" });
      }
      this.dismiss(cx);
    });
  }

  // From the menu: beside the focused pane of the shown tab (another one if
  // that is the agent itself), or a new tab.
  placeNow(side, cx) {
    const who = this.who();
    const mine = panes().filter((p) => p.tab === focused()?.tab);
    const others = mine.filter((p) => p.pane !== who.own?.pane);
    const target = others.find((p) => p.focused) ?? others[0];
    const fail = (why) => {
      trace(`place refused: ${why}`);
      notify({ title: `Can't move ${who.name} here`, body: why, level: "info", timeout: 4000 });
      this.dismiss(cx);
    };
    if (who.why) return fail(who.why);
    if (!target && side !== "tab") return fail("It's already the only pane of this tab.");
    if (!target && who.own) return fail("It's already this tab.");
    const dummy = { x: 0, y: 0, w: 2, h: 2 };
    this.start(who, zoneFor(side, { pane: target?.pane ?? null, rect: dummy }, dummy, 0), cx);
  }

  // park -> keep beside the target -> swap. Each step waits for the last to
  // land: keep refuses a terminal whose pane change is still in progress.
  async perform(who, z, cx) {
    const addr = who.addr;
    const t0 = Date.now();
    const term = () => terminals().find((t) => t.address === addr);
    const shown = () => panes().some((p) => p.terminal === addr);
    const until = async (test, ms) => {
      for (let n = 0; n < ms; n += 50) {
        if (test()) return true;
        await cx.sleep(50);
      }
      return test();
    };
    // 1. Out of where it is (a sub-agent without a pane is out already). Park
    //    drops its herdr.space/tab labels and core keep; an emptied tab closes.
    this.inFlight = { addr, parked: false, keepSent: false };
    if (shown()) {
      run("terminal.park", { terminal: addr });
      this.inFlight.parked = true;
      const parked = await until(() => !shown() && !term()?.labels?.["herdr.tab"] && term()?.keep === false, 3000);
      trace(`park ${addr}: ${parked ? "done" : "not confirmed"} +${Date.now() - t0}ms`);
      await cx.sleep(150);
    }
    // 2. Into the shown tab: keep puts it right of / below the focused pane.
    const place = () => {
      if (z.place !== "tab" && z.pane) run("pane.focus", { pane: z.pane });
      run("terminal.keep", { terminal: addr, place: z.place });
      this.inFlight.keepSent = true;
    };
    place();
    let ok = await until(shown, 2500);
    if (!ok && term()?.state === "live" && !term()?.labels?.["herdr.tab"]) {
      trace(`keep ${addr}: no pane yet, retrying`);
      place();
      ok = await until(shown, 2500);
    }
    if (!ok) {
      trace(`keep ${addr}: failed`);
      notify({
        title: `Couldn't place ${who.name}`,
        body: "It's still running. Click to bring it back as a tab here.",
        level: "warning",
        action: { name: "terminal.keep", args: { terminal: addr, place: "tab" } },
      });
      return;
    }
    // 3. Left and top: trade places with the pane it went beside.
    run("pane.focus", { terminal: addr });
    if (z.swap) run("pane.swap", { direction: z.swap });
    trace(`placed ${addr} ${z.side}${z.swap ? ` (keep ${z.place} + swap ${z.swap})` : ` (keep ${z.place})`} +${Date.now() - t0}ms`);
  }

  // Gives the keyboard back to the focused pane (the moved agent after a move),
  // which a drag took for Esc, then goes once the trace has landed (300 ms at most:
  // going cancels this copy's tasks, a pending write with them).
  dismiss(cx) {
    if (this.done || this.ending) return;
    this.ending = true;
    const go = () => {
      if (this.done) return;
      this.done = true;
      const f = focused();
      if (f?.pane) run("pane.focus", { pane: f.pane });
      else if (f?.terminal) run("pane.focus", { terminal: f.terminal });
      const id = this.input().overlay;
      if (id) closeOverlay(id);
    };
    if (!cx?.spawn) return go();
    cx.spawn(async (cx) => {
      await Promise.race([tracesWritten(), cx.sleep(300)]);
      go();
    });
  }

  // gpui-kit's last call when this overlay goes for any reason (closed, a reload of
  // this mod, a layout switch, quitting). A move cut off after its park but before
  // its keep would leave the agent running in no tab: bring it back as a tab here.
  async close(cx) {
    const m = this.inFlight;
    if (m?.parked && !m.keepSent && !panes().some((p) => p.terminal === m.addr)) {
      run("terminal.keep", { terminal: m.addr, place: "tab" });
    }
  }

  renderPlace() {
    const t = theme();
    const who = this.moving?.who ?? this.who();
    const side = this.input().place;
    const small = icon(who.program, 14, t.foreground);
    return h_flex()
      .id("snap-place")
      .w_full()
      .h_full()
      .px(14)
      .gap(8)
      .items_center()
      .rounded(10)
      .bg(t.popover)
      .border_1()
      .border_color(t.accent)
      .shadow_lg()
      .text_size(12.5)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.accent).spin(900))
      .when(Boolean(small), (el) => el.child(small))
      .child(div().flex_shrink(1).min_w(40).truncate().font_medium().text_color(t.foreground).child(who.name))
      .child(div().flex_none().text_color(t.muted).child(`→ ${SIDE_WORDS[side] ?? side}`));
  }

  render() {
    if (this.mode === "place") return this.renderPlace();
    const t = theme();
    const { who, area, targets, bar, zone, words } = this.plan();
    const moving = Boolean(this.moving);
    const pt = this.pt;
    const W = this.size?.width ?? 0, H = this.size?.height ?? 0;
    const caption = Boolean(zone) && zone.rect.w > 150 && zone.rect.h > 90; // the zone names itself
    const onOwn = who.own && targets.length > 0 && area && !zone && insideRect(pt, area);
    const status = who.why
      ? `can't move here: ${who.why}`
      : moving
        ? "Moving…"
        : zone
          ? words
          : who.own && !targets.length
            ? "already here"
            : onOwn
              ? "that's where it is"
              : "drop it on a terminal or the bar · Esc cancels";
    const rectOf = (el, r) => el.absolute().left(r.x).top(r.y).w(Math.max(0, r.w)).h(Math.max(0, r.h));
    const small = icon(who.program, 14, t.foreground);
    const big = caption ? icon(who.program, 26, t.accent) : null;

    const label = h_flex()
      .id("snap-label")
      .absolute()
      .when(pt.x + 380 > W, (el) => el.right(Math.max(4, W - pt.x + 12)))
      .when(pt.x + 380 <= W, (el) => el.left(pt.x + 16))
      .when(pt.y + 50 > H, (el) => el.bottom(Math.max(4, H - pt.y + 12)))
      .when(pt.y + 50 <= H, (el) => el.top(pt.y + 18))
      .max_w(380)
      .px(10)
      .py(6)
      .gap(7)
      .items_center()
      .rounded(8)
      .bg(t.popover)
      .border_1()
      .border_color(zone ? t.accent : t.border)
      .shadow_md()
      .text_size(12.5)
      .when(Boolean(small), (el) => el.child(small))
      .child(div().flex_shrink(1).min_w(56).truncate().font_medium().text_color(t.foreground).child(who.name))
      .when(moving, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.accent).spin(900)))
      .when(!caption || moving, (el) => el.child(div().flex_none().text_color(who.why ? t.blocked : zone ? t.accent : t.muted).child(status)));

    // The snap bar: three mini layouts; the cell under the pointer fills. Its rects
    // are in window px; its children are placed from the bar's own corner.
    const rel = (r) => ({ x: r.x - bar.bar.x, y: r.y - bar.bar.y, w: r.w, h: r.h });
    const snap = bar && !moving
      ? rectOf(div().id("snap-bar"), bar.bar)
          .rounded(12)
          .bg(t.popover)
          .border_1()
          .border_color(zone?.cell ? t.accent : t.border)
          .shadow_lg()
          .children(bar.tiles.map((r, i) => rectOf(div().id(`snap-tile-${i}`), rel(r)).rounded(6).bg(t.background)))
          .children(bar.cells.map((c) => rectOf(div().id(`snap-cell-${c.side}`), rel(c.rect))
            .rounded(5)
            .bg(zone?.cell === c.side ? t.accent : alpha(t.muted, 0.28))
            .when(c.side === "tab", (el) => el.flex().items_center().justify_center()
              .text_size(18).text_color(zone?.cell === "tab" ? (t.accent_foreground ?? t.background) : t.foreground).child("+"))))
      : null;

    return div()
      .id("snap-root")
      .size_full()
      .relative()
      .track_focus(this.h)
      .when(Boolean(zone), (el) => el.cursor_grabbing())
      .when(!zone, (el) => el.cursor_no_drop())
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        cx.stop_propagation();
        if (!this.moving) { trace("cancel: Esc"); this.dismiss(cx); }
      })
      .on_mouse_move((e, cx) => this.move(e, cx))
      // A window overlay is dragged by presses it doesn't stop. A press here means
      // the release that began this went unseen: a zone takes it, elsewhere cancels.
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.move(e, cx);
        this.drop(cx, "press");
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        if (!this.moving) { trace("cancel: right-click"); this.dismiss(cx); }
      })
      .on_mouse_up("left", (e, cx) => {
        cx.stop_propagation();
        this.move(e, cx);
        this.drop(cx, "release");
      })
      // The shown tab, faintly, so it's clear where a drop counts.
      .when(Boolean(area) && targets.length > 0, (el) =>
        el.child(rectOf(div(), area).rounded(10).border_1().border_color(alpha(t.accent, 0.6)).bg(alpha(t.accent, 0.06))))
      // Each pane it can land beside, when there are several.
      .when(targets.length > 1, (el) =>
        el.children(targets.map((x) => rectOf(div(), x.rect).rounded(10).border_1().border_dashed().border_color(alpha(t.accent, 0.3)))))
      // Where it lands: what's there now dimmed, tinted, outlined (dashed for a new tab).
      .when(Boolean(zone), (el) =>
        el.child(
          rectOf(div().id("snap-zone"), zone.rect)
            .transition("left", 110)
            .transition("top", 110)
            .transition("width", 110)
            .transition("height", 110)
            .rounded(10)
            .bg(alpha(t.background, 0.72))
            .child(
              v_flex()
                .size_full()
                .rounded(10)
                .bg(alpha(t.accent, 0.16))
                .border_2()
                .when(zone.side === "tab", (el) => el.border_dashed())
                .border_color(t.accent)
                .items_center()
                .justify_center()
                .when(caption, (el) =>
                  el.child(
                    v_flex()
                      .max_w(Math.max(80, zone.rect.w - 40))
                      .px(16)
                      .py(10)
                      .gap(5)
                      .items_center()
                      .rounded(10)
                      .bg(t.popover)
                      .border_1()
                      .border_color(t.border)
                      .shadow_md()
                      .when(Boolean(big), (el) => el.child(big))
                      .child(div().max_w(Math.max(60, zone.rect.w - 72)).truncate().text_size(14).font_medium().text_color(t.foreground).child(who.name))
                      .child(div().text_size(12).text_color(t.accent).child(moving ? "Moving…" : words)))),
            ),
        ))
      .when(Boolean(snap), (el) => el.child(snap))
      .when(pt.x >= 0 && pt.y >= 0 && W > 0, (el) => el.child(label));
  }
}
