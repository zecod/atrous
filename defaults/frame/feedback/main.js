import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { theme, props, closeOverlay, feedbackPreview, sendFeedback } from "atrous";

// Feedback is a GitHub issue on zecod/atrous: the form shows it exactly as it
// will open, and "Open on GitHub" opens it in the browser, where the person
// adds screenshots and posts it. The app sends nothing itself.
export default class Feedback extends View {
  init(_props, cx) {
    this.message = TextareaState.new({ value: props()?.message ?? "", placeholder: "What happened? What did you expect?", rows: 4 });
    this.message.on("change", (_e, cx) => { this.error = null; cx.notify(); });
    this.opening = false;
    this.opened = false;
    this.error = null;
    this.handle = cx.focus_handle();
    this.message.focus();
  }

  close() { closeOverlay(props()?.overlay); }

  button(t, id, label, action, primary = false, disabled = false) {
    return div().id(id).px(14).py(7).rounded(7).border_1().border_color(t.border)
      .bg(primary && !disabled ? t.accent : t.raised)
      .text_color(primary && !disabled ? t.accent_foreground : t.muted)
      .cursor_pointer().on_click((e, cx) => { if (!disabled) action(e, cx); }).child(label);
  }

  open(body, cx) {
    if (this.opening) return;
    this.opening = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try { this.error = await sendFeedback(body, []); this.opened = !this.error; }
      catch (e) { this.error = String(e.message ?? e); }
      this.opening = false;
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    const preview = feedbackPreview(this.message.value(), "", 0);
    const body = preview.body;
    const disabled = this.opening || !this.message.value().trim();
    const label = (text) => div().text_size(13).text_color(t.muted).child(text);
    const field = (el) => el.w_full().p(10).rounded(7).border_1().border_color(t.border).bg(t.background).text_color(t.foreground).text_size(14);
    const text = (s) => (s ?? "").split("\n").map((line) => div().text_size(12).line_height("17px").text_color(t.dim).child(line || " "));
    return v_flex().id("feedback").track_focus(this.handle).w_full().min_h(0).h(600).bg(t.popover)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      // The title drags the window; everything below keeps its presses (selecting text).
      .child(div().flex_none().px(24).py(18).cursor_grab().text_size(19).font_semibold().text_color(t.foreground).child("Send feedback"))
      .child(v_flex().id("feedback-body").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).flex_1().flex_shrink(1).min_h(0).overflow_y_scrollbar().px(24).gap(10)
        .when(props()?.from === "agent", (el) => el.child(div().p(10).rounded(7).bg(t.raised).text_color(t.accent).text_size(14).child("Drafted by an agent: read it before opening")))
        .when(this.opened, (el) => el.child(div().py(20).text_size(16).text_color(t.foreground).child("Opened in your browser. Add screenshots there if you like, then post it. Thanks for helping improve Atrous.")))
        .when(!this.opened, (el) => el
          .child(label("Your message. The first line is the issue's title."))
          .child(field(Textarea.new(this.message)).h(150))
          .child(label("What opens: a new issue on github.com/zecod/atrous with exactly this text. You post it yourself, signed in to GitHub; add screenshots there. Atrous sends nothing."))
          .child(v_flex().w_full().p(10).rounded(7).border_1().border_color(t.border).bg(t.background)
            .child(div().text_size(13).font_semibold().text_color(t.foreground).pb(6).child(body?.title || "(no title yet)"))
            .children(text(body?.body)))))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(24).pt(10).text_size(13).text_color(t.accent).child(this.error)))
      .child(h_flex().flex_none().px(24).py(16).gap(10).justify_end().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(this.button(t, "feedback-cancel", this.opened ? "Done" : "Cancel", () => this.close()))
        .when(!this.opened, (el) => el.child(this.button(t, "feedback-send", this.opening ? "Opening…" : "Open on GitHub", (_e, cx) => this.open(body, cx), true, disabled))));
  }
}
