---
"@executor-js/local": patch
"@executor-js/react": patch
---

**Desktop OAuth connects finish the moment the provider redirects**

When the desktop app runs an OAuth flow in the system browser, the app learned about completion by polling the local server once a second. The completed result sat in memory while the user watched the "Connecting…" spinner for up to a second more — about half a second wasted on average, on every connect.

The await endpoint now long-polls: the server holds the request open (up to 25 seconds per hold) and answers the instant the flow completes. The client polls one request at a time and reconnects after each answer, so requests never stack. Mixed versions stay compatible in both directions: an old client still gets its answer within one poll of a new server, and a new client against an old server behaves exactly as before.
