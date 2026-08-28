---
"executor": patch
---

**Idle MCP session runtimes are actually reclaimed**

The MCP session Durable Object has an idle timeout that disposes a session's execution runtime — the execution engine and its executor closure, the built tool catalog, and a live database handle — once the session has gone quiet. That timeout never ran.

The session arms an idle alarm on every request. The agents framework independently recomputes the Durable Object alarm from its own schedule table and keep-alive refcount, and when it finds neither it does not leave the alarm alone: it deletes it. It releases the last keep-alive reference at the end of every ordinary tool call, from a `waitUntil` that runs just after the response goes out — so the idle alarm the session had armed moments earlier was erased, and a session that had just served a request was left with no alarm at all. Its runtime then stayed resident until the platform evicted the whole object.

Durable Objects are colocated many-to-one onto an isolate with a single heap, so runtimes that are never reclaimed accumulate there. When the heap is exhausted the allocation that fails is whichever comes next, anywhere in the isolate — which is why the failure tended to surface from storage rather than from the runtimes that had consumed the memory.

The idle deadline belongs to the session, not to the framework's scheduler, so it is now re-asserted after the framework has arranged whatever it needs — and only while a runtime is actually resident, since once there is nothing left to reclaim the framework's answer is correct.

Disposal also now emits a span carrying a per-isolate resident-runtime gauge, alongside the same gauge on runtime build, so the reclaim can be confirmed in production rather than inferred.
