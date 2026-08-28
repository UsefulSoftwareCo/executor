---
"executor": patch
---

**The desktop settings store is written owner-only**

`settings.json` holds `serverProfiles`, which carries a remote server's credential — a bearer token, or a basic-auth username and password — for any "Custom server" the user connects to. `conf` (under electron-store) defaults to `configFileMode: 0o666`, so with no explicit mode the file was created `0644`. On Linux, where `~/.config` is not reliably `0700`, that is readable by every other account on the machine. macOS is protected by `~/Library` being `0700` and Windows by ACLs, so this is primarily a Linux-desktop exposure — but owner-only credential files are already this app's standard: `local-auth.ts` writes `auth.json` at `0o600`, and the sidecar manifest is chmodded the same way.

One option is sufficient here, rather than the mode-plus-chmod pair used elsewhere: `atomically` chmods the temp inode only when the requested mode differs from its own default, and the atomic rename then carries the tight mode onto an already-loose file. Verified against the installed `conf` — with no option a fresh file lands `0644`; with `configFileMode: 0o600` a fresh file lands `0600` and an existing `0644` file becomes `0600` on the next write.
