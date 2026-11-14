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
 * request or beacon on the page. Those can still fill the quota; a keepalive request the browser
 * refuses then goes once more as an ordinary request, and the page records that it did.
 */

const quota = 65_536;
// The budget is the browser's, one per page, so it lives as long as the page's modules.
/* oxlint-disable-next-line executor/no-module-level-mutable-state -- browser-only, one per page */
let inFlight = 0;

/** Which of the page's telemetry senders a request belongs to: a fixed name, never an identifier. */
export type KeepaliveSender = "exports" | "error-reports" | "error-sessions" | "analytics";

/** What became of a request the browser refused and the page sent once more as an ordinary one. */
export type KeepaliveResend = "resent" | "resend-failed";

type ResendListener = (sender: KeepaliveSender, outcome: KeepaliveResend) => void;
// Resends before the page's telemetry starts are kept, a bounded few, until it listens.
/* oxlint-disable executor/no-module-level-mutable-state -- browser-only, one per page */
let resendListener: ResendListener | undefined;
const earlyResends: Array<readonly [KeepaliveSender, KeepaliveResend]> = [];
/* oxlint-enable executor/no-module-level-mutable-state */

const recordResend = (sender: KeepaliveSender, outcome: KeepaliveResend) => {
  if (resendListener !== undefined) resendListener(sender, outcome);
  else if (earlyResends.length < 50) earlyResends.push([sender, outcome]);
};

/**
 * Hear each resend of a refused keepalive request, including those before this was called. The
 * page's telemetry records them; the returned function stops listening.
 */
export const onKeepaliveResend = (listener: ResendListener) => {
  resendListener = listener;
  for (const [sender, outcome] of earlyResends.splice(0)) listener(sender, outcome);
  return () => {
    if (resendListener === listener) resendListener = undefined;
  };
};

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
 * response body has been read. Only for idempotent telemetry: see `budgetedFetch`.
 */
export const countedFetch = (
  sender: KeepaliveSender,
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
  if (counted === 0) release();
  // A throwing `clone()`, such as on a body the caller already read, still releases the bytes.
  // oxlint-disable-next-line executor/authored-code-through-adapter -- the browser's own fetch
  else response.then((answered) => answered.clone().arrayBuffer()).then(release, release);
  if (keepaliveBytes === false) return response;
  // Senders this budget cannot see, such as PostHog's unload beacons or an extension, use the same
  // quota, so the browser can still refuse a keepalive request this budget let through. It refuses
  // before the request leaves (the Fetch standard's HTTP-network-or-cache fetch returns a network
  // error before any connection is used), so sending it once more as an ordinary request delivers
  // it once. A refusal rejects with the same TypeError as a connection lost after sending, and that
  // request is sent once more too, so it can arrive twice. Sentry drops a repeated `event_id`. PostHog
  // treats events that share `uuid`, event name, `timestamp` and `distinct_id` as one, and merges
  // them in the background: posthog-js sets `uuid` and `timestamp` before `before_send`, and the
  // resend sends the same body, so all four match, but a raw count can be briefly inflated until
  // the merge runs. A repeated trace or log export repeats span ids, as the exporter's own retries
  // of a transient failure can.
  // oxlint-disable-next-line executor/authored-code-through-adapter -- the browser's own fetch
  return response.catch((cause: unknown) => {
    if (!(cause instanceof TypeError)) throw cause;
    const resent = send(input, { ...init, keepalive: false });
    // oxlint-disable-next-line executor/authored-code-through-adapter -- the browser's own fetch
    resent.then(
      () => recordResend(sender, "resent"),
      () => recordResend(sender, "resend-failed"),
    );
    return resent;
  });
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
 *
 * Only for idempotent telemetry: a keepalive request that fails with a TypeError is sent once more,
 * and a TypeError cannot tell a refusal, which sent nothing, from a connection lost after the
 * request was sent. A request whose repeat would do something twice, such as a write, must not
 * use this.
 */
export const budgetedFetch =
  (sender: KeepaliveSender, send: typeof fetch = pageFetch): typeof fetch =>
  (input, init) => {
    if (init?.keepalive !== true) return send(input, init);
    const size = bodySize(init.body);
    return countedFetch(
      sender,
      send,
      input,
      init,
      size !== undefined && size <= keepaliveRoom() && size,
    );
  };
