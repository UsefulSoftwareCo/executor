---
"@executor-js/telemetry": patch
"@executor-js/hosted-self-host": patch
---

The bundled Motel collector no longer rewrites an export the server sends
again. An export that waits past its 5-second timeout is resent, and the
collector used to delete and rewrite every span of the resend. On a full store
under traffic one resent export took 16 seconds, so the collector fell further
behind with each one. A resent span identical to the one already stored is now
skipped.
