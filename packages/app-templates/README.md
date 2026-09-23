# App templates

Generate ordinary source files, then pass `files` to `executor.apps.deploy`.
The SDK runtime does not dispatch on a protocol or depend on this package.

- `src/contracts/`: generator inputs, errors and OpenAPI parsing.
- `src/implementation/remote.ts`: HTTP MCP and GraphQL app/provider declarations.
- `src/implementation/stdio.ts`: local MCP app/provider declarations.
- `src/implementation/openapi.ts`: API definition to operation metadata and app declarations.

Generated entry points import helpers from `apps/mcp`, `apps/mcp/stdio`,
`apps/graphql`, or `apps/openapi`. Helpers are maintained in `packages/apps`;
we do not copy their implementation into each deployment. App/provider source
and OpenAPI's `operations.json` remain editable.

Every template includes `package.json` with an npm-safe name derived from the
import name. An explicit scoped name is preserved. `defineApp` declares behavior
without a name; renaming an installed app does not edit its package metadata.
Hosted import flows add the authenticated organization’s handle before saving
these generated files: `@organization/app-name`. Local generation has no publishing
handle. Public listings still require an owned `@scope/name`.

MCP and GraphQL templates include only their required optional peer in the
manifest: `@modelcontextprotocol/sdk` or `graphql`. OpenAPI needs no extra
dependency. The host supplies `apps` and Effect; the runtime resolves optional
peers from the app's own retained dependency installation.

Discovery runs with the selected account during evaluation. OpenAPI uses
retained operations and filters by the selected authentication method.
Nothing here caches accounts or catalogs. Helpers use Effect internally and
expose Promise APIs. HTTP MCP never imports the stdio process adapter.

The product owns catalog lookup, overrides, authentication detection and deployment.
The `probe` subpath reuses `apps/mcp/effect` for native read-only discovery during import.

Existing deployments keep their immutable source and builds. Importing an app
again generates the current template; this change does not rewrite user source.
