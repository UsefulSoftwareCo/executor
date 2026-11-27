import type { McpAccess } from "@executor-js/hosted-server";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Effect, Option, Schema } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/http";
import { mcpMethodHeader, parseMcpBody } from "./mcp-request-method.ts";
import { clientFamilyOfName } from "./client-family.ts";
import { recordMcpFirstUse } from "./product-analytics.ts";

type Step = "client" | "tools";
const steps = { initialize: "client", "server/discover": "client", "tools/list": "tools" } as const;
type StepMethod = keyof typeof steps;
const isStepMethod = (method: unknown): method is StepMethod =>
  typeof method === "string" && Object.hasOwn(steps, method);
const stepsOf = (method: string | undefined): ReadonlyArray<Step> =>
  method === "batch" ? ["client", "tools"] : isStepMethod(method) ? [steps[method]] : [];

const Id = Schema.Union([Schema.String, Schema.Number]);
const Request = Schema.Struct({
  id: Id,
  method: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const Result = Schema.Struct({ id: Id, result: Schema.Unknown });

const ClientInfo = Schema.Struct({ name: Schema.String, version: Schema.optional(Schema.String) });
const InitializeParams = Schema.Struct({
  clientInfo: ClientInfo,
  protocolVersion: Schema.optional(Schema.String),
});
const DiscoverParams = Schema.Struct({
  _meta: Schema.Struct({ "io.modelcontextprotocol/clientInfo": ClientInfo }),
});
const servedVersions = new Set(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
const clientVersion = /^\d{1,6}(?:\.\d{1,6}){0,3}$/u;

export const mcpClientProperties = (method: StepMethod, params: unknown) => {
  const initialize =
    method === "initialize" ? Schema.decodeUnknownOption(InitializeParams)(params) : Option.none();
  const info = Option.isSome(initialize)
    ? initialize.value.clientInfo
    : Option.getOrUndefined(
        Option.map(
          Schema.decodeUnknownOption(DiscoverParams)(params),
          (discover) => discover._meta["io.modelcontextprotocol/clientInfo"],
        ),
      );
  const version = Option.isSome(initialize) ? initialize.value.protocolVersion : undefined;
  return {
    client_family: info === undefined ? ("unknown" as const) : clientFamilyOfName(info.name),
    ...(info?.version !== undefined && clientVersion.test(info.version)
      ? { client_version: info.version }
      : {}),
    ...(version !== undefined && servedVersions.has(version) ? { protocol_version: version } : {}),
  };
};

const messages = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];
const answerLimit = 256 * 1024;
const answered = (response: HttpServerResponse.HttpServerResponse): ReadonlyArray<unknown> => {
  if (response.body._tag !== "Uint8Array" || response.body.body.byteLength > answerLimit) return [];
  const text = new TextDecoder().decode(response.body.body).trim();
  const bodies = /^[[{]/u.test(text)
    ? [text]
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
  return bodies.flatMap((body) => messages(Option.getOrUndefined(parseMcpBody(body))));
};

export const makeMcpFirstUse = (storage: Cloudflare.DurableObjectStorage) => {
  const recorded = new Set<Step>();
  const checked = new Set<Step>();
  const key = (step: Step) => `funnel-first-use:${step}`;
  const unrecorded = (wanted: ReadonlyArray<Step>) =>
    wanted.filter((step) => {
      if (!checked.has(step)) {
        checked.add(step);
        try {
          if (storage.kv.get(key(step)) !== undefined) recorded.add(step);
        } catch {
          recorded.add(step);
        }
      }
      return !recorded.has(step);
    });
  return <E, R>(
    access: McpAccess,
    work: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const wanted = stepsOf(request.headers[mcpMethodHeader]);
      if (wanted.length === 0 || unrecorded(wanted).length === 0) return yield* work;
      const text = yield* HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap((web) => Effect.tryPromise(() => web.clone().text())),
        Effect.option,
        Effect.map(Option.getOrUndefined),
      );
      const sent = messages(Option.getOrUndefined(parseMcpBody(text))).flatMap((message) => {
        const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Request)(message));
        return decoded !== undefined && isStepMethod(decoded.method)
          ? [{ id: decoded.id, method: decoded.method, params: decoded.params }]
          : [];
      });
      const response = yield* work;
      if (sent.length === 0) return response;
      const results = new Set(
        answered(response).flatMap((message) => {
          const result = Schema.decodeUnknownOption(Result)(message);
          return Option.isSome(result) ? [result.value.id] : [];
        }),
      );
      for (const message of sent) {
        const step = steps[message.method];
        if (!results.has(message.id) || recorded.has(step)) continue;
        recorded.add(step);
        const now = yield* Clock.currentTimeMillis;
        yield* storage.put(key(step), now, { allowUnconfirmed: true }).pipe(Effect.exit);
        yield* recordMcpFirstUse({
          event: step === "client" ? "mcp_client_initialized" : "mcp_tools_listed",
          userId: access.userId,
          organizationId: access.access.organization,
          clientId: access.clientId,
          properties:
            step === "client"
              ? { method: message.method, ...mcpClientProperties(message.method, message.params) }
              : {},
        });
      }
      return response;
    });
};
