---
"apps": patch
"@executor-js/sdk": patch
---

A live OpenAPI tool whose upstream answers 404 or 405 rechecks the API's
document at once instead of waiting for its cached copy to expire. When the
document no longer has the operation, the call fails as an unknown tool and the
tool leaves the listing. An unknown tool's error now says it may have been
removed or renamed and to search the app's tools again.
