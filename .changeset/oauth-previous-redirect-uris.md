---
"@executor-js/sdk": patch
---

OAuth options take `previousRedirectUris`: callbacks a host sent before its current one. A client
saved at one of them keeps sending it; new clients register the current callback. Sign-in starts
and `findOAuth` return the `redirectUri` the sign-in sent.
