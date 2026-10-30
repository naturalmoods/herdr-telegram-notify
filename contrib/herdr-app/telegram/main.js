// The Telegram state the daemon labels core terminals with, in one band at the
// bottom of the app window: a click jumps to the agent it belongs to.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { terminals, theme, run } from "herdr";
import { telegramEntries } from "./entries.js";

export default class TelegramBand extends View {
  init(_props, cx) {
    // Labels expire by their own timestamp, so the render below drops them; a
    // tick is only what asks for that render.
    cx.timer.every(30000, (cx) => cx.notify());
  }

  entry(t, e) {
    const el = h_flex()
      .id(`tg-${e.address ?? "mute"}`)
      .flex_none()
      .h(20)
      .px(6)
      .gap(6)
      .items_center()
      .rounded(5)
      .child(div().text_color(t.muted).child(e.text))
      .when(Boolean(e.where), (el) => el.child(div().max_w(200).truncate().text_color(t.dim).child(e.where)));
    // The mute is everyone's and goes nowhere.
    if (!e.address) return el;
    return el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("pane.focus", { terminal: e.address }));
  }

  render() {
    const t = theme();
    return h_flex()
      .size_full()
      .items_center()
      .gap(12)
      .px(10)
      .text_size(12)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .children(telegramEntries(terminals()).map((e) => this.entry(t, e)));
  }
}
