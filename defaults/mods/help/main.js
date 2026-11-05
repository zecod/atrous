// Help (app.help): what Atrous is, every key it answers to, and where to read more or report a
// problem. Keys come from keys.json through keys(), so a key you rebind shows here at once;
// typing filters them. Esc or ✕ closes.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { keys, props, closeOverlay, theme, window, updates } from "atrous";

const I = (name) => `mods/help/${name}.svg`;
const REPO = "https://github.com/zecod/atrous";

// What each action does, in words (the rest are spelled from their names).
const NAMES = {
  "app.palette": "Command palette",
  "mod.open:picker": "Go to a space or tab",
  "app.settings": "Settings",
  "mod.open:my-settings": "Settings",
  "my-status.toggle": "Quick terminal",
  "app.help": "Keys and help",
  "layout.toggle:sidebar": "Show or hide the sidebar",
  "layout.switch": "Next layout",
  "app.zoom_in": "Zoom in",
  "app.zoom_out": "Zoom out",
  "app.zoom_reset": "Reset zoom",
  "app.quit": "Quit Atrous",
  "app.hide": "Hide Atrous",
  "app.hide_others": "Hide other apps",
  "space.new": "New space",
  "space.rename": "Rename space",
  "space.close": "Close space",
  "space.next": "Next space",
  "space.prev": "Previous space",
  "tab.new": "New tab",
  "tab.rename": "Rename tab",
  "tab.close": "Close tab",
  "tab.next": "Next tab",
  "tab.prev": "Previous tab",
  "pane.split:right": "Split right",
  "pane.split:down": "Split down",
  "pane.close": "Close pane",
  "pane.zoom": "Zoom pane",
  "agent.next": "Next agent",
  "agent.prev": "Previous agent",
  "terminal.copy": "Copy",
  "terminal.paste": "Paste",
  "terminal.paste_image": "Paste an image",
  "terminal.search": "Find in the terminal",
  "send:\u0017": "Delete the word before",
  "send:\u001bb": "Word left",
  "send:\u001bf": "Word right",
  "send:\u0001": "Start of the line",
  "send:\u0005": "End of the line",
  "send:\u0015": "Delete to the start of the line",
};

// General first: the keys that open everything else.
const GROUPS = ["General", "Spaces", "Tabs", "Panes", "Agents", "In a terminal"];
function groupOf(r) {
  if (r.section === "terminal" || /^terminal\.|^send:/.test(r.action)) return "In a terminal";
  return { space: "Spaces", tab: "Tabs", pane: "Panes", agent: "Agents" }[r.action.split(".")[0]] ?? "General";
}

function label(action) {
  if (NAMES[action]) return NAMES[action];
  const [name, arg] = action.split(":");
  if (name === "pane.go") return `Focus the pane ${arg === "up" ? "above" : arg === "down" ? "below" : `to the ${arg}`}`;
  if (name === "pane.swap") return `Swap with the pane ${arg === "up" ? "above" : arg === "down" ? "below" : `to the ${arg}`}`;
  if (action.startsWith("send:")) return "Type " + JSON.stringify(action.slice(5));
  if (name === "mod.open") return `Open ${arg}`;
  const words = name.replace(/[._]/g, " ");
  return (arg ? `${words} ${arg}` : words).replace(/^./, (c) => c.toUpperCase());
}

// "ctrl-shift-p" -> ["Ctrl", "Shift", "P"] (⌃ ⇧ P on macOS), as the status bar writes keys.
const KEY_NAMES = { pageup: "PgUp", pagedown: "PgDn", escape: "Esc", backspace: "Backspace", insert: "Ins", delete: "Del", enter: "Enter", tab: "Tab", space: "Space", left: "←", right: "→", up: "↑", down: "↓" };
function caps(stroke, mac) {
  const parts = stroke.split("-");
  let key = parts.pop();
  if (key === "") { key = "-"; parts.pop(); }
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd", platform: "cmd", control: "ctrl", option: "alt" };
  const held = new Set(parts.map((m) => alias[m.toLowerCase()] ?? m.toLowerCase()));
  const name = KEY_NAMES[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  return [...Object.keys(names).filter((m) => held.has(m)).map((m) => names[m]), name];
}

// One row per action: its keys together, and "Go to space 1–9" for the numbered ones.
function rows(bindings) {
  const out = [], seen = new Map();
  for (const b of bindings) {
    const n = /^(space|tab)\.select:(\d)$/.exec(b.action), k = /^(.*-)(\d)$/.exec(b.keys);
    if (n && k && n[2] === k[2]) {
      const id = `${b.section}|${n[1]}|${k[1]}`;
      if (!seen.has(id)) {
        const row = { section: b.section, action: b.action, kind: n[1], prefix: k[1], nums: [] };
        seen.set(id, row);
        out.push(row);
      }
      seen.get(id).nums.push(Number(n[2]));
      continue;
    }
    const id = `${b.section}|${b.action}`;
    if (!seen.has(id)) {
      const row = { section: b.section, action: b.action, keys: [] };
      seen.set(id, row);
      out.push(row);
    }
    seen.get(id).keys.push(b.keys);
  }
  for (const r of out) {
    if (!r.nums) { r.label = label(r.action); continue; }
    const lo = Math.min(...r.nums), hi = Math.max(...r.nums);
    const span = lo === hi ? String(lo) : `${lo}–${hi}`;
    r.label = `Go to ${r.kind} ${span}`;
    r.keys = [`${r.prefix}${span}`];
  }
  return out;
}

// Where a binding applies, when it isn't everywhere.
function where(section) {
  if (section.startsWith("layout:")) return `${section.slice(7)} layout`;
  if (section.startsWith("mod:")) return `in ${section.slice(4)}`;
  return "";
}

export default class Help extends View {
  init(_props, cx) {
    this.filter = "";
    this.input = InputState.new({ placeholder: "Search keys…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  keyCaps(t, combo, mac) {
    return h_flex().gap(3).flex_none().children(caps(combo, mac).map((p) =>
      div().min_w(20).h(20).px(5).flex().items_center().justify_center().rounded(5).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.muted).child(p)));
  }

  // Fedra's secondary button (h32, rounded 8, raised with an input border), opening a page.
  link(t, id, text, url) {
    return h_flex().id(id).h(32).px(12).gap(7).flex_none().items_center().rounded(8).border_1().border_color(t.input).bg(t.raised)
      .text_size(12.5).font_medium().text_color(t.foreground).cursor_pointer().hover((s) => s.opacity(0.88))
      .tooltip(url)
      .on_click((_e, cx) => cx.open_url(url))
      .child(text)
      .child(svg(I("external")).size(12).flex_none().text_color(t.dim));
  }

  render(cx) {
    const t = theme();
    const mac = window()?.platform === "macos";
    const f = this.filter.trim().toLowerCase();
    const all = rows(keys()).filter((r) => !f || r.label.toLowerCase().includes(f) || r.action.toLowerCase().includes(f)
      || r.keys.some((k) => k.includes(f) || caps(k, mac).join(" ").toLowerCase().includes(f)));
    // In each group: "Go to … 1–9" first, then the order of NAMES above, then the rest as bound.
    const order = Object.keys(NAMES);
    const rank = (r, i) => (r.nums ? -1 : order.includes(r.action) ? order.indexOf(r.action) : 1000 + i);
    const ranked = all.map((r, i) => [rank(r, i), r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    const groups = GROUPS.map((name) => [name, ranked.filter((r) => groupOf(r) === name)]).filter(([, list]) => list.length > 0);
    const version = updates()?.app?.version;
    return v_flex()
      .id("help")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); }
      })
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .child(h_flex().h(52).flex_none().pl(20).pr(12).gap(10).items_center().border_b(1).border_color(t.border)
        .child(image("mods/help/atrous.png").w(24).h(24).flex_none())
        .child(div().text_size(14).font_semibold().child("Atrous"))
        .when(Boolean(version), (el) => el.child(div().text_size(12).text_color(t.dim).child(version)))
        .child(div().flex_1())
        .child(div().id("help-close").size(26).flex_none().rounded(7).flex().items_center().justify_center().text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close (Esc)")
          .on_click(() => this.close()).child(svg(I("x")).size(15))))
      .child(v_flex().flex_none().px(20).pt(14).pb(10).gap(12)
        .child(div().text_size(12.8).line_height("19px").text_color(t.muted)
          .child("Atrous runs your terminals and coding agents side by side. Each one lives in atrous-core (atc), in the background: close or update this window and they keep working."))
        .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
          .child(svg(I("search")).size(14).flex_none().text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))))
      .child(v_flex().id("help-keys").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(12).gap(10)
        .children(groups.map(([name, list]) => v_flex().flex_none()
          .child(div().px(8).pt(4).pb(4).text_size(11).font_semibold().text_color(t.dim).child(name.toUpperCase()))
          .children(list.map((r, i) => h_flex().id(`hk-${name}-${i}`).h(30).flex_none().px(8).gap(10).items_center().rounded(7).hover((s) => s.bg(t.hover))
            .child(div().flex_1().min_w(0).truncate().text_size(12.8).text_color(t.foreground).child(r.label))
            .when(Boolean(where(r.section)), (el) => el.child(div().flex_none().px(5).h(16).flex().items_center().rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.dim).child(where(r.section))))
            .children(r.keys.slice(0, 2).flatMap((k, n) => [
              ...(n > 0 ? [div().flex_none().text_size(11).text_color(t.dim).child("or")] : []),
              this.keyCaps(t, k, mac),
            ]))))))
        .when(groups.length === 0, (el) => el.child(div().px(8).py(10).text_size(12.5).text_color(t.dim).child(`No key does "${this.filter.trim()}". The command palette lists everything Atrous can do.`))))
      .child(h_flex().flex_none().px(16).py(12).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child("Change any of these in keys.json"))
        .child(this.link(t, "help-readme", "Read the guide", `${REPO}#readme`))
        .child(this.link(t, "help-issues", "Report a problem", `${REPO}/issues`)));
  }
}
