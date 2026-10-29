---
"@executor-js/plugin-openapi": patch
---

Fail throttling 403 responses as `upstream_http_error` instead of `connection_rejected`. A 403 that names a rate limit (Google's `rateLimitExceeded` / `RESOURCE_EXHAUSTED`, GitHub's secondary rate limit with `Retry-After`, or `x-ratelimit-remaining: 0`) is a quota signal, not a bad credential: the previous classification told the agent to re-authenticate, which cannot clear a quota, and replaced the upstream reason with a re-auth prompt. Detection is structural (throttling headers or an exact `error`/`reason`/`status`/`code` value), so permission 403s keep their existing `connection_rejected` guidance.
