# Catalog

Shared catalog lookup and preparation for the local and hosted products. The
catalog lists Executor's official apps from a feed, and preparation returns
their ordinary source files. It does not install an app, choose an owner or
workspace, connect an account, or apply product permission rules.

```ts
import { createCatalog } from "@executor-js/catalog";

// The host's egress, the feed's index.json, and the Client ID Metadata Document its account
// setup uses, if any.
const catalog = createCatalog({ egress, feedUrl, clientMetadataUrl });
const entries = yield * catalog.list;
const prepared = yield * catalog.prepare({ entry: selectedEntry.id });

// The product decides where and whether to install prepared.files. An official app carries
// prepared.origin and is installed as a copy, the way a published app is.
```

## The feed

Official apps are vetted `@executor.sh/<service>` packages in the integrations
repository. Its `scripts/feed.ts` writes a static feed: `index.json` lists each
app's id, package, title, description, auth methods, category and icons; `apps/<id>.json` holds the app's complete source; icons are
files beside them. Paths in the index are relative to it. Hosts read the feed at
`EXECUTOR_CATALOG_URL`. Without one, the catalog lists no feed apps.

An entry may include `connectionNotices`, an array of `{ providerName, message }`
records. `providerName` matches the provider definition's display name. Hosts
show each message before a person chooses to connect. These notices are operator
metadata: they do not change app source or provider identity. Entries without
the field keep the usual connection flow.

Every entry installs directly: nothing has to be guessed, because the package
already declares its providers and auth methods. The user connects an account
through the app's own providers after install. Preparation reads the index
again, fetches the app's source and checks that its `package.json` names the
listed package. Redirects are not followed, and nothing is cached between
reads.

`catalog.custom(input)` prepares a remote MCP server a user entered by URL. It
is added only when the server itself confirms how to connect: anonymous
`initialize` and `tools/list` succeed, or the server rejects anonymous use and
advertises OAuth that the SDK can discover. `detectMcpAccess` returns that typed
decision with the signals behind it. It inspects OAuth with account setup's own
discovery and checks, and reports how that host's setup would obtain a client.
A server that needs an API key or other setup fails with `agent_setup_required`
and its detection; products show a copyable prompt for the user's agent. The
refusal also carries the steps as `recovery`, so an agent that calls the import
itself gets them, and so does an install whose entry is a URL or is not listed.
`filterCatalog` applies a product's `search` and `limit` filters to a listing.

These operations are Effects. Constructing a catalog does no I/O. Pass a
`CatalogSource` to `createCatalog` to use another feed or fixture. Run the
[example](../../playground/catalog/prepare.ts) with
`bun run --cwd playground/catalog start` from the repository root, and the
read-only [sweep of public servers](../../playground/catalog/sweep.ts) with
`bun run --cwd playground/catalog sweep`.

## Read the code

- `src/contracts/catalog.ts`: entries, listing filters, the feed's wire format, prepared files, and
  source interface.
- `src/contracts/setup.ts`: the recovery steps refusals carry.
- `src/contracts/imports.ts`: the custom MCP URL input, without credentials.
- `src/implementation/catalog.ts`: catalog construction. The MCP source generator loads on the
  first `custom` call.
- `src/implementation/source.ts`: the official app feed.
- `src/implementation/overrides.ts`: custom MCP URL defaults, including PostHog's tool mode.
- `src/contracts/detection.ts`: detected outcomes and their signals.
- `src/implementation/detection.ts`: the MCP connection check.
- `src/implementation/mcp.ts`: outcome reasons and source generation.
- `src/implementation/custom.ts`: a user-entered MCP URL.

`@executor-js/catalog/contracts` is the schema-only entry point for forms and
product HTTP contracts. It does not import the network or template implementations.
