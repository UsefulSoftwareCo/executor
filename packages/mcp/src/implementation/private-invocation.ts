/** Opt-in per-session negotiation and per-request confidential header capture. */
import { Context, Effect, Redacted, Stream } from "effect";
import {
  Headers as HttpHeaders,
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { PrivateInvocationRequest, privateInvocationCapability } from "@executor-js/sdk/core";
import type { McpOptions } from "../contracts/tools.ts";

type Attachment = {
  readonly reference: Redacted.Redacted<string>;
  readonly principal: string;
  readonly verifier: import("@executor-js/sdk/core").PrivateInvocationVerifier;
};

export const PrivateAttachment = Context.Reference<Attachment | undefined>(
  "mcp/PrivateAttachment",
  { defaultValue: () => undefined },
);
const descriptor = (v: unknown) =>
  typeof v === "object" &&
  v !== null &&
  "version" in v &&
  v.version === 1 &&
  "header" in v &&
  v.header === "Private-Invocation" &&
  "directCallOnly" in v &&
  v.directCallOnly === true;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Session state contains support and principal partitions only; no reference/permit is cached. */
export const privateInvocationHttp = (options: McpOptions) => {
  const sessions = new Map<string, number>();
  const key = (caller: string, session: string) => JSON.stringify([caller, session]);
  return <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const header = request.headers["private-invocation"];
      const config = options.privateInvocation;
      const denied = () =>
        HttpServerResponse.jsonUnsafe(
          { error: "Private invocation requires negotiated exact direct call v1" },
          { status: 400 },
        );
      if (config === undefined) return header === undefined ? yield* handler : denied();
      if (request.method !== "POST") return header === undefined ? yield* handler : denied();
      // Upstream product authentication may already have read this wrapper's text.
      // Reuse that supported cached effect, then bound the sanitized materialization.
      const text = yield* request.text;
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > (header === undefined ? 1048576 : 262144)) return denied();
      const headers = { ...request.headers };
      delete headers["private-invocation"];
      // Keep the native source identity: Effect keys its pre-response/session handlers
      // by source. Header-only modify loses body caches; a new native source loses those handlers.
      const cached = (
        view: HttpServerRequest.HttpServerRequest,
      ): HttpServerRequest.HttpServerRequest =>
        new Proxy(view, {
          get(target, key) {
            if (key === "text") return request.text;
            if (key === "json") return request.json;
            if (key === "stream") return Stream.succeed(bytes);
            if (key === "modify")
              return (options: Parameters<typeof view.modify>[0]) => cached(view.modify(options));
            return Reflect.get(target, key, target);
          },
        });
      const sanitizedHandler = handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          cached(request.modify({ headers: HttpHeaders.fromInput(headers) })),
        ),
      );
      const decoded = yield* Effect.try(() =>
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ).pipe(Effect.option);
      if (decoded._tag === "None" || !object(decoded.value))
        return header === undefined ? yield* sanitizedHandler : denied();
      const rpc = decoded.value;
      const caller = yield* options.caller;
      const params = object(rpc.params) ? rpc.params : {};
      const capabilities = object(params.capabilities) ? params.capabilities : {};
      const experimental = object(capabilities.experimental) ? capabilities.experimental : {};
      const initialize = rpc.method === "initialize";
      if (header !== undefined) {
        const session = request.headers["mcp-session-id"];
        const expiry = session === undefined ? undefined : sessions.get(key(caller, session));
        if (
          expiry === undefined ||
          expiry < Date.now() ||
          !/^[\x21-\x7e]{1,512}$/.test(header) ||
          rpc.method !== "tools/call" ||
          params.name !== "call" ||
          !object(params.arguments) ||
          !object(params.arguments.calls) ||
          typeof params.arguments.calls.path !== "string" ||
          Object.keys(params.arguments).some((k) => k !== "calls") ||
          Object.keys(params.arguments.calls).some((k) => k !== "path" && k !== "input")
        )
          return denied();
        const principal = yield* config.principal;
        return yield* sanitizedHandler.pipe(
          Effect.provideService(PrivateAttachment, {
            reference: Redacted.make(header),
            principal,
            verifier: config.verifier,
          }),
        );
      }
      const response = yield* sanitizedHandler;
      if (!initialize || !descriptor(experimental.privateInvocation)) return response;
      // Session headers are attached by the transport's pre-response handlers.
      // Append after those handlers, so negotiation caches the actual emitted session.
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.gen(function* () {
          // Initialization is small and finite. Never buffer an event/subscription response.
          const services = yield* Effect.context<never>();
          const amended = yield* Effect.tryPromise({
            try: async (signal) => {
              const web = HttpServerResponse.toWeb(response, { context: services });
              if (!web.body) throw new Error("Initialize body unavailable");
              const reader = web.body.getReader();
              const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
              const cancel = () => {
                void reader.cancel().catch(() => {});
              };
              deadline.addEventListener("abort", cancel, { once: true });
              const decoder = new TextDecoder("utf-8", { fatal: true });
              let text = "",
                size = 0;
              try {
                for (;;) {
                  if (deadline.aborted) throw new Error("Initialize deadline");
                  const { value, done } = await reader.read();
                  if (done) break;
                  size += value.byteLength;
                  if (size > 65536) throw new Error("Initialize exceeds private negotiation bound");
                  text += decoder.decode(value, { stream: true });
                }
                text += decoder.decode();
                if (deadline.aborted) throw new Error("Initialize deadline");
              } finally {
                deadline.removeEventListener("abort", cancel);
                await reader.cancel();
              }
              let advertised = false;
              const amend = (value: unknown): unknown => {
                if (!object(value) || !object(value.result) || !object(value.result.capabilities))
                  return value;
                advertised = true;
                const result = value.result,
                  caps = result.capabilities as Record<string, unknown>;
                return {
                  ...value,
                  result: {
                    ...result,
                    capabilities: {
                      ...caps,
                      experimental: {
                        ...(object(caps.experimental) ? caps.experimental : {}),
                        privateInvocation: privateInvocationCapability,
                      },
                    },
                  },
                };
              };
              const body = (web.headers.get("content-type") ?? "").includes("text/event-stream")
                ? text
                    .split("\n")
                    .map((line) =>
                      line.startsWith("data: ")
                        ? "data: " + JSON.stringify(amend(JSON.parse(line.slice(6))))
                        : line,
                    )
                    .join("\n")
                : JSON.stringify(amend(JSON.parse(text)));
              const session = web.headers.get("mcp-session-id");
              // No stateless grant. Reinitialization after restart is deliberately required.
              if (advertised && web.ok && session) {
                for (const [k, expiry] of sessions) if (expiry < Date.now()) sessions.delete(k);
                if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!);
                sessions.set(key(caller, session), Date.now() + 3600000);
              }
              const headers = new Headers(web.headers);
              headers.delete("content-length");
              return HttpServerResponse.fromWeb(
                new Response(body, { status: web.status, headers }),
              );
            },
            catch: () => new Error("Private negotiation unavailable"),
          }).pipe(Effect.option);
          return amended._tag === "Some" ? amended.value : denied();
        }),
      );
      return response;
    }).pipe(
      Effect.updateService(HttpHeaders.CurrentRedactedNames, (names) => [
        ...names,
        "private-invocation",
      ]),
    );
};

/** Bind only the real backend the request driver supplies, never the detached program's broker. */
export const privateBackend = <E extends Error>(
  backend: import("../contracts/backend.ts").McpBackend<E>,
  attachment: Attachment | undefined,
): import("../contracts/backend.ts").McpBackend<E> =>
  attachment === undefined
    ? backend
    : {
        ...backend,
        callTool: (input, options) =>
          backend
            .callTool(input, options?.issuer === undefined ? {} : { issuer: options.issuer })
            .pipe(
              Effect.provideService(PrivateInvocationRequest, {
                ...attachment,
                reauthorize: (input) => backend.authorizeElicitation(input),
              }),
            ),
      };
