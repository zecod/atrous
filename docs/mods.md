# Layouts and mods

You can change the whole window, not just its colors. Layouts arrange it; mods draw the panels inside it.

Read the [layout and mod guide](../defaults/AGENTS.md). This is the same guide Atrous writes into your app home on every start, so people and agents work from one source of truth.
It covers layouts, settings, keys, overlays, mod code and the app API.
The generated `atrous.d.ts` and `gpui-kit.d.ts` beside your installed guide describe the full API for your version.
Mods import from `"atrous"`. Mods written for herdr-app import from `"herdr"` and call `hc()`; both still work, as other names for the same module and for `core()`.

Start with Settings for fonts, colors and sounds.
For deeper changes, duplicate a shipped layout or mod from the command palette, then edit the copy.
Shipped files update on start; personal copies do not.
Save to reload. Check for errors, even when the old screen still looks fine.

```sh
atrous check ~/.config/atrous/mods/my-panel
atrous status
```

The check loads a mod and renders it once. It does not replace looking at the result in the window.

Mods can run programs, read files and use the network. Only install code you trust.
See [security and privacy](security.md).

[Back to Atrous](../README.md)
