---
"@executor-js/host-selfhost": patch
"executor": patch
---

Self-host SSO reads `email_verified` from the provider's UserInfo endpoint when the ID token omits it, so identity providers that issue thin ID tokens, such as a stock Okta tenant, can admit users.
