# Hydrated API queries

Since Effect 4.0.6 an effect atom that is seeded with a hydrated value still runs its
effect when it mounts, unless it is declared with `skipInitialRun`. On 4.0.1 a hydrated
atom skipped that run. `Atom.serializable` takes the option; `AtomHttpApi` queries, which
become serializable through their `serializationKey`, take none.

The dashboards render on the server and send each settled read with the page, so the
browser shows it without requesting it again
([dashboard rendering](../notes/dashboard-rendering.md)). Without the option every
server-rendered read was requested a second time as its component mounted.

`effect@4.1.4.patch` adds `skipInitialRun` to the request options of
`AtomHttpApi`'s `query`, in source, distributed JavaScript and declarations, and passes
it to `Atom.serializable`. It is part of the query's key and has no effect without a
`serializationKey`.

`hydrated()` in `packages/ui/src/contracts/http.ts` sets it for every hydrated API
query, and `hydratedResult` passes it to `Atom.serializable` directly. A refresh,
`revalidated` and a changed dependency still run the read.

`dashboard-read-batches.spec.ts` ("A dashboard tab left open across a server upgrade")
fails when a page's reads are requested again after it loads. Remove the patch when
`AtomHttpApi` takes the option itself.
