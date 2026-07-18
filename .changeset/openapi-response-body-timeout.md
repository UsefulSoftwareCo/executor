---
"@executor-js/plugin-openapi": patch
---

OpenAPI invocations now bound how long a buffered (non-streaming) response body may take to arrive. An upstream that returns headers quickly and then stalls the body previously hung the call indefinitely on runtimes without a platform subrequest limit; it now aborts after the response-body timeout (default 60s, configurable via `invokeOptions.responseBodyTimeoutMs`) with a distinct `upstream_response_body_timeout` failure.
