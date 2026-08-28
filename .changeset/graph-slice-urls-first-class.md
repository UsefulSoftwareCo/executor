---
"@executor-js/plugin-openapi": patch
---

Make Microsoft Graph slice URLs first-class spec sources instead of a hidden substitution. Catalog tiles now point directly at the slice release assets, the stored specUrl is exactly what gets fetched, and selection narrowing travels visibly in the URL fragment; requesting the upstream monolith URL fetches the monolith, never a silently swapped slice.
