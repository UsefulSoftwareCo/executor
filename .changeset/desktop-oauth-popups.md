---
"executor": patch
---

Desktop: allow JS-initiated popups so OAuth sign-in works. The previous `setWindowOpenHandler` routed every `window.open` to `shell.openExternal`, which broke the renderer's OAuth popup pattern (`window.open("about:blank", name, "popup=1,...")`) — `window.open` returned `null` and the UI reported "popup was blocked." Popups now open as sandboxed Electron child windows; `<a target="_blank">` link clicks still open in the user's default browser.
