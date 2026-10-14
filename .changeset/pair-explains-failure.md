---
"@executor-js/local-server": patch
---

`executor pair` no longer creates a data directory, an installation record or keys. It only reads
the saved key and says what to correct: a directory with no saved keys, no server on the port, a
server that did not accept the key (another data directory, such as Executor desktop's, or a key
rotated since the server started), or something on the port that is not Executor. A supplied
`EXECUTOR_API_KEY` is enough to pair; `pair` never needs the encryption key.
