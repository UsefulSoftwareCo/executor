---
"@executor-js/react": patch
---

**Reconnecting a DCR connection now re-registers instead of reusing a stranded client**

A dynamically registered OAuth client is bound to the redirect URI it registered with. Once the app's callback origin changed (127.0.0.1 to localhost), Reconnect still started the flow against the stored client, and the authorization server rejected it — leaving no way to repair the connection.

Reconnect now takes the same probe → CIMD-or-register → start route as the initial connect, so the registration gateway replaces the stranded client against the current redirect URI. Methods with a fixed, hand-registered app are unaffected and keep using their stored client.
