---
"executor": minor
---

**Irreversible cleanup now waits for the transaction to commit, and plugins can do the same**

`oauth.removeClient` deleted the client row and then deleted the client secret from the credential provider. The provider does not enlist in the caller's transaction and does not roll back with it, so an abort restored the client row while its secret stayed destroyed — a client that looks configured and can never authenticate again. The deletion now waits until the removal is durable and is discarded if the removal rolls back. With no transaction active it runs immediately, exactly as before.

Deferring the deletion is not enough on its own. The secret is stored under a key derived from the app's `(owner, slug)` identity alone, so the key outlives the row it belonged to: whoever holds that identity when the deletion finally runs owns the key. A slug registered again before the removal committed would lose the new app's secret to the old app's queued deletion — the same unauthenticatable client, reached the other way round. The deferred deletion now re-checks that the app is still gone and stands down when it is not. A removal that matched no row also no longer queues a deletion at all: it removed nothing, so it has no claim on the key, which may well hold another subject's live secret.

The same trap was reachable by plugins and they had no way out of it. `removeConnection` and `removeIntegration` run inside core's removal transaction — deliberately, so a plugin's own rows die atomically with the connection — which makes them exactly the wrong place to revoke a token at the provider's API, delete a remote object, or notify a third party. Nothing in the hooks' documentation said so, and `PluginCtx` exposed `transaction` but nothing to defer past it.

`PluginCtx` gains `afterCommit`. It runs the effect once the outermost transaction commits, discards it if that transaction rolls back, and runs it immediately when no transaction is active. The lifecycle hooks now document that they run inside core's transaction and that outside-world work belongs in `afterCommit`.

Sequencing work after your own `transaction(...)` call is not equivalent, and the documentation says so explicitly: `transaction` nests by pass-through, so inside an active transaction the inner call simply runs its effect and "afterwards" is still before any commit.
