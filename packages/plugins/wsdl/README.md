# WSDL / SOAP plugin

Import a self-contained WSDL contract in **Add integration → WSDL / SOAP**, or
call the `wsdl.addIntegration` SDK extension / static tool. Create a connection
against the integration to expose one tool per operation. Tool calls take
`{ body: ... }`, where `body` is the selected input element's value.

```ts
import { IntegrationSlug } from "@executor-js/sdk";
import { wsdlPlugin } from "@executor-js/plugin-wsdl";

// Include wsdlPlugin() in your executor's plugins.
const addOrders = executor.wsdl.addIntegration({
  slug: IntegrationSlug.make("orders"),
  name: "Orders",
  wsdl: contractXml,
  service: "Orders", // required when service/port selection is ambiguous
  port: "OrdersPort",
  // endpoint: "https://example.com/soap", // optional override
});
```

The SDK extension returns an Effect; compose it with your application's Effect
runtime to execute it. The HTTP variant is `wsdlHttpPlugin`
from `@executor-js/plugin-wsdl/api`, with `POST /wsdl/integrations`.

## Supported profile

- WSDL 1.1, SOAP 1.1 with UTF-8 XML over HTTP(S), document/literal request-response operations.
- One element body part per input/output; wrapped and bare bodies retain their
  declared XML shape. Service and port selection use their local names.
- Inline XSD schemas, global element references, named or inline complex types
  with sequences, optional/repeated elements, and nillable values.
- XSD `string`, `boolean`, `int`, `integer`, and `decimal`. Unbounded integers
  and decimals use validated JSON strings, preserving precision.
- SOAP faults become tool failures, including on HTTP error statuses.
- SDK/API registration accepts shared `authenticationTemplate` entries of kind
  `apikey` (header/query placements) or `none`. Credentials come from Executor
  connections. The initial import form creates an unauthenticated integration.

Unsupported contracts fail import: external WSDL/XSD imports/includes, WSDL 2,
SOAP 1.2, RPC/encoded bindings, attachments, SOAP header bindings, WS-Security,
recursive types, and XSD constructs outside the profile above. Fault details
are not decoded into typed values. No automatic SOAP calls are used as health
checks, and all operations require approval by default.

XML rejects DTD/entity declarations, limits input/response size to 2 MB, depth
to 64, and elements to 50,000. Expanded schemas are limited to 10,000 elements
and 32 levels; repeated fields permit at most 10,000 values. HTTP calls use the
host's injected Effect HttpClient, a 110-second deadline, and no automatic retry.

## Development

Run `bun run typecheck` and `bun run test` from this package. The cross-target
browser scenario is `e2e/scenarios/wsdl-integration.test.ts`.

Protocol references: [WSDL 1.1](https://www.w3.org/TR/wsdl.html) and
[SOAP 1.1](https://www.w3.org/TR/2000/NOTE-SOAP-20000508/).
