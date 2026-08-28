---
"executor": patch
---

**The OAuth popup clears its result out of `localStorage` after handing it over**

The popup writes its result to `localStorage` as the fallback completion channel, because `postMessage` is severed when a provider's consent page sets COOP and `BroadcastChannel` can be partitioned or raced by the auto-close. Nothing removed that entry afterwards, so the payload — which carries the identity label, an email, and on failure the error preview — stayed parked in the user's browser profile.

The entry is now cleared once the handover has had time to land, and on `pagehide` as a backstop — the failure page never auto-closes so the user can read the error, and closing it by hand would otherwise cancel the pending timer and strand the entry. This cannot cost a listener the result: a `storage` event captures `newValue` at dispatch, so an opener that has been notified already holds it.
