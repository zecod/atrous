// `mod.open usage-stats` (the command palette, keys): the Usage & activity page as its own
// dialog. The page lives in mods/my-settings/usage.js, where it is also Settings' "Usage &
// activity" tab: a mod can't import from another mod's folder, so this one only opens
// my-settings on that page ({ section: "usage", only: true }) and closes its own
// invisible popup (mod.json: 2×2 px, no frame).

import { View, div } from "gpui-kit";
import { props, openOverlay, closeOverlay } from "herdr";

export default class UsageStats extends View {
  init() {
    const own = props()?.overlay;
    openOverlay({ mod: "my-settings", kind: "dialog", width: 0.8, height: 0.85, props: { section: "usage", only: true } });
    if (own) closeOverlay(own);
  }

  render() {
    return div();
  }
}
