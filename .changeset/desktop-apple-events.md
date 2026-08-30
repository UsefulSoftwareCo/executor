---
"@executor-js/desktop": patch
"@executor-js/plugin-mcp": patch
---

Let macOS ask before denying Codex plugins Automation access. The desktop app
and its bundled daemon are hardened-runtime signed without the Apple Events
entitlement, so tccd refused to even show the consent prompt: every Messages
call was denied silently, no Automation row was ever created in System
Settings, and the access check sat on "Checking…" for a full minute before
misreporting the hang as a failed start. The app and daemon are now signed
with `com.apple.security.automation.apple-events` and carry a usage
description, so the first call raises the real consent prompt and the grant
becomes visible in Privacy & Security → Automation.

The access check also stops waiting after 25 seconds and says what a hang
means — answer the permission prompt on screen, then check again — instead of
blaming the Codex install.
