import "../contracts/swagger-client.ts";
import SwaggerClient from "swagger-client";
import { httpProviderError, accountProviderError } from "./provider-error.ts";
import { ProviderError } from "../contracts/provider-error.ts";
/** Swagger constructs requests; Effect owns HTTP policy and bounded results. */
import { Effect, Encoding, Option, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import {
  OpenapiResponseError,
  ApiErrorRecovery,
  ApiErrorResponse,
  defaultOpenapiErrorLimits,
} from "../contracts/api-response-error.ts";

import {
  OpenapiError,
  defaultOpenapiResponseLimits,
  isOpenapiTextMedia,
  openapiMediaKind,
  type CredentialBinding,
  type OpenapiOperation,
  type OpenapiAccount,
  type OpenapiErrorResponse,
} from "../contracts/openapi.ts";

type DeclaredError = OpenapiErrorResponse & { readonly decoder: Schema.Decoder<Schema.Json> };

// Recovery is optional for arbitrary APIs: a missing or malformed value keeps the declared error.
const bodyRecovery = Schema.decodeUnknownOption(Schema.Struct({ recovery: ApiErrorRecovery }));

// Read once with byte/time bounds. Unsupported or invalid responses retain the generic failure.
function responseError(
  response: HttpClientResponse.HttpClientResponse,
  errors: readonly DeclaredError[],
) {
  return Effect.gen(function* () {
    const candidates = errors.filter((error) => error.status === response.status);
    if (
      candidates.length === 0 ||
      !/^application\/(?:[\w.-]+\+)?json$/i.test(
        response.headers["content-type"]?.split(";")[0]?.trim() ?? "",
      )
    )
      return;
    const length = response.headers["content-length"];
    if (length !== undefined && Number(length) > defaultOpenapiErrorLimits.maxBodyBytes) return;
    const json = yield* response.stream.pipe(
      Stream.mapError(() => new OpenapiError({ reason: "request", status: response.status })),
      Stream.limitBytes(defaultOpenapiErrorLimits.maxBodyBytes, () =>
        Stream.fail(new OpenapiError({ reason: "request", status: response.status })),
      ),
      Stream.decodeText,
      Stream.mkString,
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
      Effect.timeout(defaultOpenapiErrorLimits.readTimeoutMs),
    );
    for (const candidate of candidates) {
      const parsed = yield* Schema.decodeUnknownEffect(candidate.decoder)(json).pipe(Effect.option);
      if (Option.isSome(parsed)) {
        const message =
          candidate.message.source === "schema"
            ? Option.some({ message: candidate.message.value })
            : Schema.decodeUnknownOption(
                Schema.Struct({ message: ApiErrorResponse.fields.message }),
              )(parsed.value);
        if (Option.isNone(message)) continue;
        const recovery = bodyRecovery(parsed.value);
        return new OpenapiResponseError({
          code: candidate.code,
          status: response.status,
          message: message.value.message,
          ...(Option.isSome(recovery) ? { recovery: recovery.value.recovery } : {}),
        });
      }
    }
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  throw new Error("This parameter requires scalar values");
}
const swaggerRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    url: Schema.String,
    method: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.optional(
      Schema.Union([Schema.String, Schema.instanceOf(Blob), Schema.instanceOf(FormData)]),
    ),
  }),
);
const bytes = (value: unknown) =>
  Uint8Array.from(atob(scalar(value)), (char) => char.charCodeAt(0));
/** Create request helpers from credential-free generated authentication metadata. */
export function createRequest(config: {
  readonly methods: Readonly<Record<string, readonly CredentialBinding[]>>;
  readonly oauth: readonly string[];
}) {
  const { methods, oauth } = config;
  function selectedCredentials(op: OpenapiOperation, account: OpenapiAccount | undefined) {
    if (op.streaming === true) return undefined;
    const authorized: Record<string, unknown> = {};
    if (account !== undefined) {
      if (oauth.includes(account.method)) {
        const token = account.fields.access_token;
        if (typeof token === "string" && token.length > 0)
          authorized[account.method] = { token: { access_token: token } };
      } else if (Object.hasOwn(methods, account.method)) {
        const bindings = methods[account.method] ?? [];
        for (const scheme of new Set(bindings.map((binding) => binding.scheme))) {
          const parts = bindings.filter((binding) => binding.scheme === scheme);
          if (
            parts.some(
              ({ field }) =>
                typeof account.fields[field] !== "string" || account.fields[field] === "",
            )
          )
            continue;
          for (const { part, field, prefix } of parts) {
            const value = scalar(account.fields[field]);
            authorized[scheme] =
              part === "value"
                ? prefix + value
                : { ...object(authorized[scheme] ?? {}), [part]: value };
          }
        }
      }
    }
    const security = op.request.security;
    const keys =
      security.length === 0
        ? []
        : security
            .map(Object.keys)
            .find((keys) => keys.every((key) => Object.hasOwn(authorized, key)));
    return keys === undefined
      ? undefined
      : Object.fromEntries(keys.map((key) => [key, authorized[key]]));
  }
  const call = (
    op: OpenapiOperation,
    input: unknown,
    account: OpenapiAccount | undefined,
    errors: readonly DeclaredError[],
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const prepared = yield* Effect.try({
          try: () => {
            const args = object(input);
            const authorized = selectedCredentials(op, account);
            if (authorized === undefined)
              throw new Error("The selected account cannot call this tool");
            const parameters: Record<string, unknown> = {};
            for (const p of op.request.parameters) {
              const group = args[p.in === "header" ? "headers" : p.in];
              if (group !== undefined) parameters[`${p.in}.${p.name}`] = object(group)[p.name];
            }
            const content = op.request.requestBody?.content ?? {};
            const contentType =
              args.contentType === undefined ? Object.keys(content)[0] : scalar(args.contentType);
            const media = contentType === undefined ? undefined : content[contentType];
            let body: unknown = args.body;
            if (body !== undefined && media !== undefined && contentType !== undefined) {
              const kind = openapiMediaKind(contentType);
              if (kind === "json") body = JSON.stringify(body);
              else if (kind === "binary") body = new Blob([bytes(body)]);
              else if (kind === "multipart") {
                const fields = { ...object(body) };
                for (const [name, property] of Object.entries(
                  object(media.schema?.properties ?? {}),
                )) {
                  const shape = object(property);
                  if (
                    shape.type === "string" &&
                    shape.format === "binary" &&
                    fields[name] !== undefined
                  )
                    fields[name] = new File([bytes(fields[name])], name);
                }
                body = fields;
              }
            }
            const prepared = swaggerRequest(
              SwaggerClient.buildRequest({
                spec: {
                  openapi: op.openapi,
                  servers: [{ url: op.baseUrl }],
                  components: { securitySchemes: op.securitySchemes },
                  paths: {
                    [op.path]: {
                      [op.method.toLowerCase()]: { ...op.request, operationId: op.name },
                    },
                  },
                },
                operationId: op.name,
                pathName: op.path,
                method: op.method.toLowerCase(),
                parameters,
                securities: { authorized },
                ...(contentType === undefined ? {} : { requestContentType: contentType }),
                ...(body === undefined ? {} : { requestBody: body }),
              }),
            );
            // The account is authorized for the pinned API origin only. Redirects
            // stay manual so a provider cannot forward credentials to another host.
            const url = new URL(prepared.url);
            if (url.origin !== new URL(op.baseUrl).origin || url.username || url.password)
              throw new Error("The request escaped its API origin");
            const headers = new Headers(prepared.headers);
            if (prepared.body instanceof FormData) headers.delete("content-type");
            return { ...prepared, url, headers };
          },
          catch: () => new OpenapiError({ reason: "invalid_input" }),
        });
        const client = yield* HttpClient.HttpClient;
        const request = yield* Effect.try({
          try: () =>
            HttpClientRequest.fromWeb(
              new Request(prepared.url, {
                method: prepared.method,
                headers: prepared.headers,
                ...(prepared.body === undefined ? {} : { body: prepared.body }),
              }),
            ),
          catch: () => new OpenapiError({ reason: "invalid_input" }),
        });
        const response = yield* HttpClient.withScope(client).execute(request);
        if (response.status < 200 || response.status >= 300) {
          const provider = httpProviderError(response.status, response.headers);
          if (provider !== undefined) return yield* provider;
          const declared = yield* responseError(response, errors);
          return yield* (
            declared ?? new OpenapiError({ reason: "request", status: response.status })
          );
        }
        if (response.status === 204 || prepared.method === "HEAD") return null;
        const contentType = response.headers["content-type"] ?? "text/plain";
        const chunks = yield* response.stream.pipe(
          Stream.mapError(() => new OpenapiError({ reason: "request" })),
          Stream.limitBytes(defaultOpenapiResponseLimits.maxBodyBytes, () =>
            Stream.fail(new OpenapiError({ reason: "request" })),
          ),
          Stream.runCollect,
          Effect.timeout(defaultOpenapiResponseLimits.readTimeoutMs),
          Effect.withSpan("provider.http.response.read"),
        );
        const data = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        if (!isOpenapiTextMedia(contentType))
          return { base64: Encoding.encodeBase64(data), contentType };
        const text = new TextDecoder().decode(data);
        return contentType.includes("json") && !contentType.includes("ndjson")
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text)
          : text;
      }),
    ).pipe(
      Effect.withSpan("provider.openapi.call", {
        attributes: { "executor.tool.name": op.name, "http.request.method": op.method },
      }),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((error) =>
        error instanceof ProviderError && account?.id !== undefined
          ? accountProviderError(error, account.id)
          : error instanceof OpenapiError ||
              error instanceof OpenapiResponseError ||
              error instanceof ProviderError
            ? error
            : new OpenapiError({ reason: "request" }),
      ),
    );
  return {
    available: (op: OpenapiOperation, account: OpenapiAccount | undefined) =>
      selectedCredentials(op, account) !== undefined,
    call,
  };
}
