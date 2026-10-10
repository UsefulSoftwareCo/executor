---
"@executor-js/sdk": patch
---

Removing an app, or an owner with its apps, deletes the app's event subscriptions, their
pending deliveries and its stored events. Subscribing to an app re-created with the same name
no longer fails because the old subscription pinned that name to the removed app.
