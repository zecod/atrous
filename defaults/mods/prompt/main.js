// A text prompt (a rename the app asks for, Duplicate mod in the palette). Enter saves, Esc
// cancels. Props: { title, value?, hint?, command: { name, args } }; the text goes to the
// command as `name`. Drawn like Fedra's dialogs: the question, its field, and a footer with
// the keys and the buttons.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme } from "atrous";

// Fedra's button: h32, rounded 8, solid (primary) or raised with an input border.
function button(t, id, text, primary, action) {
  return h_flex().id(id).h(32).px(14).flex_none().items_center().rounded(8).border_1()
    .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
    .hover((s) => s.opacity(0.88)).on_click(action).child(text);
}

export default class Prompt extends View {
  init(_props, cx) {
    this.text = props()?.value ?? "";
    this.input = InputState.new({ value: this.text });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submit() {
    const p = props();
    closeOverlay(p.overlay);
    run(p.command.name, { ...(p.command.args ?? {}), name: this.text });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    return v_flex().id("prompt").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .child(v_flex().px(18).pt(18).pb(16).gap(6)
        .child(div().pb(8).text_size(15).font_semibold().child((p.title ?? "").replace(/^./, (c) => c.toUpperCase())))
        .child(div().text_size(12).font_medium().text_color(t.muted).child("Name"))
        .child(Input.new(this.input).h(34).px(10).rounded(8).border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground))
        .when(Boolean(p.hint), el => el.child(div().text_size(11.5).text_color(t.dim).child(p.hint))))
      .child(h_flex().flex_none().px(16).py(12).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child("Enter to save · Esc to cancel"))
        .child(button(t, "pm-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button(t, "pm-save", "Save", true, () => this.submit())));
  }
}
