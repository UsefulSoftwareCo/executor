---
"executor": patch
---

Return a tool's declared annotations from `tools.schema` and `describe.tool`. Code inside `execute` can now read `requiresApproval`, `approvalDescription` and `mayElicit` without parsing the tool's prose description.
