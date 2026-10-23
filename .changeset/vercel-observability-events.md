---
"@executor-js/plugin-openapi": patch
---

The Vercel preset adds `logs.queryObservabilityEvents` (`POST /v1/observability/events`), the endpoint behind `vercel logs`. It searches runtime logs or CDN request records over a past time range, with filters and cursor paging. Vercel's published spec omits it, and its only runtime-log operation follows a live stream.
