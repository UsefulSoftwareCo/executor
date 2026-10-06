---
"@executor-js/local-server": patch
---

`executor pair` now only reads the keys saved in its data directory. It no longer creates the directory, an installation record or new keys when none are saved; it says the directory has no saved keys and how to point it at the running server's folder. When it cannot print a link, it also says whether no server answered on the configured port or the server there did not accept the saved API key.
