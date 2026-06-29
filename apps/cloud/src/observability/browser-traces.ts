// Browser → Axiom OTLP ingress. The web client exports its spans to
// same-origin /v1/traces (it can never hold AXIOM_TOKEN); this worker route
// forwards the batch to Axiom with the server-held credentials. Locally and
// in e2e the vite dev server proxies the same path to motel before the
// worker ever sees it, so this route only serves deployed workers.
//
// Guards, not auth: the endpoint is write-only into a server-pinned dataset,
// but it should not be an anonymous internet ingest — a session cookie must
// at least be present, and bodies are capped. We deliberately do NOT verify
// the session (that would put a WorkOS round-trip on every span batch).

const MAX_BODY_BYTES = 2_000_000;

export const BROWSER_TRACES_PATH = "/v1/traces";

export const browserTracesResponse = (
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> | null => {
  const url = new URL(request.url);
  if (url.pathname !== BROWSER_TRACES_PATH) return null;
  if (request.method !== "POST") {
    return Promise.resolve(new Response(null, { status: 405 }));
  }
  // Tracing not configured on this deployment — accept and drop so the
  // client exporter stays quiet (it would retry/log on errors).
  if (!env.AXIOM_TOKEN) {
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  if (!(request.headers.get("cookie") ?? "").includes("wos-session=")) {
    return Promise.resolve(new Response(null, { status: 401 }));
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return Promise.resolve(new Response(null, { status: 413 }));
  }
  return fetchImpl(env.AXIOM_TRACES_URL ?? "https://api.axiom.co/v1/traces", {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      authorization: `Bearer ${env.AXIOM_TOKEN}`,
      "x-axiom-dataset": env.AXIOM_DATASET ?? "executor-cloud",
    },
    body: request.body,
  }).then(
    // The exporter only needs success/failure; never reflect Axiom's
    // response body (or its headers) back to an unauthenticated caller.
    (upstream) => new Response(null, { status: upstream.ok ? 204 : 502 }),
    () => new Response(null, { status: 502 }),
  );
};
