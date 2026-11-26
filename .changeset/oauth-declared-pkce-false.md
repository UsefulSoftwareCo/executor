---
"apps": patch
"@executor-js/sdk": patch
"@executor-js/app-templates": patch
---

Declared `oauth2()` endpoints accept `pkce: false` for a service whose token endpoint refuses a
confidential client's `code_verifier`. LinkedIn's web flow answers such a request with 401
`invalid_client`, so every LinkedIn sign-in failed at the code exchange whatever secret was saved.
With the declaration, sign-in sends no `code_challenge` and no `code_verifier`. Only a secret
`tokenEndpointAuthMethod` may declare it; without one the build fails. Every other provider keeps
PKCE S256.
