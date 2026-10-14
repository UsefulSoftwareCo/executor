# Codemode runs each job to completion

`@opencode-ai%2Fcodemode@0.0.0-dev-19272.patch` also makes program code run one job at a time, as
JavaScript does: an async function's code between two awaits finishes before another job starts.

The interpreter runs each async function call, promise reaction and generator body on its own
Effect fiber. Effect preempts a fiber after 2,048 operations so other fibers get the thread. When
several program fibers were ready, for example after the tool calls in a `Promise.all` returned,
their statements interleaved. `counter += 1` read the binding, another fiber ran, and the write
dropped that fiber's updates. Strings, properties and values derived from shared state were lost
the same way, and a caller ran ahead of an async function's body before its first await. Execute
on Cloud, self-host and local returned 17,836 instead of 18,000 for the reported program.

Turning preemption off is not the fix: a CPU-bound program would then block the isolate and its
timeout would never fire. The patch keeps preemption for timers and host work and adds a turn
(`Turn` in `interpreter/promises.js`). Only the fiber holding it runs program code.

- The program's main job takes the turn and holds it until its leftover promises are interrupted.
- A fiber forked for program code (an async function call, a promise reaction, a combinator or a
  generator body) starts with its caller's turn. The caller continues once the fiber hands it back
  at its first suspension or end.
- A generator step hands the caller's turn to the parked body; the body hands it back when it
  yields, returns or awaits.
- Every `yieldNow` the unpatched interpreter uses as a job boundary (an await's continuation, a
  reaction, a thenable's `then`, a combinator's settlement) gives the turn to the next waiting job
  and queues to take it back.
- A promise resolved or rejected by program code settles in that call, without waiting for the
  turn: in its executor, by a captured resolver, or by an async generator's answer to a request.
  Its reactions queue then, as in JavaScript.
- A combinator (`Promise.all`, `race`, `any`, `allSettled`) settles in a reaction job on the member
  that decides it, as in JavaScript. It waits for its members without the turn, queues for the turn
  like any reaction and settles while holding it, so its reactions queue after the jobs that were
  ready before it.
- A tool call runs host code only, so it runs without the turn and tool calls stay concurrent.
  Its arguments are copied as data, which runs no program code.
- A fiber that starts with its caller's turn runs inside the caller's step, so async functions
  that call each other before their first await nest on the host stack. Past 100 nested fibers,
  fibers start and hand the turn back through the scheduler instead, and the host stack stays
  bounded.
- At most 2,000 program calls can be in progress on that chain: async function calls before their
  first await, generator steps (`next`, `return` and `throw`, also through `yield*` and loops) and
  `Promise.all`, `race`, `any` and `allSettled`, which call their iterable's methods. One more
  throws `RangeError: Maximum call stack size exceeded`, which execute reports as "Execution
  exceeded the maximum nesting depth." Fibers that run no program code before they suspend (the
  promise an async generator's `next()` returns, reactions, resolvers) do not count, so each level
  of a generator chain is one call. A call that fails at the limit changes nothing: the body never
  starts, and a generator step fails before it touches the generator, which answers its next step
  as before.

The waiting queue is first in, first out, but it is not JavaScript's job queue. Jobs become ready
in the order Effect's scheduler resumes their fibers, which is the order the unpatched interpreter
ran them in. That order is not JavaScript's in general (see the differences below). While no
program fiber is preempted, every fiber finds the turn free and the order is unchanged. When one
is preempted mid-job, the others wait in the order they became ready and start after it ends.

The unpatched package stops runaway async recursion only when the host stack overflows, and the
same overflow bounds how deep any chain of calls can go before its first await. The largest depth
`n` that returned (a chain of `n + 1` calls), measured once per shape in fresh processes (workerd
under Miniflare):

| Chain | Node | workerd | Bun | Patched |
| --- | --- | --- | --- | --- |
| Async functions | 1,261 | 1,354 | 7,118 | 1,999 |
| Async functions through a sync helper | 1,284 | 1,389 | 6,467 | 1,999 |
| Async generators, `yield*` | 618 | 630 | 3,573 | 1,999 |
| Sync generators, `yield*` | 1,272 | 1,284 | 6,490 | 1,999 |
| Started generators, each `yield*` to the next | 662 | 313 | 2,737 | 1,999 |
| Any of these with a loop per level long enough to be preempted | over 6,000 | over 6,000 | over 6,000 | 1,999 |

Past those depths the unpatched package reports the nesting-depth error, the host's `SyntaxError
…Stack overflow` when the overflow lands while the error is being handled, or nothing until its
timeout. With the turn, the overflow happened inside a fiber's synchronous start: the fiber never
finished, it held the turn, and the execution hung. The scheduler bound keeps the host stack
shallow, and the limit gives the nesting-depth error in about the unpatched time: runaway
recursion fails in 0.1 seconds in Node and 2.4 to 2.8 seconds on managed Cloud (1.7 to 2.1
unpatched). Each level unwinds through at least one scheduler step, which takes about a
millisecond on managed Cloud, so a limit near V8's own (about 8,900 calls in Node) would take over
10 seconds to fail there.

Node and workerd, which run local, desktop, Cloud and the self-host image, now run each of these
chains at least as deep as before, up to 2,000 calls. Bun runs only self-host's development entry;
there, chains between 2,000 calls and the depths above (up to about 7,100) now fail. On every
runtime, a chain whose levels each run long enough to be preempted had no depth limit, because
preemption unwound the host stack, and now fails past 2,000 calls: two 3,000-deep chains with a
300-iteration loop per level return unpatched and fail now. Sync recursion is unchanged: it never
overflows and runs until `TimeoutExceeded`.

Earlier versions of the patch got settlement wrong in both directions. Making every settling fiber
take the turn ran a resolved `new Promise`'s reactions after continuations queued later:
`new Promise((r) => r())` followed by `.then(() => { x = 1 })` and `await null` read 0, not 1.
Letting combinators settle without the turn ran their reactions inside a preempted job: in
`Promise.race([thenable]).then(…)` beside an async function that awaits twice, the reaction ran
between the function's two continuations instead of after both.
The first version of the depth limit counted fibers, not calls: each level of an async generator
chain counted its `next()` promise and its body, so 1,000 levels of `yield*` failed. It also
checked the limit after a generator step had marked the generator started or taken its parked
body's wake, so a step that failed there left no body to answer, and the generator's next step
waited forever.

The patch leaves these differences from JavaScript as they are on the unpatched package:

- Adopting a promise (`resolve(promise)`, an async function or `.then` handler returning one)
  settles one job earlier.
- `Promise.all([])`, `Promise.allSettled([])` and `Promise.any([])` settle one job later.
- After `break` in `for await` over an async generator, the loop's function resumes one job late.

Upstream's own suites from the `codemode-bigint`, `internal-mcp-codemode-defaults` and
`codemode-structured-clone` branches (1,095, 1,038 and 1,008 tests, including test262 generator and
promise ordering cases) give the same per-test results before and after the patch. A differential
suite of 44 programs, run in Node and in the interpreter, covers the ordering cases above, each
combinator beside a preempted job, and the lost updates; all match Node. The
`mcp-execute-concurrency` scenarios run the reported program and variants on each product, and
compare the ordering and combinator cases with Node's results. Their recursion scenarios check
the nesting-depth error and a 1,500-call chain that returns. Their call depth scenarios check that
a generator whose step failed at the limit still answers, and that `yield*` chains of 1,000 levels
and of exactly the limit return.

The turn costs some speed. In Node microbenchmarks on one host (medians of 7 alternating runs, two
passes, and 15 for the call and generator cases), 10,000 sequential awaits took 16–24% longer,
3,000 `.then` reactions 36–42%, 3,000 combinators 21–39%, async generator loops and `yield*`
chains 13–28%, and 1,000, 4,000 and 16,000 concurrent tasks with two awaits each 57–58%, 63% and
71–77% longer. Peak RSS for the 16,000 tasks rose from 328–359 MiB to 484–491 MiB. After five such
runs in one process the live heap stays near its starting size (31 MiB), but RSS stays at 519 MiB
against 377 MiB unpatched. Many short jobs cost the most: once a job is preempted, each waiting job
resumes through one more scheduler step. Counting calls for the depth limit costs what counting
fibers did: chains of 90 async calls took 14–23% longer than unpatched and chains of 1,000 9–17%.
Workerd was not benchmarked.

Remove the hunks when a codemode release runs program jobs to completion.
