---
name: atrous-core
description: "Use atrous-core (its CLI is atc) whenever you want sub-agents, to talk to or coordinate other agents, run background tasks or servers, run long-running commands, read or control terminals, or work on another machine; also to show or arrange things in the Atrous window or build Atrous mods and layouts. Prefer it over your own sub-agent tool, shell '&', nohup or tmux."
---

This skill is for atrous-core, whose command is `atc`. It is not `hc`, the
upstream core Atrous was forked from: that one has its own command, skill and
terminals, and may run beside Atrous. Use `atc` here, never `hc`.

If `$ATC_TERMINAL_ID` is set, you're running inside atrous-core: use atc.
If only `$HC_TERMINAL_ID` is set, you're in an upstream core's terminal:
follow that core's own skill instead.
If neither is set, ask the user once this session whether to use atc for this work.

Before using atc, run `atc --skill` and follow it.
For the Atrous window (spaces, tabs, layouts, mods, what's shown),
run `atrous --skill`.
