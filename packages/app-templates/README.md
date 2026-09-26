# App templates

Generate ordinary source files, then pass `files` to `executor.apps.deploy`.
The SDK runtime does not dispatch on a protocol or depend on this package.

- `src/contracts/templates.ts`: generator errors.
- `src/implementation/mcp.ts`: a remote MCP app whose connection was confirmed:
  public, or OAuth discovered from the server.
- `executor/`: the built-in Executor app's skills and framework reference.

The product decides that a server qualifies before calling the generator; see
`@executor-js/catalog`. Every other service, including OpenAPI and GraphQL APIs,
MCP servers that need API keys, and local processes, is written by the user's
agent with the app-authoring skill and the `apps/openapi`, `apps/graphql`,
`apps/mcp` and `apps/mcp/stdio` helpers. Nothing here guesses a service's
authentication from catalog hints.

Generated source includes `package.json` with an npm-safe name derived from the
import name. An explicit scoped name is preserved. Hosted import flows add the
authenticated organization’s handle before saving these files:
`@organization/app-name`. The manifest declares `@modelcontextprotocol/sdk`; the
host supplies `apps` and Effect.

Discovery runs with the selected account during evaluation. Nothing here caches
accounts or catalogs. Existing deployments keep their immutable source and builds.
