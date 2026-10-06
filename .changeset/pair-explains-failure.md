---
"@executor-js/local-server": patch
---

`executor pair` no longer creates the data directory, an installation record or new keys. It now says when the directory has no saved keys, when no server answers on the port, and when the server rejects the API key.
