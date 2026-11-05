# Page and storage

Read and change the shown tab's live HTML, and what its site keeps in the browser: cookies,
Local Storage, Session Storage and IndexedDB. Changes are live and the person sees them (the
Browser panel's Elements and Application tabs follow). DOM edits last until the page reloads;
storage edits stay. Everything acts on the tab the panel shows (`bp tab <id>` to switch).

Output is compact JSON; strings longer than 300 characters (HTML: 4000) are cut, `--full` shows
everything. A value written `@file` is read from that file.

## Commands

| Command | What it does |
|---|---|
| `bp dom query <css> [--limit 20]` | matching elements: `nodeId`, tag, id, classes, a text excerpt, box (viewport px), visible |
| `bp dom html [<css>] [--all] [--node id]` | outerHTML of the first match (all of them with `--all`); no selector: the whole page |
| `bp dom html --picked` | the element the person picked in the page or selected in the Elements tab |
| `bp dom picked` | both: `picked` (pick / annotate in the page) and `inspected` (Elements tab), with HTML |
| `bp dom set <css> --text <t>` | replaces the element's text |
| `bp dom set <css> --inner <html\|@file>` | replaces its innerHTML |
| `bp dom set <css> --html <html\|@file>` | replaces the whole element (outerHTML) |
| `bp dom set <css> --attr k=v ... --rm-attr k ...` | sets / removes attributes (combine with the above; `--all`: every match) |
| `bp dom rm <css> [--all]` | removes the element(s) |
| `bp cookies ls [--url U]` | the cookies the page (or URL U) gets: name, value, domain, path, expires (-1: session), flags |
| `bp cookies set <name> <value> [--domain d] [--path p] [--expires 7d\|2h\|date\|epoch] [--http-only] [--secure] [--same-site Lax\|Strict\|None] [--url U]` | sets one; the domain defaults to the page's host (host-only); `.example.com` makes a domain cookie |
| `bp cookies rm <name> [--domain d] [--path p] [--url U]` | deletes the matching cookie(s) |
| `bp cookies clear [--url U]` | deletes every cookie the page (or U) gets |
| `bp local ls` / `get <key>` / `set <key> <value\|@file>` / `rm <key>` / `clear` | Local Storage of the page's origin (`--origin O` for one of its frames) |
| `bp session ...` | the same for Session Storage |
| `bp idb ls` | databases, object stores (key path, auto-increment, record count) and indexes |
| `bp idb read <db> <store> [--limit 50] [--skip n] [--index name]` | records as JSON (`{"$date": ...}`, `{"$binary": bytes}`, `{"$map"}`, `{"$set"}` for what JSON can't hold) |
| `bp idb put <db> <store> <json\|@file> [--key k]` | adds or replaces a record; `--key` only for stores without a key path |
| `bp idb rm <db> <store> <key>` | deletes one record (`5` is a number key, `'"5"'` a string, `'[1,"a"]'` an array) |
| `bp idb clear <db> <store>` | empties the store |

Node ids (`nodeId`, `--node`) are valid until the page reloads. Selectors match the main
document (not iframes or shadow roots). Values and keys given on the command line are JSON when
they parse as JSON, else plain text. IndexedDB writes run in the page's origin (a separate script
world, so the site's own code isn't involved); the database and store must already exist.

## Examples

**Change a button's text live** (to try a wording without touching the code):

```sh
bp dom query "button, [role=button]" --limit 10        # find it: tag, classes, text, nodeId
bp dom set "form#signup button[type=submit]" --text "Create my account"
bp dom set "form#signup button[type=submit]" --attr data-variant=b --attr aria-label="Create account"
bp dom html "form#signup button[type=submit]"           # check the result
```

**Read the auth state a site keeps in localStorage** (don't print secrets in full):

```sh
bp local ls                       # keys and values (values cut at 300 characters)
bp local get auth                 # one key: {"found": true, "value": "{\"user\":{...},\"token\":\"eyJ...\"}"}
bp cookies ls | node -e "process.stdin.on('data', d => console.log(JSON.parse(d).cookies.map(c => [c.name, c.httpOnly, c.expires])))"
```

To test a signed-out state, remove what the site checks, then reload: `bp local rm auth`,
`bp cookies rm session_id`, `bp reload`.

**Seed an IndexedDB record to test a feature** (e.g. an offline cart):

```sh
bp idb ls                                                  # db "shop", store "carts", keyPath "id"
bp idb put shop carts '{"id": 42, "user": "test", "items": [{"sku": "A1", "qty": 3}]}'
bp idb read shop carts --index by_user                     # records by that index
bp reload                                                  # the app reads its seeded cart
bp idb rm shop carts 42                                    # clean up
```
