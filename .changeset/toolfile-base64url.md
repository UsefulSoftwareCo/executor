---
"executor": patch
---

Emitted `ToolFile` output now accepts base64url data, padded or unpadded, such as Gmail message bodies. Before, this failed with "Internal tool error". File data that is not valid base64 now shows a short note in place of the file, and the rest of the result still comes back.
