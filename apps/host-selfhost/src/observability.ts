// ---------------------------------------------------------------------------
// Self-host `ErrorCapture` — the shared console implementation with a
// `selfhost-` trace id prefix. Prints the squashed + pretty cause to stderr
// and returns a short correlation id that surfaces in the opaque 500 traceId,
// so operators can grep their logs. Cloud swaps in a Sentry-backed impl behind
// the same tag.
// ---------------------------------------------------------------------------

import { consoleErrorCapture } from "@executor-js/api/server";

export const ErrorCaptureLive = consoleErrorCapture("selfhost");
