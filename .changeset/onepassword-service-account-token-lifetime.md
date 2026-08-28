---
"executor": patch
---

**The 1Password service-account token is cleared from the op-js global after each call**

`@1password/op-js` keeps the service-account token on a module-level CLI instance (`cli.serviceAccountToken`) and reads it when it spawns `op`. The CLI backend set that global before each call and never cleared it, so one reachable reference to the token stayed live for the rest of the process.

It is now cleared as soon as the call that needed it is done, on success, failure and interruption alike. Authentication is unaffected: every read and write of that global already happens inside the backend's semaphore, so the next operation re-sets the token before it spawns anything.

This is hygiene rather than a boundary change. No unrelated `op` child ever received a stale token — every call routes through the same critical section that sets the correct one immediately before invoking — and the token is separately persisted in plaintext in the plugin's config blob, so an attacker's reach is unchanged. What it removes is a long-lived reachable reference that nothing needed to keep.
