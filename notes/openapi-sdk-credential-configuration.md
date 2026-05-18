# OpenAPI SDK Credential Configuration Notes

Date: 2026-05-17
Status: planning

## Summary

The SDK should present OpenAPI source onboarding as two explicit phases:

1. Add/import a shared source shape.
2. Configure scoped credential values for that source.

The internal implementation can still use source slots and scoped bindings,
but normal SDK callers should not need to think about `setSourceBinding`,
`connectionSlot`, `clientIdSlot`, `credentialTargetScope`, or plugin-specific
binding row shapes.

The product flow we want to preserve is:

```txt
Admin adds Stripe/Linear/GitHub once at org scope.
Org may set default credentials.
Each user can sign in or provide their own token.
The source and tools stay shared.
Credentials remain scoped and overridable.
```

## Core Vocabulary

**Source shape** is the shared definition:

- OpenAPI spec and extracted operations.
- Base URL.
- Declared headers and query params the source knows how to send.
- Selected OAuth method, if any.
- OAuth flow metadata such as authorization URL, token URL, and scopes.

**Scoped credential values** are the concrete values attached later:

- Bearer/API key token values.
- Header/query param text values.
- OAuth client ID and client secret.
- OAuth connection IDs.
- Spec-fetch credential values.

Source shape belongs to the source owner scope. Credential values belong to
the scope where they are configured and can inherit/override through the scope
stack.

## Public SDK Shape

The common bearer token flow should read like this:

```ts
const org = ScopeId.make("org_acme");
const user = ScopeId.make("user_rhys");

const source = await executor.openapi.addSpec({
  scope: org,
  name: "Stripe",
  namespace: "stripe",
  baseUrl: "https://api.stripe.com",
  spec: {
    kind: "url",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  },

  headers: {
    Authorization: {
      prefix: "Bearer ",
    },
  },
});

await executor.openapi.configure(source, {
  scope: user,
  headers: {
    Authorization: SecretId.make("stripe_api_key"),
  },
});
```

The caller should not pass:

```ts
kind: "binding";
slot: "header:authorization";
credentialTargetScope: user;
```

Those are internal implementation details.

## Strict Configure Semantics

`configure` fills declared holes in an existing source shape. It should not
create new source shape.

If the source was imported with:

```ts
headers: {
  Authorization: {
    prefix: "Bearer ",
  },
}
```

then this is valid:

```ts
await executor.openapi.configure(source, {
  scope: user,
  headers: {
    Authorization: SecretId.make("stripe_api_key"),
  },
});
```

This should fail:

```ts
await executor.openapi.configure(source, {
  scope: user,
  headers: {
    Username: SecretId.make("stripe_api_key"),
  },
});
```

because `Username` was not declared on the source. Allowing this would silently
write a binding for a value the source never sends.

Suggested error:

```txt
Unknown header "Username" for OpenAPI source "stripe".
Declared headers: Authorization.
```

The same rule applies to query params:

```ts
await executor.openapi.configure(source, {
  scope: user,
  queryParams: {
    api_key: SecretId.make("example_api_key"),
  },
});
```

should only succeed if `api_key` was declared in the source shape.

Adding or changing source shape should be a different operation:

```ts
await executor.openapi.updateSource(source, {
  headers: {
    Authorization: { prefix: "Bearer " },
    Username: {},
  },
});

await executor.openapi.configure(source, {
  scope: user,
  headers: {
    Username: SecretId.make("basic_username"),
  },
});
```

## Values Accepted By Configure

`configure` should accept ergonomic value inputs and normalize them to binding
values internally.

```ts
type OpenApiConfiguredCredentialValue =
  | string
  | SecretId
  | {
      kind: "secret";
      secretId: SecretId;
      secretScope?: ScopeId;
    }
  | {
      kind: "text";
      text: string;
    };
```

Examples:

```ts
await executor.openapi.configure(source, {
  scope: user,
  headers: {
    Authorization: SecretId.make("stripe_api_key"),
    "X-Workspace": "acme",
  },
  queryParams: {
    version: "2026-05-17",
  },
});
```

Internal binding writes:

```ts
setBinding({
  source: { pluginId: "openapi", id: "stripe", scope: org },
  scope: user,
  slot: "header:authorization",
  value: { kind: "secret", secretId: SecretId.make("stripe_api_key") },
});

setBinding({
  source: { pluginId: "openapi", id: "stripe", scope: org },
  scope: user,
  slot: "header:x-workspace",
  value: { kind: "text", text: "acme" },
});

setBinding({
  source: { pluginId: "openapi", id: "stripe", scope: org },
  scope: user,
  slot: "query_param:version",
  value: { kind: "text", text: "2026-05-17" },
});
```

## Org Default With User Override

```ts
const source = await executor.openapi.addSpec({
  scope: org,
  name: "Example API",
  namespace: "example",
  baseUrl: "https://api.example.com",
  spec: {
    kind: "url",
    url: "https://api.example.com/openapi.json",
  },
  headers: {
    Authorization: {
      prefix: "Bearer ",
    },
  },
});

await executor.openapi.configure(source, {
  scope: org,
  headers: {
    Authorization: SecretId.make("example_org_token"),
  },
});

await executor.openapi.configure(source, {
  scope: user,
  headers: {
    Authorization: SecretId.make("example_user_token"),
  },
});
```

Resolution:

```txt
User with user binding:
  Authorization: Bearer <example_user_token>

User without user binding:
  Authorization: Bearer <example_org_token>
```

The source and tools remain org-scoped. Only values vary by scope.

## OAuth Is Not Just A Header

OAuth eventually produces an `Authorization` header, but the setup is not just
"set the Authorization header value." OAuth has distinct source shape and
credential value concerns:

- The selected OpenAPI security scheme.
- OAuth flow.
- Authorization URL.
- Token URL.
- Issuer URL when relevant.
- Scopes.
- Client ID.
- Client secret.
- Connection ID.
- Token refresh lifecycle.

The source should choose one OAuth configuration at import time. After that,
credential operations should not ask the caller to repeat the security scheme
name in the common case.

## Current OpenAPI OAuth Model

Today preview returns `oauth2Presets`, one per supported OAuth option derived
from the spec. The add UI chooses one preset and persists one
`OAuth2SourceConfig` on the source:

```ts
oauth2: {
  kind: "oauth2",
  securitySchemeName: selectedOAuth2Preset.securitySchemeName,
  flow: selectedOAuth2Preset.flow,
  authorizationUrl: selectedOAuth2Preset.authorizationUrl,
  tokenUrl: selectedOAuth2Preset.tokenUrl,
  issuerUrl: selectedOAuth2Preset.issuerUrl ?? null,
  clientIdSlot: oauth2ClientIdSlot(selectedOAuth2Preset.securitySchemeName),
  clientSecretSlot: oauth2ClientSecretSlot(selectedOAuth2Preset.securitySchemeName),
  connectionSlot: oauth2ConnectionSlot(selectedOAuth2Preset.securitySchemeName),
  scopes: [...oauth2SelectedScopes],
}
```

Client ID and client secret are stored as scoped bindings:

```ts
setBinding({
  slot: oauth2.clientIdSlot,
  scope: org,
  value: {
    kind: "secret",
    secretId: SecretId.make("linear_client_id"),
  },
});

setBinding({
  slot: oauth2.clientSecretSlot,
  scope: org,
  value: {
    kind: "secret",
    secretId: SecretId.make("linear_client_secret"),
  },
});
```

The user connection is also stored as a scoped binding:

```ts
setBinding({
  slot: oauth2.connectionSlot,
  scope: user,
  value: {
    kind: "connection",
    connectionId: ConnectionId.make("linear_user_connection"),
  },
});
```

That underlying model is sound. The clunky part is exposing the slot names and
raw binding operations as the normal SDK path.

## Proposed OAuth SDK Flow

If the spec has exactly one supported OAuth option, `addSpec` can infer it. If
there are multiple supported OAuth options, `addSpec` should require an
import-time selection.

Single OAuth option:

```ts
const source = await executor.openapi.addSpec({
  scope: org,
  name: "Linear",
  namespace: "linear",
  baseUrl: "https://api.linear.app",
  spec: {
    kind: "url",
    url: "https://example.com/linear-openapi.json",
  },
  oauth: true,
});
```

Multiple OAuth options:

```ts
const source = await executor.openapi.addSpec({
  scope: org,
  name: "Linear",
  namespace: "linear",
  baseUrl: "https://api.linear.app",
  spec: {
    kind: "url",
    url: "https://example.com/linear-openapi.json",
  },
  oauth: {
    securityScheme: "linearOAuth",
  },
});
```

Configure app credentials:

```ts
await executor.openapi.configure(source, {
  scope: org,
  oauth: {
    clientId: SecretId.make("linear_client_id"),
    clientSecret: SecretId.make("linear_client_secret"),
  },
});
```

Connect a user:

```ts
await executor.openapi.connect(source, {
  scope: user,
});
```

Client credentials flow should use the same public concepts:

```ts
await executor.openapi.configure(source, {
  scope: org,
  oauth: {
    clientId: SecretId.make("service_client_id"),
    clientSecret: SecretId.make("service_client_secret"),
  },
});

await executor.openapi.connect(source, {
  scope: org,
});
```

Internally this still writes:

```txt
oauth2:<selected-security-scheme>:client-id
oauth2:<selected-security-scheme>:client-secret
oauth2:<selected-security-scheme>:connection
```

but SDK callers do not see those slots.

## OAuth Validation

`configure(source, { oauth: ... })` should fail if the source has no selected
OAuth config:

```txt
OpenAPI source "stripe" does not declare OAuth credentials.
```

`connect(source, { scope })` should fail if the source has no selected OAuth
config:

```txt
OpenAPI source "stripe" does not support OAuth connect.
```

`connect` should validate required client credentials before starting OAuth:

```txt
Client ID must be configured before connecting.
Client secret must be configured before connecting.
```

For authorization-code flows, client secret may be optional for public PKCE
clients. For client-credentials flows, client secret is required.

## Configure Should Be A Facade

The public OpenAPI SDK can expose:

```ts
executor.openapi.addSpec(...)
executor.openapi.configure(...)
executor.openapi.connect(...)
```

The lower-level core API can still expose generic bindings for advanced or UI
infrastructure cases:

```ts
executor.sources.setBinding(...)
executor.sources.listBindings(...)
executor.sources.removeBinding(...)
executor.sources.getSlotManifest(...)
```

But the common OpenAPI SDK path should not require users to manually map:

```txt
Authorization -> header:authorization
OAuth client ID -> oauth2:<scheme>:client-id
OAuth connection -> oauth2:<scheme>:connection
```

The SDK should derive that mapping from the selected source shape.

## Design Rule

`addSpec` defines what this source can use.

`configure` assigns values to things this source already declared.

`connect` creates or refreshes OAuth connection values for the selected OAuth
configuration.

Bindings and slots are the internal storage/resolution mechanism behind those
operations.
