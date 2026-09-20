---
"@executor-js/sdk": patch
---

Removing a connection deleted its row and left the credential it had minted sitting in the provider, referenced by nothing and visible nowhere in the product, so a user who disconnected an account still had that account's tokens held on their behalf. Removal now also deletes the items that connection minted, including the long-lived OAuth refresh token. An item the connection merely referenced is left alone, as is a minted item another connection still points at, and the deletion runs only once the removal has committed.
