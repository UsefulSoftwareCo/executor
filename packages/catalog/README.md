# Catalog

Shared catalog lookup and app preparation for the local and hosted products.
Preparation returns ordinary source files. It does not install an app, choose
an owner or workspace, connect an account, or apply product permission rules.

```ts
import { createCatalog } from "@executor-js/catalog";

const catalog = createCatalog();
const entries = yield * catalog.list;
const prepared = yield * catalog.prepare({ entry: selectedEntry.id, mcpAuth: "oauth" });

// The product decides where and whether to install prepared.files.
```

These operations are Effects. Constructing a catalog does no I/O. Each `list`
or `prepare` evaluation reads the source; there is no retained catalog cache.
Pass a `CatalogSource` to `createCatalog` to use another feed or fixture.

Run the [offline example](../../playground/catalog/prepare.ts) with
`bun run --cwd playground/catalog start` from the repository root.

`catalog.custom(input)` prepares MCP, OpenAPI, GraphQL, or stdio app source
from explicit configuration. Generating a stdio template does not run a process
or imply that a host supports it. Products decide which imports they offer.

## Read the code

- `src/contracts/catalog.ts`: entries, import choices, prepared files, and source interface.
- `src/contracts/imports.ts`: custom import configuration, without credentials.
- `src/implementation/catalog.ts`: catalog construction. Source generators load on the first
  `prepare` or `custom` call.
- `src/implementation/prepare.ts`: catalog selection and preparation.
- `src/implementation/source.ts`: integrations.sh feed and JSON/YAML downloads.
- `src/implementation/overrides.ts`: catalog defaults, including PostHog's tool mode.
- `src/implementation/mcp.ts`: MCP authentication discovery.
- `src/implementation/generate.ts`: spec overrides before OpenAPI generation.
- `src/implementation/custom.ts`: custom configuration to templates.

`@executor-js/catalog/contracts` is the schema-only entry point for forms and
product HTTP contracts. It does not import the network or template implementations.
Protocol source generation stays in `@executor-js/app-templates`.

The current network behavior is extracted from the local product. A hosted
product must establish its allowed network destinations and runtime capabilities
before exposing custom imports to untrusted callers. This pass does not claim
that an arbitrary URL or stdio command is safe to accept on a hosted server.
