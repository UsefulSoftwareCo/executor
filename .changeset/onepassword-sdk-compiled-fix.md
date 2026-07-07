---
"executor": patch
---

Fix 1Password desktop-app connections failing with "undefined is not a constructor (evaluating 'new n.DesktopAuth(...)')" in packaged builds. The compiled binary now bundles the 1Password SDK's wasm core correctly and falls back to a copy shipped next to the binary, so vault listing and secret resolution work without the `op` CLI installed.
