# Skills a server reads per request

Effect 4.1.4's `McpServer` serves the Agent Skills registered with
`McpServer.skill` (the MCP Skills extension, SEP-2640) when the server is built,
the same for every caller. Executor's MCP server is shared by every caller of a
host, and each caller sees different apps, so its skills can only be read on a
request, as that caller.

`effect@4.1.4.patch` adds `McpServer.skillCatalog({ list, get, read })` and its
`SkillCatalog` type, in source, distributed JavaScript and declarations. It
changes `ai/internal/mcpCore`, `ai/internal/mcpSkills` and `ai/McpServer` only:

- `list` returns every skill the caller is served, each as `McpServer.skill`
  takes it: the URI of its `SKILL.md` and its files. It runs on `skills/list`.
- `get(uri)` returns the skill whose `SKILL.md` is at `uri`, or `undefined`. It
  runs on a `skills/get` no registered skill answers, so one skill is answered
  without listing the others.
- A `resources/directory/read` inside a catalog skill finds that skill with
  `get`, asking each enclosing `SKILL.md` URI from the outermost in, so a
  directory read does not depend on what a listing left out. Only a directory
  above every skill, such as a namespace prefix, is read from `list`.
- `read(uri)` returns one file, or `undefined`. It runs on a `resources/read`
  that no registered resource or resource template answers, and never for a URI
  inside a registered skill's directory, which is that skill's alone.
- Each runs with the request's `McpRequestContext` and the services of the
  layer that registers the catalog, as `McpServer.events` handlers do. MCP
  middleware and visibility do not run for them: the server reads the caller
  itself.
- Each listed skill is checked as `McpServer.skill` checks it, and its manifest
  (each file's SHA-256 digest and size) is computed from its bytes, for that
  request only. A skill that breaks the extension's rules, or whose directory is
  or overlaps a registered or an earlier listed skill's, is left out with a
  warning, so one skill cannot fail a listing.
- With a catalog the server declares the Skills extension (`directoryRead`) and
  the `resources` capability. Catalog files are not listed by `resources/list`.
- A server has one catalog; registering another replaces it.

The same lines serve every protocol revision: the earlier revisions' skill
handlers already call the core's `skills.list`, `skills.get` and
`skills.readDirectory`, which now include the catalog.

Remove this part when an Effect release serves skills per request.
