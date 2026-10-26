---
"executor": patch
---

Accept extra token-request parameters on a registered OAuth client.

Some providers need provider-shaped, non-secret parameters on every token request that no grant field carries — Auth0's Management API, for example, only issues a `client_credentials` token when the request names the API in `audience`. A registered (BYO) OAuth app can now carry an `audience`-style map (`tokenParams`), which executor sends on the client-credentials exchange, the authorization-code exchange, and every refresh. The map is registered through all surfaces that register a client — the web "Register OAuth app" form (new optional "Extra token parameters" JSON field), `oauth.clients.create`, and `oauth.clients.createHandoff` deep links — and is rejected if any name would shadow an OAuth protocol parameter (`grant_type`, `client_id`, `client_secret`, `scope`, `resource`, `code`, `code_verifier`, `redirect_uri`, `refresh_token`).
