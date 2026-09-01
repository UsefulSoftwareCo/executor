---
"executor": patch
---

**Removing a connection now deletes the credential it minted**

`connections.remove` deleted the connection row and left the credential it had minted in the store. The secret outlived the only thing that referenced it, with no surface left in the product to see or remove it — so a user who disconnected an account still had that account's tokens held on their behalf.

Removal now also deletes the items the connection minted, identified by rebuilding their deterministic ids from the connection row rather than by scanning for anything that looks related. A minted credential that another connection still points at is kept. The alias scan is scoped to the provider that owns the connection, and both the OAuth and the static halves of the deletion are covered.
