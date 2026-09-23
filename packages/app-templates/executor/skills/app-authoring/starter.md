## Start from a checked example

For a small UI with stored records, such as a todo list or inbox, adapt the
`live-inbox` example returned by `framework_describe`. It includes a database,
typed query and mutation, shared schemas, React UI, live subscription,
optimistic insertion, HTML, styles and package dependencies. Reuse those files
instead of reconstructing the framework setup. Choose another approach when
the requested app does not fit this example.

Discover the management app's `framework_search` and `framework_describe`
through `tools.search`. Search for `apps/client.createAppClient`, then describe
that symbol with the search result's `version` and `digest`. Read the complete
`live-inbox` entry in `examples`, including its `files`. Keep this reference
identity when fetching it again; a different pinned package needs its own
reference.

Adapt the table, shared row schema, operations and UI to the requested behavior.
Keep the type-only server imports, stable query atom and shared output schemas.
Use [tools.md](tools.md) for new operations, [storage.md](storage.md) for new
data access, and [ui.md](ui.md) for React and optimistic behavior. The example's
insert-only list does not demonstrate actions on a row that is still being
created; read the temporary-ID guidance before adding edit or delete controls.

## Carry source forward

The example's `files` already has the `{ path, content }` shape accepted by
management tools. After reading the source, fetch the same reference and apply
your edits to those files inside `execute`. Pass the resulting file array
directly to the discovered create operation. Read [deploy.md](deploy.md) for
the draft, commit and deployment flow. Return the resulting IDs and URL, rather
than printing unchanged source and writing it back into another tool call.

For later changes, fetch the app's current working source and transform only
the affected files. Submit the complete file list with its expected revision.
An `execute` call does not retain variables for the next call; fetch the source
again when needed. Preserve unrelated files and edits.

If local files are useful, keep one working copy and serialize their content
with JSON when preparing a tool payload. Do not rewrite valid TypeScript just
to remove backticks or `${...}`. See the source transport guidance in
[deploy.md](deploy.md).
