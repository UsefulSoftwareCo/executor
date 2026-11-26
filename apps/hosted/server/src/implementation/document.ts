import type { DocumentApi } from "@executor-js/dashboard-start/document-api";
import { Config, Effect, Schema } from "effect";
import { AuthenticationUnavailable } from "../contracts/auth.ts";
import {
  BrowserSession,
  lastOrganizationCookie,
  readLastOrganization,
  type HostedDocumentContext,
} from "../contracts/browser.ts";
import { Cookies, HttpServerRequest } from "effect/http";
import type { ResourceOrigins } from "@executor-js/mcp-auth";

export const hostedDocumentContext = (resourceOrigins: ResourceOrigins) => (api: DocumentApi) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const response = yield* Effect.tryPromise({
      try: () => api.apiFetch("/api/auth/get-session"),
      catch: () => new AuthenticationUnavailable(),
    });
    if (!response.ok) return yield* new AuthenticationUnavailable();
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new AuthenticationUnavailable(),
    });
    const session = yield* Schema.decodeUnknownEffect(BrowserSession)(body).pipe(
      Effect.mapError(() => new AuthenticationUnavailable()),
    );
    const saved = Cookies.parseHeader(request.headers.cookie ?? "")[
      lastOrganizationCookie(
        request.headers.host ?? "",
        new URL(yield* Config.String("BETTER_AUTH_URL")).protocol === "https:",
      )
    ];
    return {
      session,
      lastOrganization: readLastOrganization(saved, session),
      resourceOrigins,
    } satisfies HostedDocumentContext;
  }).pipe(Effect.withSpan("dashboard.session"));
