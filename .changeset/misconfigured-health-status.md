---
"executor": patch
---

**A disabled upstream API now reports `misconfigured` instead of `expired`**

A 403 caused by the provider disabling the API (Google SERVICE_DISABLED / accessNotConfigured shapes) is a configuration problem, not a credential problem — reconnecting cannot fix it. Health checks now classify it as a fifth status, `misconfigured`, shown with an amber badge and a link to the provider console instead of a Reconnect prompt. Ordinary 401/403 credential rejections still report `expired`.
