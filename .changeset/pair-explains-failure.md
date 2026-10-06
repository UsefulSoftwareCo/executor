---
"@executor-js/local-server": patch
---

`executor pair` now says why it could not print a link: no server answered on the configured port, or the server there did not accept this data directory's API key. Other failures still report the generic startup error.
