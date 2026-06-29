---
"@executor-js/desktop": patch
"@executor-js/host-selfhost": patch
"@executor-js/host-cloudflare": patch
"@executor-js/react": patch
---

Polish the app's title bar. The release tag beside the `executor` wordmark is now quiet muted-mono metadata instead of a filled pill, matching the registry-minimal design language, and the wordmark is shared across the desktop and dashboard shells so the brand reads identically everywhere. The macOS traffic-light offset is also applied to the mobile sidebar overlay and the collapsed top bar, so the native window controls never sit on top of the wordmark when the window is narrow.
