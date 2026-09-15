---
"@executor-js/sdk": patch
---

Removing an integration now drops every member's connections and tools under it, not only the remover's own. Tool and connection listings no longer serve rows whose integration is gone from the catalog, invoking such a tool reports the missing integration, and `oauth.start` refuses an unknown integration before creating a session.
