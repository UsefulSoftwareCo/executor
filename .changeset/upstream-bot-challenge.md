---
"@executor-js/sdk": patch
"@executor-js/plugin-openapi": patch
"@executor-js/plugin-graphql": patch
---

A request that Cloudflare bot protection challenges before it reaches the API (`cf-mitigated: challenge`) now fails as `upstream_bot_challenge` with the Ray ID, instead of `connection_rejected` with a prompt to re-authenticate and the challenge page's HTML. OpenAPI health checks report such a probe as degraded rather than expired, since the credential was never checked.
