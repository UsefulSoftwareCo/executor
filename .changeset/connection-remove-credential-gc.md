---
"@executor-js/sdk": patch
---

Removing a connection, or removing the integration it belongs to, deleted the rows and left the credentials those connections had minted sitting in the provider, referenced by nothing and visible nowhere in the product. Both removals now delete the items they minted, including the long-lived OAuth refresh token, and an integration removal covers every member's connections under the slug rather than only the remover's own. An item a connection merely referenced is left alone, as is a minted item another connection still points at, and the deletion runs only once the removal has committed.
