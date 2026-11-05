# Network: traffic, intercept, replay

`bp net ...` reads and changes the Browser panel's traffic: the same log and the same intercept
engine the person sees in the panel's devtools drawer (Network and Intercept tabs). Every tab of
the browser is logged (the last 1000 requests each; a new page clears its tab's log unless the
person turned on Preserve log). A request's `id` is one number across tabs that only grows; `last`
in `net ls` is the newest, for `--since`.

URL patterns: with a `*`, wildcards (`*` anything, `?` one character); without a `*`, "the URL
contains this", taken literally (`api.example.com/v1/cart?id` works as written).

| Command | What it does |
|---|---|
| `bp net ls [--type T] [--q text] [--domain d] [--status s] [--method M] [--limit 50] [--since id] [--tab current\|all\|<id>]` | newest requests (oldest first): id, method, url, domain, status, type, size, time, pending/failed. `--type`: xhr, fetch, api (xhr+fetch), doc, js, css, img, media, font, ws, other. `--status`: 404, 4xx, error (failed or >= 400), failed, pending |
| `bp net show <id> [--body] [--response] [--max n] [--full]` | one request: both header sets, timing, initiator; `--body` the request body, `--response` the response body (text, or base64 for binary), cut at 4000 characters unless `--max`/`--full` |
| `bp net replay [<id>] [--method M] [--url U] [--header "K: V"]... [--remove-header K]... [--body text\|@file] [--direct]` | sends an edited copy of request `<id>` (or a new request with `--url`) and prints status, headers and body. From the page by default (its cookies and origin; the browser sets Cookie, Origin, Referer, Sec-* itself and another domain must allow it by CORS). `--direct`: from the helper, exactly your headers plus the browser's cookies for the URL, no CORS |
| `bp net wait <pattern> [--method M] [--status s] [--timeout 30] [--since id]` | waits for the first matching request to finish (from now on, or one already in flight, or after `--since`) and prints it; exit 1 on timeout |
| `bp net rule add <pattern> [edits] [--stage request\|response] [--pause] [--only-method M] [--type T] [--times n] [--ttl 600] [--tab current]` | an intercept rule. Edits: `--set-header "K: V"`, `--remove-header K`, `--body text\|@file`, and `--url U` / `--method M` (request stage) or `--status n` (response stage). Without `--pause` it rewrites matching traffic by itself; with `--pause` matching requests wait in the queue (see `paused`). Rules end after `--times` matches or `--ttl` seconds (default 600) |
| `bp net rule ls` / `bp net rule rm <id>` / `bp net rule rm --all` | your rules (and the person's, marked `by: "you"`, which only they can remove); `--all` removes only yours |
| `bp net paused` | requests a pause rule (or the person's Intercept) is holding: id, stage, method, url, headers, body |
| `bp net continue <id> [edits]` | lets a held request (or response) go, after the same edits as `rule add` |
| `bp net drop <id>` | fails a held request: the page sees a network error |

The person sees your rules and held requests in the panel (an "Intercepting" badge and the
Intercept tab) and can remove them. Held requests never hang the page for long: they go on when
their rule is removed or expires, after 60 s with nobody looking at the queue, and when the
browser helper stops. Remove your rules when you're done (`bp net rule rm --all`).

## Worked examples

**Find the API call a button makes.** Note the newest id, press the button, then list what came after:

```sh
bp net ls --limit 1                       # {"last": 812, ...}
# press the button (bp eval "document.querySelector('#save').click()", or ask the person)
bp net ls --since 812 --type api          # the XHR/fetch requests it made
bp net show 815 --body --response         # its payload and the answer
```

Or wait for it while something else presses: `bp net wait "*/api/orders*" --method POST --timeout 20`.

**Add a header to every API request** (for 10 minutes, then it's gone by itself):

```sh
bp net rule add "*://api.example.com/*" --set-header "X-Debug: 1" --ttl 600
bp open https://app.example.com           # reload: the page's API calls carry the header now
bp net ls --domain api.example.com --limit 5   # "edited": "request (rule)" on each
bp net rule rm --all                      # when done
```

**Change a JSON response to test an edge case** (an empty cart, once):

```sh
bp net rule add "api.example.com/v1/cart" --stage response --status 200 \
  --set-header "content-type: application/json" --body '{"items":[],"total":0}' --times 1
bp reload                                 # the page renders the empty cart
bp shot                                   # see it
```

To edit by hand instead, hold it: `bp net rule add "api.example.com/v1/cart" --stage response --pause`,
then `bp net paused`, `bp net continue <id> --body @cart.json --status 500`, `bp net rule rm <rule id>`.
