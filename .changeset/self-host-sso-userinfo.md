---
"@executor-js/hosted-self-host": patch
---

Self-host SSO signs in a user whose ID token carries `sub` and `email` but no
`email_verified`, as an Okta tenant-root issuer sends. The claim is read from the
provider's userinfo endpoint for the subject the token named; a user the endpoint
reports as unverified, or a response about another subject, is still refused.
