// Cloudflare host `ErrorCapture` — the shared console implementation with a
// `cloudflare-` trace-id prefix. Worker stdout is routed to Logpush/the
// dashboard, so the squashed cause is grep-able by the opaque 500 traceId.

import { consoleErrorCapture } from "@executor-js/api/server";

export const ErrorCaptureLive = consoleErrorCapture("cloudflare");
