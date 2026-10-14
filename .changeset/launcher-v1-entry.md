---
"executor": patch
---

The npm package keeps Executor 1's `bin/executor` entry point, which forwards to `bin.mjs`. Command
shims left by an upgrade that did not relink them, such as Bun's on Windows, start Executor 2
instead of failing with MODULE_NOT_FOUND.
