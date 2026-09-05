---
"@executor-js/local-app": patch
"@executor-js/cli": patch
"@executor-js/react": patch
---

fix: replace the token-in-URL web bootstrap with a one-time-code exchange

Opening the web UI previously put the daemon bearer token in the URL
(`?_token=<token>`) and the SPA persisted it to localStorage — both are
leak-prone surfaces (browser history, logs, screen recordings, and
localStorage is readable by any script on the origin).

`executor web` / `executor open` now mint a one-time code (bearer-gated,
single-use, 60-second TTL, 128-bit entropy, bound to the running daemon
instance) and open `/?_otc=<code>`. On first load the SPA exchanges the
code for the bearer, applies it to the in-memory connection, and strips the
query. The server also sets an HttpOnly SameSite=strict cookie as transport
hardening. Nothing is written to localStorage by the bootstrap path; the
legacy `?_token=` query is still accepted for compatibility with older
daemons but is no longer persisted.
