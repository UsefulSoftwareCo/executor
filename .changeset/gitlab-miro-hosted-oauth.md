---
"@executor-js/hosted-server": patch
"@executor-js/sdk": patch
---

Allow hosted operators to configure GitLab.com and Miro OAuth clients for the official catalog apps. Both clients are optional and restrict managed tokens to their provider API hosts.

Authorization-code grants retain their original callback URI and send it on renewal, as GitLab requires. Older saved grants remain readable and omit the callback when it was not retained.
