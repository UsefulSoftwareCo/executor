# Codemode lets the host serve the global search()

`@opencode-ai%2Fcodemode@0.0.0-dev-19272.patch` also adds a `search` option to `CodeMode.make` and
`CodeMode.execute`. When it is set, the program's global `search()` calls it instead of ranking the
runtime's own index, which renders every tool's signature.

The option replaces only the built-in tool's `execute`. Its input is still decoded with the built-in
`SearchInput` and its result with `SearchOutput`, so the function keeps `searchSignature`:
`{ query?, namespace?, limit?, offset? }` in, and `{ items: { path, description, signature }[],
remaining, next: { offset } | null }` out. The call is still recorded as a tool call named `search`
and counts toward the tool-call limit. The option's types are exported as `CodeMode.Search`,
`CodeMode.SearchRequest` and `CodeMode.SearchPage`.

`execute` serves `search()` from the backend search that `tools.search` uses: Postgres BM25 over the
caller's reachable targets, with the same scopes and authorization, and the same exact-path and
namespace handling. Its items are CodeMode's: the tool expression, the whole description and the
full signature, rendered only for the items on the page, which ends at the same byte budget as a
`tools.search` page. A program that uses `search()` therefore loads no app's tool listing for it.
The runtime's index is built only when a program calls `search()` without the option, so `execute`
never builds it.

`executor.codemode.signatures_rendered` on `mcp.execute` adds the signatures `search()` pages
rendered to the runtime's own count.

The `mcp-execute-lazy` scenario "MCP execute serves CodeMode's search() from the backend search,
loads no tool listing for it, and loads only a called result's app" checks the shape, paging and
that the request has no `mcp.discovery.tools` span. Without the patch, the option is ignored and the
runtime's index loads nothing, so the search finds no tool and the scenario fails.

Remove the hunks when a codemode release lets the host serve `search()`, and use its interface.
