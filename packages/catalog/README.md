# Catalog

Shared catalog lookup and quick-add preparation for the local and hosted
products. Preparation returns ordinary source files. It does not install an app,
choose an owner or workspace, connect an account, or apply product permission rules.

```ts
import { createCatalog } from "@executor-js/catalog";

// The host's egress, and the Client ID Metadata Document its account setup uses, if any.
const catalog = createCatalog({ egress, clientMetadataUrl });
const entries = yield * catalog.list;
const prepared = yield * catalog.prepare({ entry: selectedEntry.id });

// The product decides where and whether to install prepared.files.
```

Only MCP servers are prepared here, and only when the server itself confirms how
to connect: anonymous `initialize` and `tools/list` succeed, or the server
rejects anonymous use and advertises OAuth that the SDK can discover.
`detectMcpAccess` returns that typed decision with the signals behind it. It
inspects OAuth with account setup's own discovery and checks, and reports how
that host's setup would obtain a client. Every
other entry, and any MCP server that needs an API key or other setup, fails with
`agent_setup_required` and, for an MCP server, its detection. Products show a copyable prompt for the user's agent,
which writes the app with the app-authoring skill instead of guessing from
catalog hints.

These operations are Effects. Constructing a catalog does no I/O. Each `list`
or `prepare` evaluation reads the source; there is no retained catalog cache.
Pass a `CatalogSource` to `createCatalog` to use another feed or fixture.
Run the [example](../../playground/catalog/prepare.ts) with
`bun run --cwd playground/catalog start` from the repository root, and the
read-only [sweep of public servers](../../playground/catalog/sweep.ts) with
`bun run --cwd playground/catalog sweep`.

`catalog.custom(input)` prepares an MCP server a user entered by URL, with
the same check.

## Read the code

- `src/contracts/catalog.ts`: entries, quick-add rule, prepared files, and source interface.
- `src/contracts/imports.ts`: the custom MCP URL input, without credentials.
- `src/implementation/catalog.ts`: catalog construction. Source generation loads on the first
  `prepare` or `custom` call.
- `src/implementation/prepare.ts`: catalog selection and preparation.
- `src/implementation/source.ts`: the integrations.sh feed.
- `src/implementation/overrides.ts`: catalog defaults, including PostHog's tool mode.
- `src/contracts/detection.ts`: detected outcomes and their signals.
- `src/implementation/detection.ts`: the MCP connection check.
- `src/implementation/mcp.ts`: outcome reasons and source generation.
- `src/implementation/custom.ts`: a user-entered MCP URL.

`@executor-js/catalog/contracts` is the schema-only entry point for forms and
product HTTP contracts. It does not import the network or template implementations.
