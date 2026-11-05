// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it; ✕ only dismisses.
// Drawn like Fedra: a tile in the level's color (the program's icon when it has one),
// the title, and the body below it.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme } from "atrous";

const I = (name) => `mods/toast/${name}.svg`;
// The theme color and glyph of each level: needs you (red), working (amber), done, info.
const LEVEL = {
  error: ["blocked", "alert"],
  warning: ["working", "alert"],
  success: ["done", "check"],
  info: ["accent", "info"],
};

export default class Toast extends View {
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const [colorName, glyph] = LEVEL[p.level] ?? LEVEL.info;
    const color = t[colorName] ?? t.accent;
    const tile = p.icon
      ? h_flex().size(30).flex_none().items_center().justify_center().rounded(8).bg(t.raised).border_1().border_color(t.border)
        .child(image(p.icon).w(18).h(18))
      : h_flex().size(30).flex_none().items_center().justify_center().rounded(8).bg(color + "26")
        .child(svg(I(glyph)).size(16).text_color(color));
    return h_flex()
      .id("toast")
      .size_full()
      .pl(14)
      .pr(10)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(tile)
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(p.title ?? ""))
          .when(Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? ""))),
      )
      .child(
        div()
          .id("toast-close")
          .size(22)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(6)
          .text_color(t.dim)
          .hover((s) => s.bg(t.raised).text_color(t.foreground))
          .tooltip("Dismiss")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            closeOverlay(p.overlay);
          })
          .child(svg(I("x")).size(12)),
      );
  }
}
