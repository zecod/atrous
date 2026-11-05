// Asks before something destructive, e.g. "Close space?". Opened as a
// dialog with props { title, detail, command: { name, args }, confirm? }.
// Enter confirms (runs the command), Esc cancels. Drawn like Fedra's dialogs: the
// question and what it does, then a footer with the keys and the buttons; a command that
// ends or removes something gets the red button, named for what it does.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme } from "atrous";

// The button for a destructive command, by its verb ("space.close": Close).
const VERBS = { close: "Close", kill: "End", remove: "Remove", reset: "Reset", delete: "Delete" };

export default class Confirm extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  yes() {
    const p = props();
    closeOverlay(p.overlay);
    run(p.command.name, p.command.args ?? {});
  }

  // Fedra's button: h32, rounded 8; primary solid (red when it ends something), else raised.
  button(t, id, label, kind, onClick) {
    const fill = kind === "danger" ? t.blocked : t.solid, ink = kind === "danger" ? t.background : t.solid_foreground;
    const primary = kind !== "secondary";
    return h_flex().id(id).h(32).px(14).flex_none().items_center().rounded(8).border_1()
      .border_color(primary ? fill : t.input).bg(primary ? fill : t.raised).text_color(primary ? ink : t.foreground)
      .text_size(12.5).font_medium().cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick).child(label);
  }

  render(cx) {
    const t = theme();
    const p = props() ?? {};
    const verb = VERBS[String(p.command?.name ?? "").split(".").pop()];
    return v_flex()
      .id("confirm")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.yes();
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_size(13)
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .px(18)
          .pt(16)
          .pb(10)
          .gap(6)
          .child(div().flex_none().text_size(15).font_semibold().text_color(t.foreground).child(p.title ?? "Are you sure?"))
          .child(div().id("confirm-detail").flex_1().min_h(0).overflow_y_scrollbar().text_size(12.8).line_height("18px").text_color(t.muted).child(p.detail ?? "")),
      )
      .child(
        h_flex()
          .flex_none()
          .px(16)
          .py(12)
          .gap(8)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`Enter to ${(verb ?? "confirm").toLowerCase()} · Esc to cancel`))
          .child(this.button(t, "no", "Cancel", "secondary", () => closeOverlay(props().overlay)))
          .child(this.button(t, "yes", p.confirm ?? verb ?? "Confirm", verb ? "danger" : "primary", () => this.yes())),
      );
  }
}
