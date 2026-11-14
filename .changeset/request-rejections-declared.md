---
"@executor-js/sdk": patch
"@executor-js/app-management": patch
"@executor-js/hosted-server": patch
"@executor-js/hosted-cloud": patch
"@executor-js/hosted-self-host": patch
"@executor-js/local-server": patch
---

A request that does not match its operation's schema now gets a `400 RequestInvalid` that every
operation in the Cloud, self-host and local management documents declares. It names the rejected
part and each path with what the schema expects there, never the submitted value. Agents calling
Executor through the Executor app see that cause instead of an HTTP 400 the document does not
declare. App ID parameters say they take the app's `id`, not its slug.
