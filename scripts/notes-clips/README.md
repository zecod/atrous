# Release-note clips

On Linux, run `just notes-clip pane-drag` or `just notes-clip peek`.
An optional second argument selects the version (otherwise Cargo.toml).
Requires Bun, ffmpeg, ImageMagick, Weston/Xwayland and the sandbox's uv/python-xlib input.
Each run builds the app, creates its own sandbox, records app-rendered PNGs
at 12 fps for five seconds, then removes the sandbox and temporary frames.
The looped lossless WebP starts at 1200px wide and must fit within 1,500,000
bytes; oversized scenes retry at 1100px then 960px without losing motion.
Scenes use the shipped Main layout, then crop to the action: the pane headers
and terminal content, or the agent message and peek overlay.
A normal arrow, pointing hand or closed hand is composited onto each app
frame at the scripted pointer's recorded position after capture, preserving
the recording cadence. Hover, drag preview and drop highlights are real.

Scenes are shell scripts with `setup`, `play` and `crop` stages. The last
prints an ffmpeg crop (`width:height:x:y`) in the original 1280×820 frame. Setup may use app
commands. Play uses `sandbox sequence` with JSON actions (sleep, move,
click, hold/release keys, press/lift mouse); one XTest connection preserves
modifiers and smooth pointer movement. Coordinates match the sandbox's
1280×820 app window at its default 120% zoom. Update these when UI changes,
and inspect the generated clip before uploading.

Output: `/var/tmp/atrous-notes-media/<version>/<scene>.webp`.
Override the base with `ATROUS_NOTES_MEDIA_DIR`. Launch the app with that
same variable to preview CHANGELOG images pointing at the final URLs:
`https://github.com/zecod/atrous/releases/download/v<version>/<scene>.webp`.
No CHANGELOG rewrite needed.

`just notes-upload <version>` attaches the version's WebP files to the GitHub
release `v<version>` of zecod/atrous with `gh release upload` (create it as a
draft first: `gh release create v<version> --draft`). An asset name already on
the release is refused. Upload only final clips.

`just notes-check <version>` checks every image in that CHANGELOG entry
for HTTP 200 and an image content type. Run it before tagging a release,
before any release files are published. An entry without media
is valid; a missing entry isn't.
