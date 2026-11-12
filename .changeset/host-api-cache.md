---
"@executor-js/sdk": patch
"apps": patch
---

A host can pass `hostApi` to `createExecutor`: the SHA-256 of the API document
it serves, the URLs it serves it at, and which app versions read it. Those
versions' app cache and kept tool listings are keyed by the revision too, so
after the host's API changes they read the new API on their next call instead
of listing its removed tools until their cached document expires. That holds for
a version that owns a database as well. Invocations carry the revision to the
runner, whose outbound network, the data facet's included, refuses a document
from those URLs with a different SHA-256, so a caller and an API deployed at
different moments never keep one revision's API under the other's name. The
app's `fetch` then rejects with the code `EXECUTOR_API_CHANGING`, and the agent
is told that Executor's API is changing and to retry shortly; a tool call that
may have written is told the API is changing but not to repeat it. A caller refuses
the result of a remote runner that does not confirm the check.

An app failure's `code` is the thrown error's own, or else the code of the
error it wraps, such as the platform rejection inside the `HttpClientError`
that `ctx.fetch` rejects with.
