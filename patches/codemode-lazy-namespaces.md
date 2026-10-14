# Codemode loads a namespace when a program first reaches it

`@opencode-ai%2Fcodemode@0.0.0-dev-19272.patch` also adds `Namespace.lazy({ load })`. A lazy
namespace starts with no tools. The runtime runs `load` when a program first reaches it, and adds the
tools it returns to that execution's tool tree; `undefined` leaves no such namespace.

`execute` used to load every app before a program ran whenever the program used `tools` other than
through static members (`tools[name]`, `Object.keys(tools)`, passing `tools` around). That decoded
every app's tool listing and built a CodeMode tool for each of them: in production about 5,350
tools per such execute, p50 8 s and p95 17 s, and three at once exceeded Cloud's 128 MB isolate
limit. With lazy namespaces, `execute` gives the program one lazy namespace per app it did not name
statically, and an app is discovered when the program first uses it.

The published runtime resolves tool paths in two places, and the patch makes both effects:

- A tool call resolves its path when it runs (`ToolRuntime.make`'s `execute`), which already is an
  Effect on the call's host fiber, without the program's turn. Resolution now loads each lazy
  namespace on the way to the tool first.
- `Object.keys(ref)` and `for (… in ref)` on a tools reference list its keys (`keys`). `keys` now
  returns an Effect that loads the namespace it lists, and the interpreter's `enumerableKeys`
  returns an Effect for every value. Listing the root lists namespace names and loads none.

Member access (`tools[name]`) only builds a reference, as before, so it loads nothing until the
reference is called or listed. Listing a namespace's keys holds the program's turn while it loads,
as any other synchronous expression does, so other program jobs do not interleave with it. Tool
calls run concurrently as before.

Errors are unchanged. A path below a namespace whose load returned `undefined` is unknown, with the
same `UnknownTool` messages as a path that was never declared: `Unknown tool 'a.b'.` for a call,
`Unknown tool namespace 'a'.` for its keys. A failed load fails the call or the listing like a tool
failure.

Fibers that reach a namespace before its first load finishes each run `load`; the first to finish
adds its tools and the others' results are dropped. `execute` caches each app's load per execution,
so concurrent first uses share one discovery.

The catalog (`CodeMode.make(...).catalog()`) and the built-in `search()` index hold only the tools a
namespace had when the runtime was made. `execute` reads neither: it serves `search()` itself (see
[codemode-host-search](codemode-host-search.md)).

The `mcp-execute-lazy` scenario "MCP execute loads an app a program reaches through dynamic access
to tools when it first uses it, and lists apps without loading them" checks that a computed member,
`Object.keys` and `for…in` load one app or none, through the request's `mcp.discovery.namespace`
and `mcp.discovery.tools` spans. Without the patch, `Namespace.lazy` does not exist and the
typecheck fails; a patch that loads nothing makes every dynamic call fail with `UnknownTool`.

Remove the hunks when a codemode release can resolve namespaces on demand, and use its interface.
