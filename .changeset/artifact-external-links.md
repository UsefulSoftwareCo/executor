---
"executor": patch
---

**Fix: links in generated artifacts (`<a target="_blank">`) did nothing when clicked.** The sandbox iframe deliberately has no `allow-popups`, so the browser blocked the new browsing context and the click went nowhere. A trusted user click is now relayed across the frame boundary to the host's `openLink` capability — guarded by a per-render nonce so generated code cannot forge or observe it — and the host opens only `http`/`https` URLs.
