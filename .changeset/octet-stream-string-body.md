---
"@executor-js/plugin-openapi": patch
---

Allow a plain string `body` for octet-stream uploads again. Operations like Microsoft Graph's drive item content upload were rejecting string bodies with "request body must be bytes; provide bodyBase64", even though the request layer already sends a string through fine. String bodies now go through as UTF-8 bytes; binary content still uses `bodyBase64`.
