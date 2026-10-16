---
"@executor-js/hosted-web": patch
"@executor-js/local-web": patch
---

Renamed API-key providers without a declared or catalog icon can use their single exact public credential host for a fallback logo. Private, wildcard and ambiguous host lists retain the neutral icon. Only the registrable domain reaches the existing logo proxy; credentials are never read.
