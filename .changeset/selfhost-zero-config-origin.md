---
"executor": patch
---

Self-hosted instances now detect their public URL automatically on common
platforms, and origin handling is consistent across every host. When
`EXECUTOR_WEB_BASE_URL` is not set, the server reads the origin a host injects
(Railway, Render, Fly, Vercel, Netlify, Heroku, Azure, Cloudflare Pages) instead
of defaulting to localhost — so a platform deploy works with zero configuration
and no longer fails sign-in with "Invalid origin". When the origin still can't be
determined, that error is replaced with a clear message telling you exactly which
`EXECUTOR_WEB_BASE_URL` value to set, and a startup warning fires on any non-dev
deploy that falls back to localhost. The MCP browser-approval link a self-host
sends to clients now uses the pinned public URL (reachable behind a reverse
proxy) rather than the server's internal address. These resolution rules now live
in one shared helper used by every host.
