---
"executor": patch
---

Keep sibling `properties` and `required` beside an inline `allOf`, `anyOf`, or `oneOf` in TypeScript tool previews, matching what referenced definitions already did. A titled definition names the whole composition, and a composed definition whose branch refers back to it no longer falls back to `unknown`.
