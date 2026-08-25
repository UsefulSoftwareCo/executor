---
"@executor-js/react": patch
---

**The connection edit sheet now previews what agents actually read**

The "What agents see" preview in the connection edit sheet rendered a `- \`<prefix>\` — <description>`inventory line. That line left the`execute`tool description when the inventory was slimmed to bare integration slugs, so the preview showed text no agent reads. The account label was also marked "Display-only", but`connections.list` returns it to agents alongside the description.

The preview now mirrors the `connections.list` item for the connection (`name`, `identityLabel`, `description`), and the sheet copy says that both fields are agent-visible while the callable name stays as it was at connect time.
