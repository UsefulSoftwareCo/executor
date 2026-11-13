/**
 * One page-wide budget for keepalive request bodies.
 *
 * Fetch refuses a keepalive request, and `sendBeacon` refuses a beacon, once the page's keepalive
 * bodies in flight would pass 64 KiB. Chromium counts every sender on the page together, the
 * Sentry SDK's sandboxed fetch included, while each SDK counts only its own requests. A refused
 * request never leaves the browser and its sender drops it: an error report sent while trace and
 * log exports were in flight was lost this way.
 *
 * Counted here: the dashboard's trace and log exports, its Sentry reports and its analytics
 * events, each of which goes as an ordinary request when it does not fit. Not counted: PostHog's
 * own requests, which the dashboard sends without keepalive, except the beacons PostHog sends as
 * the page unloads (its queued requests and the last replay chunk); and any other keepalive
 * request or beacon on the page.
 */

const quota = 65_536;
// The budget is the browser's, one per page, so it lives as long as the page's modules.
/* oxlint-disable-next-line executor/no-module-level-mutable-state -- browser-only, one per page */
let inFlight = 0;

/**
 * The page's own `fetch`, taken when this module first loads, before any SDK wraps it. The Sentry
 * SDK wraps `window.fetch` to record each request as a breadcrumb on later reports; the page's own
 * reports and analytics events go through this one, so neither becomes a breadcrumb.
 */
export const pageFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/** The keepalive body bytes the page can still send before the browser refuses one. */
export const keepaliveRoom = () => quota - inFlight;

/**
 * Send with keepalive, counting `keepaliveBytes`, the body's size, against the page's budget; or,
 * given `false`, as an ordinary request. The browser counts a keepalive request until its whole
 * response has arrived, not just its headers, so the bytes are counted until a copy of the
 * response body has been read.
 */
export const countedFetch = (
  send: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  keepaliveBytes: number | false,
): Promise<Response> => {
  const counted = keepaliveBytes === false ? 0 : keepaliveBytes;
  inFlight += counted;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inFlight -= counted;
  };
  let response: Promise<Response>;
  try {
    response = send(input, { ...init, keepalive: keepaliveBytes !== false });
  } catch (cause) {
    release();
    throw cause;
  }
  if (counted === 0) {
    release();
    return response;
  }
  // oxlint-disable-next-line executor/authored-code-through-adapter -- the browser's own fetch
  response.then((answered) => answered.clone().arrayBuffer().then(release, release), release);
  return response;
};

const encoder = new TextEncoder();

/** The size of a body this page sends, or undefined for a stream or form, whose size is unknown. */
const bodySize = (body: BodyInit | null | undefined) =>
  body === null || body === undefined
    ? 0
    : typeof body === "string"
      ? encoder.encode(body).byteLength
      : body instanceof Blob
        ? body.size
        : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
          ? body.byteLength
          : undefined;

/**
 * `send`, with a requested keepalive kept only when the body fits what is left of the page's
 * budget. Otherwise the request goes as an ordinary one, which the browser sends at once but may
 * cancel if the page unloads first.
 */
export const budgetedFetch =
  (send: typeof fetch = pageFetch): typeof fetch =>
  (input, init) => {
    if (init?.keepalive !== true) return send(input, init);
    const size = bodySize(init.body);
    return countedFetch(send, input, init, size !== undefined && size <= keepaliveRoom() && size);
  };
