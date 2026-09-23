---
name: inbox
description: Read cached inbox messages and save new messages when the user asks. Use this when working with the Live inbox app.
metadata:
  author: Executor
---

# Work with this inbox

Use the app namespace returned with this skill. Several installed copies can share
these instructions while keeping separate messages and account selections.

1. Discover this app's operations with `tools.search({ namespace: app.slug })`.
2. Call `queries.listMessages({})` to read up to 100 recent messages.
3. Call `mutations.receiveMessage({ subject })` only when the user asks to save a
   message. The mutation inserts a new record; repeating it inserts another one.

Read [examples](references/examples.md) for the call shapes. Read that reference
with the deployment ID returned alongside this document.

These instructions do not grant permission to call either operation. Follow
Executor's current grants and approval requests.
