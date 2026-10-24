/** Host-specific authenticated clients shared by app commands. */
import { Config, Effect, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ExecutorApi } from "@executor-js/sdk/core";
import { AppClientError, HostRecovery, HostRequestFailed } from "../client-error.ts";
import { AppAccess, appManagementApi } from "../contracts/api.ts";
import { frameworkApi } from "../contracts/framework.ts";
import { RegistryOrigin, registrySession } from "./node-auth.ts";

/** Resolve the credential and, for hosted Executor, the organization every request targets. */
export const access = (
  host: string,
  organization: Option.Option<string>,
  auth: "default" | "session" = "default",
) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(
      Effect.mapError(() => new AppClientError({ reason: "authentication" })),
    );
    const token =
      auth === "session"
        ? Option.none()
        : yield* Config.Redacted("EXECUTOR_ACCESS_TOKEN").pipe(Config.option);
    if (Option.isSome(token)) {
      if (Option.isNone(organization))
        return yield* new AppClientError({ reason: "authentication" });
      return { token: token.value, organization: organization.value };
    }
    const local =
      auth === "session"
        ? Option.none()
        : yield* Config.Redacted("EXECUTOR_API_KEY").pipe(Config.option);
    if (
      Option.isSome(local) &&
      Option.isNone(organization) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(host).hostname)
    )
      return { token: local.value, organization: undefined };
    const session = Redacted.value(yield* registrySession(host));
    if (Option.isSome(organization) && organization.value !== session.organization)
      return yield* new AppClientError({ reason: "forbidden" });
    return { token: Redacted.make(session.accessToken), organization: session.organization };
  });
/** Authenticated requests to the host; redirects are refused so credentials never follow them. */
const transport = (host: string, token: Redacted.Redacted<string>, path = (url: string) => url) =>
  Effect.map(HttpClient.HttpClient, (client) =>
    client.pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.updateUrl((url) => host + path(url)),
          HttpClientRequest.bearerToken(token),
        ),
      ),
      HttpClient.transform((response) =>
        Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "error" }),
      ),
    ),
  ).pipe(Effect.provide(FetchHttpClient.layer));
/** An Executor API error body this CLI's contract does not declare, as every Executor host writes it. */
const HostAnswer = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    recovery: Schema.optional(HostRecovery),
  }),
);
/** Read a host's own JSON error from a bounded body; any other response text is never kept. */
const hostAnswer = (response: HttpClientResponse.HttpClientResponse) =>
  /^application\/(?:[\w.-]+\+)?json$/i.test(
    response.headers["content-type"]?.split(";")[0]?.trim() ?? "",
  ) && Number(response.headers["content-length"] ?? 0) <= 65_536
    ? response.text.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(HostAnswer)),
        Effect.map(({ _tag, message, recovery }) => ({
          code: _tag,
          message,
          ...(recovery === undefined ? {} : { recovery }),
        })),
        Effect.option,
      )
    : Effect.succeedNone;
/**
 * A response outside the operation's contract keeps its method, path, status and any Executor
 * error the body states, so the command can say what the host answered. Credentials and other
 * response text are never kept.
 */
export const hostFailure = (error: HttpClientError.HttpClientError | Schema.SchemaError) =>
  Effect.gen(function* () {
    if (!HttpClientError.isHttpClientError(error))
      return new HostRequestFailed({ reason: "response" });
    const request = {
      method: error.request.method,
      ...(URL.canParse(error.request.url) ? { path: new URL(error.request.url).pathname } : {}),
    };
    const response = error.response;
    if (response === undefined) return new HostRequestFailed({ reason: "network", ...request });
    if (response.status === 401) return new AppClientError({ reason: "authentication" });
    const answer = yield* hostAnswer(response);
    if (response.status === 403 && Option.isNone(answer))
      return new AppClientError({ reason: "forbidden" });
    return new HostRequestFailed({
      reason: response.status < 400 ? "response" : "status",
      ...request,
      status: response.status,
      ...(Option.isSome(answer) ? { answer: answer.value } : {}),
    });
  }).pipe(Effect.flatMap(Effect.fail));
export const isTransportFailure = (
  error: unknown,
): error is HttpClientError.HttpClientError | Schema.SchemaError =>
  HttpClientError.isHttpClientError(error) || Schema.isSchemaError(error);
const localManagementApi = appManagementApi("/api", AppAccess);
const hostedManagementApi = appManagementApi("/api/organizations/:organization", AppAccess);
const localFrameworkApi = frameworkApi("/api", AppAccess);
const hostedFrameworkApi = frameworkApi("/api/organizations/:organization", AppAccess);
/** Both hosts serve one app management contract; hosted routes add the organization. */
type Management = HttpApiClient.ForApi<typeof localManagementApi>["appManagement"];
type Framework = HttpApiClient.ForApi<typeof localFrameworkApi>["framework"];
/**
 * Typed clients for one host. App management uses its shared contract. Skill reads use the SDK
 * routes: local serves them under /v1, and hosted serves the same endpoints and
 * schemas under its organization prefix.
 */
export const connect = (
  host: string,
  organization: Option.Option<string>,
  auth: "default" | "session" = "default",
) =>
  Effect.gen(function* () {
    const target = yield* access(host, organization, auth);
    const httpClient = yield* transport(host, target.token);
    if (target.organization === undefined) {
      const client = yield* HttpApiClient.makeWith(localManagementApi, { httpClient });
      const management: Management = client.appManagement;
      const framework: Framework = (yield* HttpApiClient.makeWith(localFrameworkApi, {
        httpClient,
      })).framework;
      return {
        token: target.token,
        management,
        framework,
        tenant: {},
        skills: yield* HttpApiClient.group(ExecutorApi, { group: "skills", httpClient }),
      };
    }
    const prefix = `/api/organizations/${encodeURIComponent(target.organization)}`;
    const sdkClient = yield* transport(host, target.token, (url) =>
      url.replace(/^\/v1\//, `${prefix}/`),
    );
    const client = yield* HttpApiClient.makeWith(hostedManagementApi, { httpClient });
    const management: Management = client.appManagement;
    const framework: Framework = (yield* HttpApiClient.makeWith(hostedFrameworkApi, { httpClient }))
      .framework;
    return {
      token: target.token,
      management,
      framework,
      tenant: { organization: target.organization },
      skills: yield* HttpApiClient.group(ExecutorApi, { group: "skills", httpClient: sdkClient }),
    };
  });
/** Run one app management operation; contract errors stay typed for command diagnostics. */
export const manage = <A, E>(
  host: string,
  organization: Option.Option<string>,
  operation: (
    api: Management,
    tenant: { readonly organization?: string },
  ) => Effect.Effect<A, E | HttpClientError.HttpClientError | Schema.SchemaError>,
) =>
  connect(host, organization).pipe(
    Effect.flatMap(({ management, tenant }) => operation(management, tenant)),
    Effect.catchIf(isTransportFailure, hostFailure),
  );
