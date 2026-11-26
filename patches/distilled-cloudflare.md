# Distilled Cloudflare patch

`@distilled.cloud%2Fcloudflare@1.0.0-rc.13.patch` changes both the published
JavaScript (`lib/`) and the TypeScript sources (`src/`) of
`services/workers`. It carries:

- **Upload observability settings.** The script upload codec keeps
  `redact_query_string`, which it otherwise dropped
  ([request timing](../notes/request-timing.md)).
- **Every observability destination.** `listObservabilityDestinations` reads
  every page. The endpoint returns 20 destinations a page and no
  `result_info`, and the generated client treated it as a single page, so a
  destination past the first 20 could not be found by name. Alchemy's
  `ObservabilityDestination` then tried to create it again, and Cloudflare
  refused the duplicate name (`ObservabilityDestinationCreateFailed: Bad
  Request`). A page past the last is empty, which ends the traversal. Drop this
  part when the client paginates the endpoint itself.
