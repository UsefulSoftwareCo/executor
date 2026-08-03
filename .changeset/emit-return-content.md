---
"executor": patch
---

**Fix: `execute` scripts that both `emit()` output and `return` a value no longer lose the returned value in MCP clients that ignore `structuredContent` — the return value is now appended to the tool-result content after the emitted items**
