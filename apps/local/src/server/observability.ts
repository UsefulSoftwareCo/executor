// ---------------------------------------------------------------------------
// Local-app `ErrorCapture` — the shared console implementation with a `local-`
// trace id prefix. Prints the squashed cause + pretty-printed structured cause
// to stderr and returns a short correlation id. Operators can grep for the id
// in their terminal scrollback when a user reports an opaque 500 traceId.
// ---------------------------------------------------------------------------

import { consoleErrorCapture } from "@executor-js/api/server";

export const ErrorCaptureLive = consoleErrorCapture("local");
