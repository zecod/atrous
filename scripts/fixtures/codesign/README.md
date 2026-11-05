Real `/usr/bin/codesign -dvv <bundle>.app` output on macOS (captured by herdr-app from a published 0.1.8 macos-aarch64 release), with the bundle path, identifier and signing team replaced by Atrous's names and a placeholder developer. All output was on stderr; stdout was empty.

- `developer-id.txt`: a Developer ID signed release, exit 0.
- `adhoc.txt`: after `codesign --force --sign - Atrous.app`, exit 0.
- `unsigned.txt`: after `codesign --remove-signature Atrous.app`, exit 1.
