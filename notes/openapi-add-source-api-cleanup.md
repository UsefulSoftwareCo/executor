# OpenAPI Add Source API Cleanup Notes

Date: 2026-05-17
Status: planning

## Summary

The current OpenAPI add-source API mixes source ownership, source shape, and
credential binding values in one payload. That makes the common org-shared
source with per-user credentials hard to reason about. We want the immediate
cleanup to make the OpenAPI add endpoint explicit and remove duplicated scope
fields, without solving the larger per-user source/tool discovery model yet.

The product model for this pass is:

- OpenAPI source rows and tool definitions are shared at the org/workspace
  level in the web UI.
- Runtime credential values can vary by user or org, but they must match the
  shared source credential shape.
- Spec fetch credentials are source-definition credentials. If the shared spec
  URL requires auth, those credentials are part of maintaining the shared tool
  surface.
- Different auth structures should be different source instances, not
  different per-user modes inside one source.

## Current Problems

`POST /scopes/:scopeId/openapi/specs` currently accepts `targetScope` in the
payload, duplicating the URL `scopeId` for web usage. The endpoint handler maps
`payload.targetScope` to SDK `scope`.

The payload also accepts `credentialTargetScope`, which is a fallback for direct
secret inputs that do not carry their own binding scope. This is especially
visible in `specFetchCredentials`, where the UI currently serializes direct
secret refs without per-entry scope.

`spec` is a plain string that can mean either:

- an HTTP URL to fetch, or
- raw OpenAPI JSON/YAML text.

`name`, `namespace`, and `baseUrl` are optional in the SDK because they can be
derived from the spec. That is convenient for internal/programmatic callers, but
the web/API boundary already has explicit user-facing values after preview.

## Immediate Endpoint Direction

For the HTTP/web add endpoint:

```txt
POST /scopes/:scopeId/openapi/specs
```

`scopeId` should be the source owner scope. Remove payload `targetScope`.

Make the identity and request base explicit:

```ts
{
  spec: OpenApiSpecInput;
  name: string;
  namespace: string;
  baseUrl: string;
  // source shape fields...
}
```

Use a discriminated spec input instead of a string that guesses:

```ts
type OpenApiSpecInput = { kind: "url"; url: string } | { kind: "blob"; value: string };
```

Remove `credentialTargetScope` from the HTTP payload. Scope should always be
explicit anywhere a concrete secret or connection value is written.

Keep SDK-level `scope` on `OpenApiSpecConfig`; non-HTTP callers still need to
choose where a source is added.

## Source Shape vs Values

The source shape is shared. Values can be bound per scope.

Source shape examples:

```ts
headers: {
  Authorization: {
    kind: "secret",
    prefix: "Bearer ",
  },
},
queryParams: {
  api_version: "2026-05-17",
}
```

This declares:

- every user of the source uses an `Authorization` header with a bearer prefix;
- the concrete token value is supplied separately;
- `api_version` is a shared literal source config value.

Under the hood, secret-shaped headers/query params still normalize to internal
source bindings:

```ts
headers: {
  Authorization: {
    kind: "binding",
    slot: "header:authorization",
    prefix: "Bearer ",
  },
}
```

Plain text values are not credentials. They can stay directly in source config.

Concrete values should be set through source value binding APIs. The existing
low-level operation is `setSourceBinding`; a later cleanup can add domain-level
wrappers such as `setHeaderValue` or `setQueryParamValue`.

## Example: Org Default With One User Override

```ts
const orgScope = ScopeId.make("org_123");
const aliceScope = ScopeId.make("user-org:alice:org_123");

const source = await executor.openapi.addSpec({
  scope: orgScope,
  spec: {
    kind: "url",
    url: "https://api.example.com/openapi.json",
  },
  name: "Example API",
  namespace: "example",
  baseUrl: "https://api.example.com",
  headers: {
    Authorization: {
      kind: "secret",
      prefix: "Bearer ",
    },
  },
  queryParams: {
    api_version: "2026-05-17",
  },
});

await executor.secrets.set({
  id: SecretId.make("example-org-token"),
  scope: orgScope,
  name: "Example org token",
  value: process.env.EXAMPLE_ORG_TOKEN!,
});

await executor.openapi.setHeaderValue({
  source,
  scope: orgScope,
  name: "Authorization",
  value: {
    kind: "secret",
    secretId: SecretId.make("example-org-token"),
    secretScope: orgScope,
  },
});

await executor.secrets.set({
  id: SecretId.make("alice-example-token"),
  scope: aliceScope,
  name: "Alice Example token",
  value: process.env.ALICE_EXAMPLE_TOKEN!,
});

await executor.openapi.setHeaderValue({
  source,
  scope: aliceScope,
  name: "Authorization",
  value: {
    kind: "secret",
    secretId: SecretId.make("alice-example-token"),
    secretScope: aliceScope,
  },
});
```

Resolution:

- Alice gets `Authorization: Bearer <alice token>`.
- Other users fall back to `Authorization: Bearer <org token>`.
- The source/tool definition remains org-scoped and shared.

## OAuth Shape

OAuth follows the same split. The source declares shared OAuth metadata:

- security scheme name;
- flow;
- authorization/token URLs;
- scopes;
- where client id/client secret/connection values are expected.

Then values are bound separately:

- OAuth app client id/secret can be org-level values.
- OAuth access/refresh token connection is commonly per user.

Conceptually:

```ts
const source = await executor.openapi.addSpec({
  scope: orgScope,
  spec: { kind: "url", url: "https://api.example.com/openapi.json" },
  name: "Example API",
  namespace: "example",
  baseUrl: "https://api.example.com",
  oauth2: {
    securitySchemeName: "oauth2",
    flow: "authorizationCode",
    authorizationUrl: "https://api.example.com/oauth/authorize",
    tokenUrl: "https://api.example.com/oauth/token",
    scopes: ["read", "write"],
  },
});

await executor.openapi.setOAuthClientCredentials({
  source,
  scope: orgScope,
  clientId: { kind: "secret", secretId: "client-id", secretScope: orgScope },
  clientSecret: { kind: "secret", secretId: "client-secret", secretScope: orgScope },
});

await executor.openapi.setOAuthConnection({
  source,
  scope: aliceScope,
  connectionId: aliceConnection.id,
});
```

The current implementation can continue using internal OAuth slots. The public
SDK does not need to expose those slots for the simple flow.

## Spec Fetch Credentials

Spec fetch credentials differ from runtime credentials because they may be
needed before the source exists.

For this immediate pass:

- keep spec fetch credentials on `addSpec`;
- treat them as source-definition credentials;
- make the UI use the same secret scope selection semantics as other secret
  inputs;
- remove `credentialTargetScope` by making any concrete spec fetch secret refs
  carry explicit scope information.

Longer term, if we want all persisted values to use bindings only, preview may
need either request-only credentials or callers must fetch private specs
themselves and pass `{ kind: "blob", value }`.

## Sharing Boundary

One source has one shared credential structure. Users can provide different
values for that structure, but they cannot change the structure per user.

Supported:

```txt
Source shape: Authorization header with Bearer prefix
Org value: shared token
Alice value: Alice token override
Bob value: Bob token override
```

Not supported as one source:

```txt
Alice uses Authorization: Bearer <token>
Bob uses X-API-Key: <key>
Carol uses OAuth
```

Those are different source instances, even if they point at the same OpenAPI
spec and base URL.

## MCP and Per-User Tool Discovery

MCP exposes a larger issue: some servers may return different tools or tool
descriptions based on the authenticated user. That means auth can affect
discovery, not just invocation.

This does not need to be solved in the OpenAPI add-source cleanup. Defer:

- per-user source rows;
- per-user tool discovery;
- MCP auth-dependent tool descriptions;
- template/materialization flows for user-bound discovery sources.

For now, keep OpenAPI on the stable shared tool surface model.

## Deferred API Cleanup

Leave `setSourceBinding` in place for edit/override flows for now. It is a
lower-level source value binding API and already supports text, secret, and
connection values.

A later public SDK cleanup can add domain-level wrappers:

- `setHeaderValue`;
- `setQueryParamValue`;
- `setSpecFetchHeaderValue`;
- `setSpecFetchQueryParamValue`;
- `setOAuthClientCredentials`;
- `setOAuthConnection`.

Those wrappers can map to internal binding slots without exposing slots to the
consumer-facing simple flow.
