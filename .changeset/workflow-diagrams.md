---
"@executor-js/ui": patch
"@executor-js/workflow-graph": patch
---

The Workflows tab draws the selected workflow from top to bottom, read from the deployed version's
own code. Each `ctx.step` call is a card, and `if`, `switch`, loops, `Promise.all` and `try`/`catch`
around steps become decisions, loop boxes, parallel boxes and failure branches. Selecting a card
shows the hosts and accounts its code reaches, its options as written and the lines it came from.
A step that starts another workflow through a tool links to that workflow, and each workflow lists
the tools, schedules, webhooks and workflows that start it. Nothing is added to app code. Only
people who can read the app's source see the diagram; the run history is unchanged.
