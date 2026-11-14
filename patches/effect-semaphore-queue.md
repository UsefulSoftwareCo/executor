# Semaphore queue patch

Effect 4.1 made `Semaphore` first-come-first-served and, with it, made a long queue expensive.
Every release copied the whole queue (`Array.from(this.waiters)`) to find the requests to wake,
and every request that began to wait searched the queue for one that fits. A queue of n
requests therefore cost n × n. With 16,000 requests waiting on one permit, Effect 4.0.1 drains
the queue in about 0.3 s and 4.1.4 in 4 to 6 s.

Cloud's schedule coordinator takes one permit for every wake, and every write in every
organization wakes it. On deployed test stages built on Effect 4.1.4 a burst of a few thousand
wakes took minutes to drain: a wake waited 14 s at the median where `main` took 0.2 to 0.3 s,
an alarm ran for 102 and 149 s instead of at most a minute, and the API Worker ended those two
alarms with Cloudflare's `exceededMemory`, failing 579 and 718 wakes.

`effect@4.1.4.patch` changes `Semaphore.ts` (and its `dist/` build):

- A release chooses the requests to wake first, stopping once the free permits are spoken
  for, and resumes only those. A chosen request that an earlier one removed is skipped; its
  removal already started another pass.
- The search for the first request that fits returns at once when no permit is free.
- Both rely on a count of queued requests for zero permits, the only ones that fit while none
  are free.

The order requests acquire in is unchanged: 1,500 random workloads (one to four permits,
requests for zero to all of them, scoped takes and interruptions) gave the same sequence of
acquisitions and releases as upstream 4.1.4. `e2e/tests/effect-semaphore-queue.spec.ts`
(`bun run e2e:effect-mcp`) holds the patched semaphore to a queue whose cost grows with its
length and to that order.

Drop the patch when upstream wakes waiters without copying or searching the whole queue.
