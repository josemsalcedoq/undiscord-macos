# Undiscord Multiselect

A browser **userscript** that bulk-deletes **your own** Discord messages, with one thing the
original [Undiscord](https://github.com/victornpb/undiscord) doesn't have: it **auto-discovers your
DMs and servers and lets you multiselect them with checkboxes** — no manually pasting channel/guild IDs.

It runs inside your logged-in Discord browser tab and reuses your existing session (your account
token), which is the lowest-friction, lowest-fingerprint way to do this.

## ⚠️ Read this first

- This deletes **your own** messages using **your account token**, exactly like the original Undiscord.
- Automating a user account is **against Discord's Terms of Service** and can, in principle, get an
  account actioned — *independent of how slow you go*. The delays reduce rate-limit bans, not ToS risk.
- Deletion is **permanent**. Use **Scan counts** and the confirmation dialog before running.
- Only use this on your own account, for your own messages.

## Install

1. Install a userscript manager: **Tampermonkey** or **Violentmonkey** (browser extension).
2. Open `undiscord-multiselect.user.js` — the manager should offer to install it. (Or create a new
   script and paste the file contents.)
3. Go to `https://discord.com/app` (the web client, logged in). A **🗑️ button** appears bottom-right.

## Use

1. Click the 🗑️ button. It auto-grabs your token + user id and loads your **DMs** and **Servers**.
2. Switch tabs (Direct Messages / Servers), filter, and **check** the ones to clean.
3. *(Optional)* **Scan counts** — shows how many of your messages are in each selected target.
4. **Delete selected** → confirm. Watch progress + log. **Stop** halts after the current message.

- **DM/group** targets delete your messages in that conversation.
- **Server** targets search the whole server for messages authored by you and delete across channels.

## Rate limiting (ported from the original Undiscord)

Defaults are deliberately conservative:

| Setting | Default | Purpose |
|---|---|---|
| Search delay | **30000 ms** | between search pages — Discord's search endpoint rate-limits hard |
| Delete delay | **1000 ms** | between individual deletes |
| Max attempts | 2 | per message |

Adaptive backoff, matching upstream:
- **Search `202`** (channel not indexed) → wait `retry_after`, retry.
- **Search `429`** → permanently raise `searchDelay += retry_after`, then wait `2×` before retrying.
- **Delete `429`** → set `deleteDelay = retry_after`, wait `2×`, retry.
- **Delete `400` code 50083** (archived thread) → skip so it doesn't loop.

You can raise the delays in the panel if you get rate-limited; lowering them increases ban risk.

## Credits

Rate-limit engine, token-grab technique, and search/delete mechanics adapted from
[victornpb/undiscord](https://github.com/victornpb/undiscord) (MIT). Multiselect discovery UI is new.
