// The bar on top of a peeked agent (an overlay the agents list opens for a sub-agent, or a
// terminal address link), drawn like Fedra's pane header: who it is, where it works and how
// it's doing; "Go to" its pane (or, without one, "Keep as tab" in the shown space), ✕ to
// close. Props: { terminal, overlay }.

import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, terminals, panes, run, theme, props, closeOverlay, home } from "atrous";

const I = (name) => `mods/peek/${name}.svg`;

// The icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Peek extends View {
  term() {
    return terminals().find((t) => t.address === props()?.terminal);
  }

  status() {
    const addr = props()?.terminal;
    return agents().find((a) => a.address === addr)?.status ?? this.term()?.status ?? null;
  }

  button(t, id, iconName, label, tip, onClick) {
    return h_flex()
      .id(id)
      .h(24)
      .px(label ? 8 : 5)
      .gap(5)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_size(12)
      .text_color(t.muted)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click(onClick)
      .child(svg(I(iconName)).size(14).flex_none())
      .when(Boolean(label), (el) => el.child(label));
  }

  render() {
    const t = theme();
    const { terminal, overlay } = props() ?? {};
    const k = this.term();
    const st = this.status();
    const pic = icon(k?.program, 14, t.dim);
    const parent = k?.parent ? terminals().find((p) => p.address === k.parent) : null;
    const inPane = panes().some((p) => p.terminal === terminal);
    const name = k?.name || k?.template || k?.program?.name || terminal || "";
    return h_flex()
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().max_w(260).truncate().font_medium().text_color(t.foreground).child(name))
      .when(Boolean(parent), (el) => el.child(div().flex_none().max_w(180).truncate().text_color(t.dim).child(`from ${parent.name || parent.address}`)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(folder(k?.cwd)))
      .when(st === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .child(
        this.button(t, "keep", inPane ? "arrow-up-right" : "panel-top", inPane ? "Go to" : "Keep as tab", inPane ? "Go to its pane" : "Keep it as a tab of this space", () => {
          run(inPane ? "pane.focus" : "terminal.keep", { terminal });
          closeOverlay(overlay);
        }),
      )
      .child(this.button(t, "close", "x", null, "Close (it keeps running)", () => closeOverlay(overlay)));
  }
}
