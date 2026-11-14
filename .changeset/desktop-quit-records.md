---
"@executor-js/desktop": patch
---

Executor desktop records its quit in its diagnostics log and on stderr as it happens: why it
quit, which of its parts it was closing, when it finished, and any uncaught exception, also one
thrown after its own logger has stopped. A quit that does not finish now says where it stopped.
