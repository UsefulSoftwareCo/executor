---
"apps": minor
"@executor-js/sdk": minor
"@executor-js/ui": minor
"@executor-js/hosted-server": minor
"@executor-js/hosted-web": minor
"@executor-js/local-server": patch
"@executor-js/local-web": patch
"@executor-js/telemetry": patch
---

Apps can acquire accounts through `interactive({ label })` methods and ordinary
async `connect.<slot>` handlers. The Connect dialog presents device codes and
paste-back steps while Executor retains the private session. Accounts hold only
the app's opaque reference and remain bound to that app. Removing or replacing
their final link retires the reference through the app before deleting it.
Failed retirement keeps the local account for retry. App handlers receive the
host-authenticated caller as `ctx.user.id`. Host protocol 14 retains support for
existing bundles through protocol 13.
