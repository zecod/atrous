---
name: herdr-browser
description: Inspect and drive the Browser panel inside herdr (the same browser the person sees): open pages, read the console, list and inspect network requests with their bodies, intercept and rewrite requests or responses (headers, body, status), replay edited requests, read and edit the live page HTML, cookies, localStorage, sessionStorage and IndexedDB, take screenshots and run JS in the page. Use it when a task involves a web page or web app open in herdr's Browser panel, debugging API calls, or testing a site by changing its traffic, DOM or storage.
---

# herdr Browser panel

herdr's Browser panel is a real Chromium browser shown beside the terminals. The person sees
every page you open and every change you make there, live. Drive it with the `bp` command:

```sh
node "<this skill's folder>/bp.mjs" <command> [args]
```

Below, `bp` stands for that whole `node ".../bp.mjs"` call.
Every command prints compact JSON on stdout (errors on stderr, exit code 1). Start with
`bp status`. If it says the panel isn't running, run `bp start`: that opens the panel in herdr.

## Pages, console, HTML, screenshots

| Command | What it does |
|---|---|
| `bp status` | url, title, tabs, and the element the person picked in the panel (if any) |
| `bp start` | opens the Browser panel in herdr and waits for it |
| `bp open <url> [--new] [--no-wait]` | navigates (a new tab with `--new`) and waits for the load |
| `bp back` / `forward` / `reload [--hard]` | history and reload |
| `bp tabs`, `bp tab <id>`, `bp close [<id>]` | list, switch to, close tabs |
| `bp console [--errors] [--grep re] [--limit n]` | console messages and exceptions of the shown tab |
| `bp html [page\|picked]` | the page's HTML, or the element the person picked |
| `bp eval <js\|@file>` | runs JS in the page and prints the result (promises are awaited) |
| `bp shot [--selector css] [--full] [--out f.png]` | screenshot; prints the file path (read it to see it) |
| `bp cdp` | the DevTools endpoint, for Playwright `connectOverCDP` when you need real clicks and typing |

## Network: traffic, intercept, replay

`bp net ...`: list requests with their domain, type and status; show one request's headers,
payload and response body; replay an edited copy (Repeater); add intercept rules that rewrite
requests or responses automatically, or pause them for editing. Read `net.md` in this folder
for every command and worked examples.

## Live HTML and storage

`bp dom ...` (query, read and replace HTML live), `bp cookies ...`, `bp local ...`,
`bp session ...`, `bp idb ...` (IndexedDB). Read `dom.md` in this folder for every command
and worked examples.

## Rules

- **It's the person's browser.** Its profile can hold their real sessions (imported from their
  browser). Read cookies, storage and traffic only as the task needs; never send cookie values,
  tokens or other secrets anywhere, and don't print them in full when a prefix is enough.
- **Say what you change.** Intercept rules, storage edits and DOM edits affect what the person
  sees. Tell them what you set, and remove your intercept rules when you're done
  (`bp net rule rm --all` removes yours; they also expire on their own).
- **Don't close the browser** or the person's tabs unless asked. Open your own tab with
  `bp open <url> --new` when you need to look around without moving them.
- DOM edits are live and temporary: a reload brings the site's own HTML back. Change the
  source code for lasting fixes.
- A different port than 9334: set `HERDR_BROWSER_API=<port>`.
