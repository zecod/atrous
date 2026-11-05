// Pick (crosshair), Annotate (comment-plus) and Send, mixed into the Browser view (main.js).
//
// Both modes use Chrome's own inspect mode (the helper's /inspect): hovering highlights an
// element with its tag and size, and a click picks it instead of reaching the page.
// - Pick: a click copies the element's outerHTML; C copies the hovered element's, S saves a PNG
//   of it and copies the file's path.
// - Annotate: a click opens a note popover at the element; notes pile up (numbered markers on
//   the page, a count on the button, a list card) and go to an agent in one message: a new one
//   (tab.new with the message as its first task) or a session already open in this space
//   (hc send: one bracketed paste, then Enter).

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState } from "gpui-base";
import { run, hc, agents, knownAgents, spaces, settings } from "herdr";

const I = (name) => `mods/browser-panel/icons/${name}.svg`;
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const stop = (_e, cx) => cx.stop_propagation();

// The message an agent gets: the pages, then per note its number, intent, element and text.
export function noteMessage(notes) {
  const out = [`Feedback from the browser panel: ${notes.length} note${notes.length === 1 ? "" : "s"} on page elements.`,
    "(The panel is a Chromium browser you can drive yourself: Playwright connectOverCDP(\"http://127.0.0.1:9333\").)", ""];
  let page = null;
  notes.forEach((n, i) => {
    if (n.url !== page) {
      page = n.url;
      out.push(`Page: ${n.url}${n.title ? `  (${oneLine(n.title)})` : ""}`, "");
    }
    out.push(`${i + 1}. [${n.intent === "question" ? "Question" : "Change"}] ${n.selector}${n.snippet ? `  "${clip(oneLine(n.snippet), 70)}"` : ""}`);
    out.push(...n.text.split("\n").map((l) => `   ${l}`));
    out.push(`   Element: ${clip(oneLine(n.html), 320)}`);
    if (n.shot) out.push(`   Screenshot: ${n.shot}`);
    out.push("");
  });
  return `${out.join("\n").trim()}\n`;
}

export const Notes = {
  initNotes() {
    this.notes = []; // { id, targetId, url, title, intent, text, tag, selector, snippet, html, shot, backendNodeId }
    this.draft = null; // the open note popover: { picked, intent, editing }
    this.noteBox = TextareaState.new({ placeholder: "Describe a change, or ask a question…", rows: 3 });
    this.noteBox.set_auto_grow(3, 8);
    this.noteBox.on("submit", (e, cx) => { if (e?.secondary) this.addNote(cx); });
    this.sendMenu = null; // { loading, agents, sessions, space } while the Send menu is open
    this.showNotes = false;
    this.undo = null;
    this.toastMsg = null;
    this.picks = new Map(); // native: page pick id -> the helper's picked element
    this.saves = []; // native: note saves waiting for their pick
    this.cardCollapsed = false;
  },

  inspectMode() {
    return this.st?.inspect ?? "off";
  },

  setMode(mode, cx) {
    const next = this.inspectMode() === mode ? "off" : mode;
    if (next !== "annotate") this.draft = null;
    this.sendMenu = null;
    this.menu = false;
    this.call("/inspect", { mode: next }, cx);
    if (this.st) this.st.inspect = next;
    this.handle.focus();
    cx.notify();
  },

  // From apply(): a new click in inspect mode, a toast, a page or tab change.
  afterApply(prev, cx) {
    const st = this.st;
    if (st.pid !== this.lastPid) { this.lastPid = st.pid; this.lastPick = undefined; this.lastToast = undefined; } // a new helper counts from 0
    if (this.lastPick === undefined) this.lastPick = st.picked?.seq ?? 0;
    else if (st.picked && st.picked.seq !== this.lastPick) {
      this.lastPick = st.picked.seq;
      if (st.picked.mode === "annotate" && st.native) {
        // natively the note editor is in the page: its save names this pick
        this.picks.set(st.picked.uiPick, st.picked);
        if (this.picks.size > 20) this.picks.delete(this.picks.keys().next().value);
        this.flushSaves(cx);
      } else if (st.picked.mode === "annotate") {
        this.draft = { picked: st.picked, intent: "change", editing: null };
        this.noteBox.set_value("");
        this.noteBox.focus();
      }
    }
    // what the person did in the page UI (native view)
    if (this.lastUi === undefined || st.pid !== this.lastUiPid) { this.lastUi = st.uiSeq ?? 0; this.lastUiPid = st.pid; }
    for (const e of st.uiEvents ?? []) if (e.seq > this.lastUi) { this.lastUi = e.seq; this.uiAction(e, cx); }
    if (this.lastToast === undefined) this.lastToast = st.toast?.seq ?? 0;
    else if (st.toast && st.toast.seq !== this.lastToast) { this.lastToast = st.toast.seq; this.toast(st.toast.text, null, cx); }
    if (prev && (prev.targetId !== st.targetId || prev.url !== st.url)) {
      if (this.draft && !this.draft.editing) this.draft = null; // its element was on the page that's gone
      if (this.notes.length) this.syncMarks(cx);
    }
  },

  uiAction(e, cx) {
    if (e.type === "note-save") {
      const intent = e.intent === "question" ? "question" : "change";
      if (e.edit) {
        const note = this.notes.find((x) => x.id === e.edit);
        if (note) { note.text = e.text; note.intent = intent; }
        this.syncMarks(cx);
      } else {
        this.saves.push({ pickId: e.pickId, text: e.text, intent, at: Date.now() });
        this.flushSaves(cx);
      }
    } else if (e.type === "note-cancel") this.picks.delete(e.pickId);
    else if (e.type === "note-delete") this.removeNote(e.id, cx);
    else if (e.type === "send") this.openSend(cx);
    else if (e.type === "copy-all") this.copyAll(cx);
    else if (e.type === "clear") this.clearNotes(cx);
    else if (e.type === "collapse") this.cardCollapsed = Boolean(e.collapsed);
    cx.notify();
  },

  // A save waits for its pick (the element's details and screenshot come a moment after the click).
  flushSaves(cx) {
    let added = false;
    this.saves = this.saves.filter((s) => {
      const p = this.picks.get(s.pickId);
      if (!p) return Date.now() - s.at < 15000;
      this.picks.delete(s.pickId);
      this.notes.push({ id: `${Date.now()}-${this.notes.length}`, targetId: p.targetId, url: p.url, title: p.title, intent: s.intent,
        text: s.text, tag: p.tag, selector: p.selector, snippet: p.text, html: p.html, shot: p.shot, backendNodeId: p.backendNodeId });
      added = true;
      return false;
    });
    if (added) { this.syncMarks(cx); cx.notify(); }
  },

  removeNote(id, cx) {
    const i = this.notes.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [gone] = this.notes.splice(i, 1);
    this.syncMarks(cx);
    this.toast(`Deleted note ${i + 1}`, { label: "Undo", run: (cx) => { this.notes.splice(Math.min(i, this.notes.length), 0, gone); this.syncMarks(cx); cx.notify(); } }, cx, 6000);
  },

  toast(text, action, cx, ms = 2600) {
    const t = { text, action };
    this.toastMsg = t;
    cx.timer.after(ms, (cx) => { if (this.toastMsg === t) { this.toastMsg = null; cx.notify(); } });
    cx.notify();
  },

  addNote(cx) {
    const d = this.draft;
    if (!d) return;
    const text = this.noteBox.value().trim();
    if (!text) return;
    if (d.editing) {
      const n = this.notes.find((x) => x.id === d.editing);
      if (n) { n.text = text; n.intent = d.intent; }
    } else {
      const p = d.picked;
      this.notes.push({ id: `${Date.now()}-${this.notes.length}`, targetId: p.targetId, url: p.url, title: p.title, intent: d.intent,
        text, tag: p.tag, selector: p.selector, snippet: p.text, html: p.html, shot: p.shot, backendNodeId: p.backendNodeId });
    }
    this.draft = null;
    this.handle.focus();
    this.syncMarks(cx);
    cx.notify();
  },

  editNote(id, cx) {
    const n = this.notes.find((x) => x.id === id);
    if (!n) return;
    this.draft = { picked: { text: n.snippet, tag: n.tag, selector: n.selector }, intent: n.intent, editing: id };
    this.noteBox.set_value(n.text);
    this.noteBox.focus();
    cx.notify();
  },

  deleteNote(id, cx) {
    this.notes = this.notes.filter((x) => x.id !== id);
    if (this.draft?.editing === id) this.draft = null;
    this.syncMarks(cx);
    cx.notify();
  },

  clearNotes(cx, label = "Cleared") {
    if (!this.notes.length) return;
    const kept = this.notes;
    this.notes = [];
    this.draft = null;
    this.sendMenu = null;
    this.syncMarks(cx);
    this.toast(`${label} ${kept.length} note${kept.length === 1 ? "" : "s"}`, { label: "Undo", run: (cx) => { this.notes = kept; this.syncMarks(cx); cx.notify(); } }, cx, 9000);
  },

  // Numbered markers for the notes on the shown page (natively also the card's list).
  syncMarks(cx) {
    const st = this.st;
    if (!st) return;
    const marks = [];
    this.notes.forEach((n, i) => { if (n.targetId === st.targetId && n.url === st.url && n.backendNodeId) marks.push({ n: i + 1, id: n.id, backendNodeId: n.backendNodeId }); });
    const host = (u) => { try { return new URL(u).host; } catch { return ""; } };
    const notes = this.notes.map((n, i) => ({ n: i + 1, id: n.id, tag: n.tag, label: clip(oneLine(n.snippet) || n.selector || "", 70), text: n.text,
      intent: n.intent, here: n.targetId === st.targetId && n.url === st.url, host: host(n.url) }));
    this.call("/marks", { marks, notes, collapsed: Boolean(this.cardCollapsed) }, cx);
  },

  copyAll(cx) {
    if (!this.notes.length) return;
    this.call("/clipboard", { text: noteMessage(this.notes) }, cx);
    this.toast(`Copied ${this.notes.length} note${this.notes.length === 1 ? "" : "s"} as one message`, null, cx);
  },

  openSend(cx) {
    if (!this.notes.length) return;
    if (this.sendMenu) { this.sendMenu = null; cx.notify(); return; }
    const space = spaces().find((s) => s.active);
    this.sendMenu = { loading: true, agents: [], sessions: [], space };
    cx.notify();
    cx.spawn(async (cx) => {
      let installed = [];
      try { installed = (await knownAgents({ on: space?.machine ?? null })).filter((a) => a.installed); } catch {}
      if (!this.sendMenu) return;
      this.sendMenu = { loading: false, agents: installed, sessions: agents().filter((a) => a.space === space?.id), space };
      cx.notify();
    });
  },

  sendToNew(agent, cx) {
    const space = this.sendMenu?.space ?? spaces().find((s) => s.active);
    const msg = noteMessage(this.notes);
    run("tab.new", { space: space?.id, argv: agent.run, task: msg });
    this.clearNotes(cx, `Sent to a new ${agent.name}:`);
  },

  sendToSession(a, cx) {
    const msg = noteMessage(this.notes);
    const notes = this.notes;
    this.clearNotes(cx, `Sending to ${clip(a.title || a.program?.name || a.address, 30)}:`);
    cx.spawn(async (cx) => {
      // One bracketed paste, then Enter: the agent gets the whole message as one turn.
      const r = await hc(["send", a.address, msg]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) {
        this.notes = notes;
        this.syncMarks(cx);
        this.toast(`Couldn't send: ${clip((r.stderr || r.stdout || "").trim(), 120)}`, null, cx, 6000);
      }
    });
  },

  // ---- drawing ----

  modeButton(id, icon, tip, mode, t, badge) {
    const on = this.inspectMode() === mode;
    return h_flex().id(id).h(26).min_w(26).px(5).gap(3).flex_none().items_center().justify_center().rounded(7)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .when(!this.connected, (el) => el.opacity(0.4))
      .when(this.connected, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop).on_click((_e, cx) => this.setMode(mode, cx)))
      .tooltip(tip)
      .child(svg(I(icon)).size(15))
      .when(Boolean(badge), (el) => el.child(div().h(15).min_w(15).px(4).rounded(8).bg(t.accent).text_color(t.accent_foreground)
        .text_size(10).font_semibold().flex().items_center().justify_center().child(String(badge))));
  },

  // The hovered (white) or selected (accent) element, outlined natively over the frame from its
  // box in CSS px: 2 px with a dark 1 px halo so it reads on light and dark pages alike, and a
  // label chip (tag "text…" W×H) above it, or below it near the top edge.
  outline(t, fit, r, label, selected) {
    const a = this.area ?? { width: 400, height: 400 };
    const x = r.x * fit.s, y = r.y * fit.s, w = Math.max(2, r.w * fit.s), h = Math.max(2, r.h * fit.s);
    const box = div().absolute().left(x - 3).top(y - 3).w(w + 6).h(h + 6).rounded(4).border_1().border_color("#000000b0")
      .child(div().size_full().rounded(3).border(2).border_color(selected ? t.accent : "#ffffff"));
    if (!label) return box;
    const chip = `${clip(label, 70)}  ${Math.round(r.w)}×${Math.round(r.h)}`;
    const above = y - 26 >= 2, below = y + h + 26 <= a.height;
    const cy = above ? y - 26 : below ? y + h + 5 : Math.max(2, y + 4);
    const cx = Math.max(4, Math.min(x - 3, a.width - 120));
    const mono = settings()?.font_family || "JetBrains Mono";
    return div().absolute().inset_0()
      .child(box)
      .child(div().absolute().left(cx).top(cy).max_w(Math.max(100, a.width - cx - 6)).h(21).px(7).rounded(5)
        .bg("#111418ee").border_1().border_color("#ffffff40").text_color("#ffffff").text_size(11).font_family(mono)
        .flex().items_center().truncate().child(chip));
  },

  hintBar(t) {
    const mode = this.inspectMode();
    const small = (id, label, icon, action, primary) => h_flex().id(id).h(24).px(8).gap(5).flex_none().items_center().rounded(6)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(11.5).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_mouse_down("left", stop).on_click(action)
      .when(Boolean(icon), (el) => el.child(svg(I(icon)).size(12))).when(Boolean(label), (el) => el.child(label));
    const n = this.notes.length;
    const text = mode === "pick"
      ? "Click or hover an element, then press C to copy or S to screenshot."
      : n ? `${n} annotation${n === 1 ? "" : "s"} ready. Select another element or send the feedback.` : "Click an element to add feedback for it.";
    return h_flex().id("bp-hint").h(34).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(12)
      .child(svg(I(mode === "pick" ? "crosshair" : "comment-plus")).size(13).flex_none().text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(text))
      .when(mode === "annotate" && n > 0, (el) => el
        .child(small("bp-hint-send", "Send", "send", (_e, cx) => this.openSend(cx), true))
        .child(small("bp-hint-copy", "Copy all", "copy", (_e, cx) => this.copyAll(cx)))
        .child(small("bp-hint-list", this.showNotes ? "Hide list" : "List", null, (_e, cx) => { this.showNotes = !this.showNotes; cx.notify(); }))
        .child(small("bp-hint-clear", null, "trash", (_e, cx) => this.clearNotes(cx))))
      .child(small("bp-hint-cancel", "Cancel", null, (_e, cx) => this.setMode(mode, cx)));
  },

  // The note popover, anchored under (or over) the element, inside the page area.
  notePopover(t, fit) {
    const d = this.draft, p = d.picked, a = this.area ?? { width: 400, height: 400 };
    // Sized to the page area (panels run 280-900 px), kept inside it: under the element when
    // there's room, else over it, else clamped. H is the popover's height with a 3-row note.
    const W = Math.max(200, Math.min(340, a.width - 16)), H = 262;
    let left = Math.max(8, (a.width - W) / 2), top = Math.max(8, (a.height - H) / 2);
    if (p.rect && fit) {
      const x = p.rect.x * fit.s, y = p.rect.y * fit.s, h = p.rect.h * fit.s;
      left = Math.max(8, Math.min(a.width - W - 8, x));
      top = y + h + 10 + H <= a.height - 8 ? y + h + 10 : y - H - 10 >= 8 ? y - H - 10 : Math.max(8, Math.min(a.height - H - 8, y + 10));
    }
    const seg = (id, label, icon, value) => h_flex().id(id).flex_1().h(26).px(8).gap(6).items_center().justify_center().rounded(6).text_size(12)
      .bg(d.intent === value ? t.selected : t.popover).text_color(d.intent === value ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { d.intent = value; cx.notify(); })
      .child(svg(I(icon)).size(12).flex_none()).child(label);
    const mono = settings()?.font_family || "JetBrains Mono";
    return v_flex().id("bp-note-pop").absolute().left(left).top(top).w(W).p(12).gap(9).rounded(10).border_1()
      .border_color(t.border).bg(t.popover).shadow_lg().text_size(12.5).text_color(t.foreground)
      .on_mouse_down("left", stop).on_mouse_up("left", stop).on_mouse_move(stop).on_scroll_wheel(stop)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); this.draft = null; this.handle.focus(); cx.notify(); }
        else if (e.key === "enter" && (e.modifiers?.control || e.modifiers?.platform)) { cx.stop_propagation(); this.addNote(cx); }
      })
      .child(div().w_full().min_w(0).font_semibold().truncate().child(clip(oneLine(p.text) || `<${p.tag}>`, 120)))
      .child(div().w_full().min_w(0).text_size(11).text_color(t.dim).font_family(mono).truncate().child(p.selector || p.tag || ""))
      .child(Textarea.new(this.noteBox).w_full().px(8).py(6).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5))
      // Intent on its own row, buttons on the next: nothing has to share a row with them.
      .child(h_flex().w_full().p(2).gap(2).rounded(8).border_1().border_color(t.border)
        .child(seg("bp-intent-change", "Change", "pencil", "change"))
        .child(seg("bp-intent-question", "Question", "question", "question")))
      .child(h_flex().w_full().gap(6).items_center().justify_end()
        .child(h_flex().id("bp-note-cancel").h(28).px(12).flex_none().items_center().rounded(7).border_1().border_color(t.input).text_size(12)
          .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.draft = null; this.handle.focus(); cx.notify(); }).child("Cancel"))
        .child(h_flex().id("bp-note-add").h(28).px(12).gap(7).flex_none().items_center().rounded(7).bg(t.solid).text_color(t.solid_foreground)
          .text_size(12).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.addNote(cx))
          .child(d.editing ? "Save" : "Add").child(div().text_size(10.5).opacity(0.65).child("Ctrl↵"))));
  },

  // The floating list of notes (bottom right of the page area).
  notesCard(t) {
    const a = this.area ?? { width: 400, height: 400 };
    const W = Math.min(330, a.width - 16);
    const row = (n, i) => h_flex().id(`bp-note-${n.id}`).px(8).py(6).gap(8).items_start().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.editNote(n.id, cx))
      .child(div().size(18).flex_none().rounded(9).bg("#2f6feb").text_color("#ffffff").text_size(10.5).font_semibold()
        .flex().items_center().justify_center().child(String(i + 1)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(11).text_color(t.dim).child(`${n.intent === "question" ? "Question" : "Change"} · ${clip(oneLine(n.snippet) || `<${n.tag}>`, 50)}`))
        .child(div().text_size(12).text_color(t.foreground).child(clip(n.text, 160))))
      .child(div().id(`bp-note-del-${n.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
        .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Delete this note")
        .on_click((_e, cx) => { cx.stop_propagation(); this.deleteNote(n.id, cx); }).child(svg(I("trash")).size(12)));
    const button = (id, label, icon, action, primary) => h_flex().id(id).h(26).px(9).gap(5).items_center().rounded(7)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(11.5).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action).child(svg(I(icon)).size(12)).when(Boolean(label), (el) => el.child(label));
    // Absolute box outside, scroll area inside (overflow_y_scrollbar wraps its element).
    return div().id("bp-notes-box").absolute().right(8).bottom(8).w(W).rounded(10).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().overflow_hidden()
      .on_mouse_down("left", stop).on_mouse_up("left", stop).on_mouse_move(stop).on_scroll_wheel(stop)
      .child(v_flex()
        .child(h_flex().h(34).px(10).gap(6).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().font_semibold().text_size(12.5).child(`${this.notes.length} annotation${this.notes.length === 1 ? "" : "s"}`))
          .child(button("bp-card-send", "Send", "send", (_e, cx) => this.openSend(cx), true))
          .child(button("bp-card-copy", null, "copy", (_e, cx) => this.copyAll(cx)))
          .child(button("bp-card-clear", null, "trash", (_e, cx) => this.clearNotes(cx))))
        .child(v_flex().id("bp-notes-list").max_h(Math.max(80, Math.min(260, a.height - 70))).overflow_y_scrollbar().p(4)
          .children(this.notes.map(row))));
  },

  sendMenuView(t) {
    const m = this.sendMenu, a = this.area ?? { width: 400, height: 400 };
    const icon = (p) => (p?.icon ? (p.tint ? svg(p.icon).size(15).text_color(t.muted) : image(p.icon).size(15)) : svg(I("bot")).size(15).text_color(t.muted));
    const item = (id, el, label, sub, action) => h_flex().id(id).h(30).px(9).gap(9).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(action)
      .child(div().w(16).flex_none().flex().justify_center().child(el))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(sub), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(sub)));
    const head = (text) => div().px(9).pt(8).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child(text);
    const rows = [div().px(9).pt(8).pb(2).font_semibold().child(`Send ${this.notes.length} note${this.notes.length === 1 ? "" : "s"} to`)];
    if (m.loading) rows.push(h_flex().px(9).py(8).gap(8).items_center().text_color(t.muted).child(svg(I("spinner")).size(13).spin(900)).child("Looking for agents…"));
    else {
      rows.push(head("NEW AGENT"));
      if (!m.agents.length) rows.push(div().px(9).py(4).text_color(t.dim).child("No agents installed"));
      m.agents.forEach((ag, i) => rows.push(item(`bp-send-new-${i}`, icon(ag), ag.name, null, (_e, cx) => { this.sendMenu = null; this.sendToNew(ag, cx); })));
      rows.push(head(`SESSIONS IN ${clip(m.space?.name ?? "THIS SPACE", 28).toUpperCase()}`));
      if (!m.sessions.length) rows.push(div().px(9).py(4).text_color(t.dim).child("No agents running here"));
      m.sessions.forEach((s, i) => rows.push(item(`bp-send-old-${i}`, icon(s.program), clip(s.title || s.program?.name || s.address, 44),
        `${s.status}${s.tab_name ? ` · ${clip(s.tab_name, 14)}` : ""}`, (_e, cx) => { this.sendMenu = null; this.sendToSession(s, cx); })));
      rows.push(div().h(1).my(4).bg(t.border));
      rows.push(item("bp-send-copy", svg(I("copy")).size(14).text_color(t.muted), "Copy message", null, (_e, cx) => { this.sendMenu = null; this.copyAll(cx); }));
    }
    const W = Math.min(300, a.width - 16);
    return div().id("bp-send-box").absolute().top(8).right(8).w(W).rounded(10).border_1().border_color(t.border)
      .bg(t.popover).shadow_lg().overflow_hidden().text_size(12.5)
      .on_mouse_down("left", stop).on_mouse_up("left", stop).on_mouse_move(stop).on_scroll_wheel(stop)
      .child(v_flex().id("bp-send-list").max_h(Math.max(120, a.height - 16)).overflow_y_scrollbar().p(4).children(rows));
  },

  toastView(t) {
    const m = this.toastMsg;
    return h_flex().id("bp-toast").absolute().bottom(12).left(12).max_w(Math.max(200, (this.area?.width ?? 400) - 24)).px(12).py(7).gap(10)
      .items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12).shadow_lg()
      .on_mouse_down("left", stop)
      .child(div().min_w(0).child(m.text))
      .when(Boolean(m.action), (el) => el.child(div().id("bp-toast-act").flex_none().font_semibold().cursor_pointer().underline()
        .on_click((_e, cx) => { const a = m.action; this.toastMsg = null; a.run(cx); }).child(m.action.label)));
  },
};
