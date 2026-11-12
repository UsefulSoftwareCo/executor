---
"@executor-js/telemetry": patch
"@executor-js/hosted-self-host": patch
---

The bundled Motel collector no longer churns once its store is full. It used to
evict back to exactly its 1 GiB bound, so the next export crossed it again, and
every export, about one a second on an idle server, paid for an eviction pass
that scanned the whole store. A full store now evicts down to 90% of its bound
and then stores exports without evicting until it fills again. On a full 1 GiB
store with an idle server's exports, the collector's CPU fell from about 9% of a
core to under 1%, its reads from about 30 MiB/s to about 1 MiB/s, and each
export's time from about 120 ms to about 20 ms.
