---
"executor": patch
---

Stop re-downloading OpenAPI specs the app already has. Spec URLs now resolve through a tenant-shared cache (URL → content hash + ETag/Last-Modified over the existing content-addressed blob store): the add flow's detect → preview → add sequence downloads a spec once instead of per step, and refreshing an integration revalidates with a conditional request — an unchanged upstream costs a bodyless 304 instead of a multi-MB download.
