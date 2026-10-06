---
"@executor-js/local-server": patch
---

`executor pair` no longer creates the data directory, an installation record or new keys. When the directory has no saved keys, it says so and how to point it at the running server's folder. When it cannot print a link, it says whether no server answered on the configured port or the server there rejected the API key.
