---
"@executor-js/mcp-auth": patch
---

`grantOAuthPlugins` takes the authorization server's `issuer`. Discovery, the
authorize redirect's `iss`, token claims and introspection name it, while every
endpoint stays on the browser origin, so the issuer can live on another host.
