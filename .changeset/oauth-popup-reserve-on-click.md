---
"@executor-js/react": patch
---

**A slow OAuth discovery no longer kills the connect with no popup and no error**

The transparent connect flows opened the sign-in window only after their setup round trips had answered: DCR after probe and dynamic registration, CIMD after minting the client, reconnect after starting the session. `window.open` needs transient user activation, which browsers expire a few seconds after the click, so once the API was slow enough the browser refused the window and the connect ended with nothing on screen but the button returning to "Connect". Every MCP integration takes that path.

The window is now claimed on the click itself and navigated when the authorization URL arrives, however long that takes, and it is closed again on the paths that end without signing in (failed probe, no registration endpoint, rejected registration, failed client mint) as well as on cancel and unmount. A window the browser does refuse is now reported instead of swallowed: the flows stop before their round trips, and the sign-in error renders above the dialog footer, where the automatic flows can actually show it, rather than inside a method tab panel they never render.
