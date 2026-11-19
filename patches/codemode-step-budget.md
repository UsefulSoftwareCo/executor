# Codemode step budget

`@opencode-ai%2Fcodemode@0.0.0-dev-19272.patch` adds `maxSteps` to `ExecutionLimits`: the number
of statements and expressions one program may evaluate, across all of its functions, promise jobs
and generators. Executor passes `McpLimits.maxSteps` (5,000,000 by default; self-host and local
read `EXECUTOR_MCP_MAX_STEPS`).

The interpreter runs on the product's own thread, about a thousand times slower than native code.
Its only budgets were wall time (`timeoutMs`, five minutes) and tool calls. On Nov 18 2026 one
production program spent about 203 s in the interpreter with no tool calls, inside its five
minutes, and the product isolate stayed near 100% CPU throughout. Effect preempts the program's
fiber every 2,048 operations, so other requests still ran, but slowly, and clients gave up.

`StepBudget` (`interpreter/model.js`) is shared by every `Interpreter` of one execution, as
`invokeFunction` creates one per call. `evaluateStatement` and `evaluateExpression` count one step
each before they dispatch. A tool call, an approval or a timer evaluates nothing while it waits,
so only interpreter work counts. Steps, not CPU time: workerd's clock does not advance while code
runs, and a count gives the same answer on every host and under any load.

Past the limit, every step throws `StepBudgetExceeded`, an `InterpreterRuntimeError` of kind
`TimeoutExceeded` whose message names the budget and asks for heavy computation to move out of
the program. `try` hands it on without running `catch`, and because each later step throws again,
a `catch`, `finally` or promise reaction cannot keep the program running. Execute reports it with
the line it stopped at, and keeps that message instead of its wall-time timeout message.

Counting adds no measurable time: a 300,000-iteration loop took a median of 1,356-1,372 ms patched
against 1,331-1,363 ms unpatched in Node (7 runs each).

The default comes from the incident. Measured on one host, the interpreter runs about 550,000
steps a second in workerd (the runtime of the self-host image and Cloud), about 2 million in Node
and about 0.9 million in the Bun self-host e2e server. Ordinary programs spend 0.1-0.5 s before
their first tool call; the runaway spent 203 s, about 110 million steps in workerd. 5,000,000 steps
is about 9 s in workerd, near the geometric middle: 18 times the slowest ordinary program and 22
times less than the runaway. Counted programs: a 100,000-iteration `for` loop is 800,000 steps,
filtering and mapping 10,000 records 177,000, the `mcp-execute-concurrency` reporter program
about 400,000 and its 1,001 x 300 loop reference about 1.5 million.

## Native calls and operators

A native method can do far more work than the step that calls it: `s.split("")` on a 1 MB string
is one step, but returns a million-element array that codemode then copies. Before native calls
were charged, a loop of them ran 83 s inside a 5,000,000-step budget. `invokeCallable` is the
one place every call goes through, so it charges there. Calls that run program code or wait on the
host (tools, program functions, promise and generator methods, `tools.search`) count their own
steps and are not charged. Every other call is charged with `StepBudget.charge`:

- before it runs, for its input: the receiver of a method and the string arguments of a method;
  every argument of a global function (`JSON`, `Object`, `Array`, `Math` and the like), except
  `Object.assign`'s target, which it only writes, and `Object.hasOwn` and `Array.isArray`, which
  read one key or the type. This stops a call whose input is already too large before it starts.
- after it returns, for its result, but only when the result is new. A result the program
  already holds is not charged: the method's own receiver (`Map.set`), one of its arguments
  (`Object.assign`), or an element or accumulator (`Map.get`, `at`, `pop`, `shift`, `find`,
  `findLast`, `reduce`). `sort`, `reverse` and `fill` return their array and are charged for it
  again, for the pass. Before this, `g.get(k)` was charged for the whole group each time, and
  grouping 50,000 rows into 10 or 50 groups stopped at the budget in under a second.
- spread arguments, array spread and object spread, and the arguments and result of `new`, at the
  same rate. Spread and `new Set` or `new Map` take a string one character at a time, so there a
  string costs one step per 2 characters.

Operators and patterns that read a whole value are charged too:

- Binary operators other than `===` and `!==`, and unary `+`, `-` and `~`, walk their operands to
  reject interpreter references before coercing them. The walk is charged as it goes, one step
  per 2 values visited, so it stops partway once the budget is spent. Primitives skip it.
- `in` reads one own key, so it only checks that its right-hand object is data and does not walk
  it. Before this, `id in index` walked the whole index on each check, and merging 20,000 records
  into a 20,000-record index ran to its wall time. It no longer throws when the object holds a
  function somewhere inside; it still does when the object itself is one.
- Comparing two strings is charged one step per 256 characters it may read: equal lengths for
  equality, the shorter length for `<`, `<=`, `>` and `>=`.
- `+` that yields a string is charged one step per 4,096 characters of its result, and so are
  `+=` and a template literal. The engine joins strings as a rope, so the join itself is cheap, but the next read of the
  result copies all of it: `t = s + i` on a 1 MB `s` followed by `t.charCodeAt(…)` copied 1 MB per
  step and ran to the wall time; it now stops in about 1.5 s. The rate is per 4,096 rather than
  256 because building output with `out += line` is charged its whole length on every append,
  which grows with the square of the line count: a 554 KB report of 5,000 lines costs 0.43
  million steps, and about 18,000 lines (2.2 MB) spend the default budget. Collect lines in an
  array and `join` them instead, which is charged once.
- Storing a value walks it to reject cycles: assignment to a property or index, `push`,
  `unshift`, `splice`, `fill` and `Object.assign`. `switch` walks its discriminant and case
  values to reject interpreter references. Both walks are charged as they go, one step per 2
  values visited. The store walk also remembers every object whose whole graph it has checked
  and stops there next time, as the container it looks for is never inside one. An object holding
  no objects stays remembered until an object is stored into it. Any other object is remembered for
  the current epoch: storing an object into a remembered object that another remembered object
  holds starts a new epoch, which forgets every non-leaf object at once, because their graphs may
  now reach the new value. Every store into existing data runs this walk first, so the walk still
  finds every cycle; a differential fuzz of 3.9 million stores against a fresh reachability check
  agreed on all of them, and fails at once when the epoch is not advanced. The one store that
  skips the walk is a property or index assignment of the value the slot already holds, which
  cannot change the graph: `g[k] = g[k] || []` followed by `g[k].push(row)` walked the whole group,
  every row in it, on every row, and grouping 50,000 row objects stopped at the budget in about 2 s.
  Before this, attaching one shared `meta` of 50,000 columns to each of 20,000 rows walked all the
  columns on each store, uncharged, and ran for minutes; it now takes 0.3 s. A shared `meta` of
  1,000 records, each an object, was walked record by record on every store, about 500 steps
  each and 10 million for 20,000 rows, and stopped at the budget in about 1 s; it is now walked
  once and the 20,000 stores take 0.25 s in Node. Grouping 50,000 rows into an object with `a = g[k] || []; a.push(v); g[k] = a` walked
  each group on each store; it now takes 0.7 s. A program that changes the shared value between
  stores, such as setting `meta.records[i].seen` for each row, still has it walked again on each
  store, one step per 2 records.
- A template interpolating an array or object is charged for copying and joining it.
- Rest patterns: an object rest is charged for the object, an array rest one step per element it
  takes. `for...in` is charged for its key list.

Data costs one step per 2 array elements, object keys or `Map` and `Set` entries, and one per 256
string characters. An array of records or arrays counts each element as wide as the widest of up
to 8 evenly spaced elements, up to 64, because copying a result walks every field. Other values
(numbers, functions, class instances) cost nothing. Some methods are charged differently:
methods whose work is bounded by their result (`slice`, `substring`, `at`, `push`, `pop`,
`concat` and similar) charge only their result, so loops that call them stay linear; `indexOf`,
`includes` and `lastIndexOf` charge one step per 512 elements or characters they can scan from
their start position; `normalize` and `localeCompare` charge 8 times their receiver.

One native call still runs to its end before its result is charged; codemode cannot interrupt it.
Its input is charged before it runs, so the largest single call a program can make is bounded by
data it already paid to build, and the next step after an overrun stops the program.

### Not charged yet

These still run work the budget does not see, and are left for a follow-up:

- A backtracking regular expression. Its input is small, but `/^(a+)+$/` on a 25-character string
  can take tens of milliseconds per match, and a loop of 1,000 such matches runs to the wall time
  (44 s in Node, inside its 60 s). Codemode has no backtracking limit to set, and refusing nested
  quantifiers would refuse ordinary patterns.
- Walks that reject interpreter references and are not metered: `++` and `--` on a value held in
  a property (`o.x++` with `o.x` a million-element array walks it every time), the entries
  `Object.fromEntries` reads, and the non-string arguments of string methods (`"a".padEnd(1, big)`).
  A loop of each of these with a million-element array runs to its 30 s wall time.
  `console.table` and `Object.is` walk too, but are already stopped by the charge for their
  arguments.
- A shared value made of many small records is walked in full on every store, because only
  objects holding no objects are remembered: attaching a 1,000-record `meta` to each of 20,000
  rows stops at the budget in about 2 s.
- Not a hole, but worth knowing: grouping with `g[k] = (g[k] || []).concat([v])` copies the group
  on every row and is charged for it, so 50,000 rows in 10 groups stop at the budget in under a
  second. `push` into the group instead.

Hot loops cost about what they did on `main`; primitives skip the operand walk. Medians of 7 runs
in Node 24 (base is `main`'s patch, previous is the version before store walks and string `+`
were charged):

| Loop (100,000-300,000 iterations)         | base ms | previous ms | now ms |
| ----------------------------------------- | ------: | ----------: | -----: |
| `s += i % 7`                              |   1,370 |       1,291 |  1,283 |
| comparisons and `in`                      |     884 |         790 |    780 |
| `push`, `Math.max` and `slice` every turn |   1,667 |       1,710 |  1,713 |
| `o.x = {v: i, t: [i]}` and `a[0] = i`     |   1,109 |       1,134 |  1,129 |
| `s = 'key-' + i + '-' + (i % 7)`          |     768 |         703 |    714 |

The rates were measured with each workload looped under the default 5,000,000-step budget until it
stopped, on one host (wall seconds of one program; in workerd, one request with nothing else
running). Most setups build a million-element array with `Array.from` and a mapper, a million
callback calls; callbacks cost about twice a loop step in workerd, so that setup alone takes up
to 7 s there.

| Workload                                         | Node 24 s | Bun s | workerd s |
| ------------------------------------------------ | --------: | ----: | --------: |
| pure interpreter loop                            |      1.68 |  0.78 |      8.53 |
| `split("")` of 1 MB (round 0 PoC)                |      1.23 |  2.80 |      0.98 |
| `JSON.stringify` 20k records + `includes`        |      2.74 |  0.90 |      2.30 |
| `JSON.parse` of 1.3 MB                           |      1.77 |  0.98 |      1.84 |
| `join` of 1M elements                            |      5.61 |  4.18 |     11.61 |
| `Object.keys` of 100k keys                       |      1.71 |  1.30 |      2.64 |
| spread of 1M elements                            |      5.15 |  2.68 |     14.87 |
| `replaceAll` on 1 MB                             |      3.92 |  3.30 |      8.03 |
| `JSON.stringify` of `[0, ...20k 200-key records]` |      6.76 |  3.73 |      6.08 |
| `includes` on 1M strings                         |      7.16 |  5.95 |     15.17 |
| `normalize` of 1M characters                     |      1.19 |  2.80 |      1.24 |
| `"zz" in` a 200k-key object                      |      2.56 |  1.25 |      8.68 |
| `a == "x"` on 1M elements                        |      6.02 |  4.76 |     11.96 |
| `"" + a` on 1M elements                          |      5.96 |  4.60 |     11.84 |
| template of 1M elements                          |      5.25 |  3.42 |     11.18 |
| `===` of two 4 MB strings                        |      0.05 |  0.05 |      0.05 |
| `<` of two 4 MB strings                          |      0.04 |  0.07 |      0.07 |
| `[x, ...r] = ` 1M elements                       |      4.92 |  2.66 |     13.16 |
| `{k0, ...r} = ` 100k keys                        |      4.07 |  1.28 |      4.24 |
| `for...in` 200k keys, then `break`               |      1.91 |  0.86 |      4.34 |
| `new Set` of a 1M-character string               |      0.59 |  0.35 |      5.47 |

On a quiet host every workload above stops within about 7.5 s in Node and Bun and about 15 s in
workerd, where the interpreted loop alone takes 8.5 s; the ones above 8.5 s spend most of it
building their input with callbacks. Under load the same programs take longer: the reviewer, with
other programs running, saw 8.3 to 9.6 s in Bun, and a loop that sorts a million-element array in
place with a comparator, a callback per comparison, takes 10 to 16 s. These stop at the budget all
the same; what they take is the steps per second the host gives them. Ordinary programs fit, with the steps they are charged: grouping 50,000 rows with
`Map.get` 1.48 million whatever the number of groups; merging 20,000 records with `in` 0.85
million (with `Object.hasOwn` 0.63 million); filtering and mapping 20,000 records 0.49 million;
splitting and matching 20,000 log lines 0.48 million; and a comparator `sort` of 50,000 objects
3.9 million (17 s in workerd, where every comparison is a callback). A comparator `sort` of
100,000 objects needs about 20,000,000 steps, so the default stops it; self-host and local raise
the budget with `EXECUTOR_MCP_MAX_STEPS`.

Remove the hunks when a codemode release has a step or CPU budget.
