---
"@executor-js/hosted-self-host": patch
"@executor-js/local-server": patch
"@executor-js/catalog": patch
---

Say why Executor's official apps are missing when the app catalog is turned off or its feed cannot be read, in onboarding and Add app, and keep the built-in Executor app listed. The dashboards' listings, hosted `GET /api/catalog` (browser sessions only) and local's dashboard endpoint, now return `{ apps, feed }`, so they can show the feed's state beside the built-in apps. `organization.catalog`, which API keys and agents call, returns the same array and the same `CatalogUnavailable` error body as before; its message now says what to do instead. Unchanged feed indexes are revalidated instead of downloaded again.
