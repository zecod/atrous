# Security and privacy

## Mods have your access

A mod is trusted JavaScript running inside Atrous. It can run programs with your environment, fetch URLs and read files.
The built-in file API limits writes to the app home, but a mod can run a program to write elsewhere. That is not a security boundary.
Mods can also run programs on connected machines.

There is no permission prompt for each program or network request. Read a mod before installing it, and treat it like a shell script you would run yourself.
Layouts can load mods. Check those references too.

## What stays on disk

The default app home is `~/.config/atrous`, including on macOS and Windows (under your user home).
`XDG_CONFIG_HOME` changes the config root. `ATROUS_HOME` selects an app home directly and takes precedence.

This folder holds your settings, keys, layouts, mods, generated agent guide and API types.
It also holds mod data, shared state, window positions, this screen's focus and zoom, update notes and cached media.
Mods may store sensitive data here. Atrous does not encrypt this folder.
The [installed guide's file map](../defaults/AGENTS.md#the-files) explains the files.

Spaces, tabs and splits are stored in each machine's core document, not in the app home.
Terminals and their output belong to atrous-core (`core/`), which ships inside Atrous and runs as its own background process.
Removing the app home does not stop the core or erase its data.

The app exposes a local control socket in its home so agents can inspect and drive the window.
Treat access to that home as access to the window and its commands.
Remote connections use SSH through the core.

## Updates and signing

Installed releases check the latest GitHub release of zecod/atrous (its `manifest.json`), download an update, and check its SHA-256 checksum against that manifest before unpacking it. Until zecod/atrous has published a release, a check finds nothing.
The app switches to the downloaded version on quit. Source builds do not update themselves.
Core updates are handled separately by the core's updater.

A checksum from the same release detects a damaged download; it is not an independent signature on the manifest.
The app does not verify a separate cryptographic signature on update manifests.

The release pipeline supports Apple Developer ID signing on macOS and Azure artifact signing on Windows when their credentials are configured.
Without them, packages can be unsigned or ad hoc signed.
On macOS the installer and updater verify certificate-signed bundles and preserve their signatures.
Apple notarization is tested separately; it is not required for publishing a release.
Do not assume every download is notarized or signed.

## Usage data and feedback

Atrous sends no usage data. herdr-app had daily anonymous usage reports; Atrous removed them: nothing is collected, nothing is stored for it, and there is no setting to turn it on. **Settings → Privacy** says so. A `telemetry` key left in a `settings.json` brought over from herdr-app is ignored.

What does reach the network on its own: update checks of an installed release (GitHub releases of zecod/atrous, which hold the app and its core), and the core's own connections to machines you add. Mods can use the network like any program you run.

Feedback is never sent by the app. **Send feedback** (or `atrous feedback "<text>"` from an agent) opens a new GitHub issue on zecod/atrous in your browser, filled in with your message, the app and core versions, your OS and the name of a built-in layout. You read it and post it yourself.

Atrous makes no requests to herdr's servers.

[Back to Atrous](../README.md)
