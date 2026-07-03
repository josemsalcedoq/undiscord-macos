# Undiscord — native macOS app

Self-contained macOS app: it embeds Discord's web client in a `WKWebView` and injects the
Undiscord Multiselect panel. You log in inside the app once (login persists); the 🗑️ panel then
discovers your DMs/servers for checkbox multiselect and bulk-deletes **your own** messages.

## Requirements
- macOS 12+
- Swift toolchain (Xcode or Command Line Tools).

## Run (dev)
```sh
swift run
```

## Build a double-clickable app
```sh
./bundle.sh          # -> Undiscord.app
open Undiscord.app
```
`bundle.sh` compiles a release binary, assembles `Undiscord.app`, embeds the resource bundle, and
ad-hoc code-signs it (no paid certificate needed). It's unsigned/un-notarized, so it's meant for
your own machine — Gatekeeper won't complain about a locally built app you launch yourself.

## How it works
- `WKWebViewConfiguration.websiteDataStore = .default()` → cookies/localStorage persist (stay logged in).
- The panel script (`Sources/UndiscordApp/undiscord.js`) is injected as a `WKUserScript` at
  `.atDocumentEnd`. App-level injection is not subject to Discord's page CSP.
- A minimal menu provides Cmd+Q and clipboard shortcuts so you can type/paste your Discord login.

## Layout
- `Sources/UndiscordApp/main.swift` — the app (window + web view + injection).
- `Sources/UndiscordApp/undiscord.js` — the injected panel: discovery, multiselect UI, and the
  rate-limited delete engine. Single source of truth.
- `bundle.sh` — packages `Undiscord.app`.

## Warnings
Deletes **your own** messages using **your account token**. Automating a user account is against
Discord's ToS regardless of speed. Keep the delays conservative. See the root `README.md`.
