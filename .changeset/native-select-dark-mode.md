---
"@executor-js/react": patch
---

Keep native `<select>` dropdown options readable in dark mode. The console themes through `prefers-color-scheme` and never sets a `.dark` class, so Tailwind `dark:` utilities never matched and the native option popup rendered with a light color scheme over dark text. `NativeSelect` now uses a solid themed surface (`bg-popover`) and pins `color-scheme` to the active theme, so the browser draws a matching, readable popup.
