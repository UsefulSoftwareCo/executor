/** HTTP serialization for normalized OpenAPI operations. */
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  OpenapiError,
  type CredentialBinding,
  type OpenapiOperation,
  type OpenapiAccount,
} from "../contracts/openapi.ts";

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  throw new Error("This parameter requires scalar values");
}
function pairs(value: unknown): readonly (readonly [string, string])[] {
  return Object.entries(object(value)).map(([key, item]) => [key, scalar(item)] as const);
}
function simple(value: unknown, explode: boolean, encode: boolean): string {
  const token = (value: unknown) => (encode ? encodeURIComponent(scalar(value)) : scalar(value));
  if (Array.isArray(value)) return value.map(token).join(",");
  if (typeof value === "object" && value !== null)
    return pairs(value)
      .map(([key, item]) => token(key) + (explode ? "=" : ",") + token(item))
      .join(",");
  return token(value);
}
/** Create request helpers from credential-free generated authentication metadata. */
export function createRequest(config: {
  readonly methods: Readonly<Record<string, readonly CredentialBinding[]>>;
  readonly oauth: readonly string[];
}) {
  const { methods, oauth } = config;
  function schemes(method: string | undefined): string[] {
    if (method === undefined) return [];
    if (oauth.includes(method)) return [method];
    const bindings = Object.hasOwn(methods, method) ? methods[method] : undefined;
    return bindings?.map((binding) => binding.scheme) ?? [];
  }
  function selectedSecurity(
    op: OpenapiOperation,
    method: string | undefined,
  ): readonly string[] | undefined {
    if (op.streaming === true) return undefined;
    if (!op.security.length) return [];
    const supported = schemes(method);
    return op.security.find((keys) => keys.every((key) => supported.includes(key)));
  }
  const call = (op: OpenapiOperation, input: unknown, account: OpenapiAccount | undefined) =>
    Effect.scoped(
      Effect.gen(function* () {
        const prepared = yield* Effect.try({
          try: () => {
            const args = object(input);
            const security = selectedSecurity(op, account?.method);
            if (security === undefined)
              throw new Error("The selected account cannot call this tool");
            let path = op.path;
            const query = new URLSearchParams();
            const headers = new Headers();
            for (const p of op.parameters) {
              const group = args[p.in === "header" ? "headers" : p.in];
              const value = group === undefined ? undefined : object(group)[p.name];
              if (value === undefined) continue;
              if (p.in === "path")
                path = path.replaceAll("{" + p.name + "}", simple(value, p.explode, true));
              else if (p.in === "header") headers.set(p.name, simple(value, p.explode, false));
              else if (p.style === "deepObject") {
                for (const [key, item] of pairs(value))
                  query.append(p.name + "[" + key + "]", item);
              } else if (Array.isArray(value)) {
                if (p.explode && p.style === "form")
                  for (const item of value) query.append(p.name, scalar(item));
                else
                  query.append(
                    p.name,
                    value
                      .map(scalar)
                      .join(
                        p.style === "spaceDelimited"
                          ? " "
                          : p.style === "pipeDelimited"
                            ? "|"
                            : ",",
                      ),
                  );
              } else if (typeof value === "object" && value !== null) {
                if (p.style !== "form") throw new Error("Unsupported object parameter style");
                if (p.explode) for (const [key, item] of pairs(value)) query.append(key, item);
                else query.append(p.name, pairs(value).flat().join(","));
              } else query.append(p.name, scalar(value));
            }
            if (/{[^}]+}/.test(path)) throw new Error("A required path parameter is missing");
            const url = new URL(op.baseUrl + path);
            if (account && Object.hasOwn(methods, account.method)) {
              for (const binding of methods[account.method] ?? []) {
                if (!security.includes(binding.scheme)) continue;
                const credential = binding.prefix + scalar(account.fields[binding.field]);
                if (binding.in === "header") headers.set(binding.name, credential);
                else query.set(binding.name, credential);
              }
            } else if (
              account &&
              oauth.includes(account.method) &&
              security.includes(account.method)
            ) {
              headers.set("Authorization", "Bearer " + scalar(account.fields.access_token));
            }
            url.search = query.toString();
            let body: string | Uint8Array<ArrayBuffer> | undefined;
            if (args.body !== undefined) {
              if (op.body === "json") {
                headers.set("Content-Type", "application/json");
                body = JSON.stringify(args.body);
              } else if (op.body === "base64") {
                headers.set("Content-Type", "application/octet-stream");
                body = Uint8Array.from(atob(scalar(args.body)), (char) => char.charCodeAt(0));
              }
            }
            return { url, headers, body, method: op.method };
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
        if (response.status < 200 || response.status >= 300)
          return yield* new OpenapiError({ reason: "request", status: response.status });
        if (response.status === 204 || prepared.method === "HEAD") return null;
        return yield* (
          response.headers["content-type"]?.includes("json") ? response.json : response.text
        ).pipe(Effect.withSpan("provider.http.response.read"));
      }),
    ).pipe(
      Effect.withSpan("provider.openapi.call", {
        attributes: { "executor.tool.name": op.name, "http.request.method": op.method },
      }),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((error) =>
        error instanceof OpenapiError ? error : new OpenapiError({ reason: "request" }),
      ),
    );
  return {
    available: (op: OpenapiOperation, method: string | undefined) =>
      selectedSecurity(op, method) !== undefined,
    call,
  };
}
