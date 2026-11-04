# Fedra

A personal layout and set of mods for [herdr](https://github.com/herdrdev/herdr-app), the desktop app for terminals and coding agents. Herdr redraws itself from files in `~/.config/herdr-app`. Fedra is those files.

![Fedra](home/layouts/fedra.svg)

## Install

1. Install herdr-app the usual way (macOS: `brew install --cask herdr-app`; Windows: `irm https://releases.herdr.dev/app/install.ps1 | iex`) and start it once.
2. Install [Node.js](https://nodejs.org) (Fedra's helpers use it).
3. Run:

```sh
git clone https://github.com/zecod/herdr-app
cd herdr-app/fedra
node install.mjs          # add --dry-run to see what it would change
```

The installer copies Fedra's layout and mods into your app home and adds two keys and the agent launch commands. It backs up anything it replaces into `fedra-backup-<time>/` and switches the running app to Fedra.

Run it again after `git pull` to update. Your accounts, usage data and app state are never touched.

## What's in it

**Sidebar**
- **Projects and agents:** projects show as folders, with their agents underneath in a tree. Each agent row shows its session title, a spinner while working and a dot otherwise, plus tokens/s for its last finished turn.
- **Worktrees** nest under their repo, each with its own agents. Clicking a project or its folder icon folds what's inside.
- **Add a project:** the **+** opens a dialog to browse to a folder, clone from a URL, create an empty project, or make a new worktree. Worktrees are created in the background with a progress line.
- **Right-click an agent** to copy its agent ID (`hc send/wait/read <id>` lets another agent talk to it), its session ID, or a ready-made note for another agent; or to move it into the current tab (left/right/top/bottom/new tab).
- **Drag to split:** drag an agent, a tab or a pane header onto the terminal area to split it there, Windows-snap style.
- **Usage card:** Claude Code and Codex plan limits (5-hour, week, per-model), refresh and collapse buttons, numbers aligned. It works with several accounts.
- **Narrow rail:** a folded sidebar shows each agent as a small tile colored by its state.

**Tabs and panels**
- **Tab titles:** tabs show the agent's session title instead of "Claude Code".
- **Files panel:** fast folder listing, git colors (M/U/A/D, passed up to folders), Markdown preview/raw tabs, and it widens when you open a file.
- **Browser panel:** a real Chrome you and your agents share (CDP at `127.0.0.1:9333`). It has tabs, an element picker (copies the HTML), notes on elements you can send to a new or running agent, a debug drawer (console, network, elements), and an import from Chrome.
- **Quick terminal:** **Ctrl+`** opens VS Code-style terminals under the agents, one set per project, with tabs and **+**.

**Settings**
- **Accounts:** log in to more than one Claude Code or Codex account and pick the one new agents use. It can switch automatically when an account hits its limit.
- **Usage & activity:** a GitHub-style activity heatmap and token and cost stats from [ccusage](https://github.com/ryoppippi/ccusage).

**Agents**
- New agents from the **+** menu start without permission prompts (`--dangerously-skip-permissions`, `--yolo`, …). Edit `programs.json` if you don't want that.

## Platform notes

Fedra was built and tested on Windows 11 with herdr-app 0.1.12. On macOS and Linux:
- **Account launchers:** `accounts/*.sh` are used instead of the PowerShell ones.
- **Claude Code on macOS:** logins live in the Keychain, and the usage card and Accounts read them from there. macOS may ask once to allow access. For extra accounts it's best effort; if the card shows one as logged out, launching agents on it still works.
- **Browser panel on macOS:** uses the streamed view with Google Chrome (the native page view is Windows-only).
- **Browser panel on Windows:** the fast native page view (WebView2) builds itself the first time Browser opens, which needs the [.NET 9 SDK](https://dotnet.microsoft.com/download). Without it the panel uses the streamed view.

## Layout

`home/` mirrors `~/.config/herdr-app`:
- `layouts/fedra.json`, `layouts/fedra.svg`: the window
- `mods/*`: the panels (personal copies of herdr's shipped mods start with `my-`)
- `accounts/`: launchers that start Claude Code or Codex under the chosen account
