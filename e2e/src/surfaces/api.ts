// API surface: the typed Effect `HttpApiClient` a real consumer codes against,
// over the wire to the target's dev server. Auth comes from the scenario's
// Identity — either ready-made headers (cloud's stub session cookie) or a
// Better Auth email sign-in (selfhost). Calls made through `call()` land in
// the transcript as tool turns with their result, so the viewer shows the
// exact request/response a consumer saw.
import { Effect } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { Recorder } from "../recorder";
import type { Identity, Target } from "../target";

type AnyApi = Parameters<typeof HttpApiClient.make>[0];

export interface ApiSurface {
  /** Typed client for `apiDef`, authenticated as `identity`. */
  readonly client: <A extends AnyApi>(
    apiDef: A,
    identity: Identity,
  ) => Effect.Effect<HttpApiClient.Client<A, never>, unknown, HttpClient.HttpClient>;
  /** Run an API call and record it (args, result, duration) as a tool turn. */
  readonly call: <A, E, R>(
    name: string,
    args: unknown,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export const makeApiSurface = (rec: Recorder, target: Target): ApiSurface => ({
  client: (apiDef, identity) =>
    Effect.gen(function* () {
      const headers = identity.headers ?? (yield* signInHeaders(target.baseUrl, identity));
      rec.step("api", `Authenticated as ${identity.label} against ${target.baseUrl}`);
      return yield* HttpApiClient.make(apiDef, {
        baseUrl: new URL("/api", target.baseUrl).toString(),
        transformClient: HttpClient.mapRequest((request) =>
          Object.entries(headers).reduce(
            (req, [key, value]) => HttpClientRequest.setHeader(req, key, value),
            request,
          ),
        ),
      });
    }),
  call: (name, args, effect) =>
    Effect.gen(function* () {
      const started = Date.now();
      const exit = yield* Effect.exit(effect);
      const durationMs = Date.now() - started;
      if (exit._tag === "Success") {
        rec.toolCall({
          surface: "api",
          name,
          args,
          result: exit.value,
          ok: true,
          text: summarize(exit.value),
          durationMs,
        });
        return exit.value;
      }
      const failure = String(exit.cause);
      rec.toolCall({
        surface: "api",
        name,
        args,
        result: failure.slice(0, 2_000),
        ok: false,
        text: failure.slice(0, 160),
        durationMs,
      });
      return yield* Effect.failCause(exit.cause);
    }),
});

// Better Auth email sign-in → session cookie (selfhost). The `origin` header is
// required: Better Auth rejects state-changing requests without one.
const signInHeaders = (baseUrl: string, identity: Identity) =>
  Effect.promise(async (): Promise<Record<string, string>> => {
    const credentials = identity.credentials;
    if (!credentials) throw new Error(`identity ${identity.label} has no headers or credentials`);
    const response = await fetch(new URL("/api/auth/sign-in/email", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(baseUrl).origin },
      body: JSON.stringify(credentials),
      redirect: "manual",
    });
    const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error(`api: sign-in set no cookie (${response.status})`);
    return { cookie };
  });

const summarize = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (json === undefined) return String(value);
  return json.length > 160 ? `${json.slice(0, 160)}…` : json;
};
