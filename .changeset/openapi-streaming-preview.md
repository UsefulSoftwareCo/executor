---
"@executor-js/plugin-openapi": patch
---

Preview OpenAPI spec-format selections (Microsoft Graph) through the streaming structural-split path instead of a whole-document parse, and guard generic whole-document parses by parsed-tree size (line count for block YAML, text size for JSON). Previewing a Graph preset URL previously parsed the 43MB source whole and killed the 128MB Workers isolate mid-request, surfacing as an empty 503; it now streams within budget, and oversized generic specs fail with an actionable error instead of taking down the isolate.
