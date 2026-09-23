# Repository reports

Deploy these four TypeScript files, then connect a GitHub token. Call
`mutations.startReport` with
`{ "repositories": [{ "owner": "cloudflare", "name": "workers-sdk" }] }`.
Read `queries.reportRuns` for completion and `queries.listReports` for saved rows.

The workflow fetches repositories concurrently, retries failed requests, and
saves results through a registered mutation. The same operations are available
to agents and app UI. It uses real GitHub requests; no request has been made as
part of the local workflow verification.

See [workflow semantics](../../../notes/app-workflows.md) for replay and idempotency.
