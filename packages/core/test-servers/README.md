# @executor-js/test-servers

Deployable realistic protocol test servers for smoke and end-to-end tests.

The Worker exposes OAuth-protected OpenAPI, GraphQL, and MCP endpoints from one
origin. Tests can run against the in-process Worker export, `wrangler dev`, or a
Cloudflare Workers deployment.

## Commands

```sh
bun run test
bun run typecheck
bun run dev:cloudflare
bun run deploy:cloudflare
```

## OAuth

Default client credentials:

- `client_id`: `test-client`
- `client_secret`: `test-secret`

Resource owner credentials for the basic-login authorization page:

- username: `alice`
- password: `password`

Discovery endpoints:

- `/.well-known/oauth-authorization-server`
- `/.well-known/openid-configuration`
- `/.well-known/oauth-protected-resource/openapi/items`
- `/.well-known/oauth-protected-resource/graphql`
- `/.well-known/oauth-protected-resource/mcp`

The authorization-code flow uses PKCE `S256`. A successful token response mints
Bearer access tokens that authorize the protocol endpoints.

## Protocol Endpoints

- `GET /openapi/spec.json`: OpenAPI 3 spec generated from an Effect `HttpApi`.
- `GET /openapi/items`: OAuth-protected OpenAPI operation.
- `POST /graphql`: OAuth-protected GraphQL Yoga endpoint.
- `/mcp`: OAuth-protected MCP Streamable HTTP endpoint.

The OpenAPI spec includes OAuth2 authorization-code security metadata pointing
back to this Worker origin, so clients can discover and complete the OAuth flow
against the same deployed endpoint.

## In-Process Use

```ts
import worker from "@executor-js/test-servers";

const response = await worker.fetch(new Request("https://example.test/health"));
```

The in-process path is what `src/worker.test.ts` uses, so the deployed Worker
and the local test fixture exercise the same implementation.
