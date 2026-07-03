# Undiscord (native macOS app)

A native **macOS app** that bulk-deletes **your own** Discord messages, with one thing the
original [Undiscord](https://github.com/victornpb/undiscord) userscript doesn't have: it
**auto-discovers your DMs and servers and lets you multiselect them with checkboxes** — no
manually pasting channel/guild IDs, and no browser extension.

The app is a self-contained window: it loads the Discord web client, you log in once (login
persists), and it runs the deletion tool inside that real session — so the token grab works and
it behaves like a normal client, while looking and launching like a native app.

The app lives in [`mac-app/`](mac-app/).

## ⚠️ Read this first

- Deletes **your own** messages using **your account token**, like the original Undiscord.
- Automating a user account is **against Discord's Terms of Service** and can, in principle, get an
  account actioned — *independent of how slow you go*. The delays reduce rate-limit bans, not ToS risk.
- Deletion is **permanent**. Use **Scan counts** and the confirmation dialog before running.
- Only use this on your own account, for your own messages.

## Requirements
- macOS 12+
- Swift toolchain (Xcode or Command Line Tools).

## Run it
```sh
cd mac-app
swift run
```
A Discord window opens — **log in normally**. The 🗑️ panel appears bottom-right; login is
remembered next launch.

### Build a double-clickable app
```sh
cd mac-app
./bundle.sh          # produces mac-app/Undiscord.app
open Undiscord.app
```

## Using the panel
1. Click **🗑️**. It auto-grabs your token + user id and loads your **DMs** and **Servers**.
2. Pick a tab (Direct Messages / Servers), filter, and **check** the conversations to clean.
3. *(Recommended)* **Scan counts** — shows how many of your messages are in each selected target.
4. **Delete selected** → confirm. Watch the progress bar + log. **Stop** halts after the current message.

- A **DM/group** target deletes your messages in that conversation.
- A **Server** target searches the whole server for messages authored by you and deletes across channels.

## Rate limiting (adapted from the original Undiscord)

| Setting | Default | Purpose |
|---|---|---|
| Search delay | **30000 ms** | between search pages — Discord's search endpoint rate-limits hard |
| Delete delay | **1000 ms** | between individual deletes |
| Max attempts | 2 | per message |

Adaptive backoff: search `202` (not indexed) → wait & retry; search `429` → permanently raise
`searchDelay += retry_after`, wait `2×`; delete `429` → set `deleteDelay = retry_after`, wait `2×`;
delete `400` code 50083 (archived thread) → skip. Raise the delays in the panel if you get
rate-limited; lowering them increases ban risk.

## Credits
Rate-limit engine, token-grab technique, and search/delete mechanics adapted from
[victornpb/undiscord](https://github.com/victornpb/undiscord) (MIT). Native app shell and
multiselect discovery UI are new.
