const quota = 65_536;
/* oxlint-disable-next-line executor/no-module-level-mutable-state -- browser-only, one per page */
let inFlight = 0;

export type KeepaliveSender = "exports" | "error-reports" | "error-sessions" | "analytics";

export type KeepaliveResend = "resent" | "resend-failed";

type ResendListener = (sender: KeepaliveSender, outcome: KeepaliveResend) => void;
/* oxlint-disable executor/no-module-level-mutable-state -- browser-only, one per page */
let resendListener: ResendListener | undefined;
const earlyResends: Array<readonly [KeepaliveSender, KeepaliveResend]> = [];
/* oxlint-enable executor/no-module-level-mutable-state */

const recordResend = (sender: KeepaliveSender, outcome: KeepaliveResend) => {
  if (resendListener !== undefined) resendListener(sender, outcome);
  else if (earlyResends.length < 50) earlyResends.push([sender, outcome]);
};

export const onKeepaliveResend = (listener: ResendListener) => {
  resendListener = listener;
  for (const [sender, outcome] of earlyResends.splice(0)) listener(sender, outcome);
  return () => {
    if (resendListener === listener) resendListener = undefined;
  };
};

export const pageFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export const keepaliveRoom = () => quota - inFlight;

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
  // oxlint-disable-next-line executor/authored-code-through-adapter -- the browser's own fetch
  else response.then((answered) => answered.clone().arrayBuffer()).then(release, release);
  if (keepaliveBytes === false) return response;
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
