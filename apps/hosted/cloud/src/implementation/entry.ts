import { browserReturnTo, type BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import type { AuthenticationUnavailable } from "@executor-js/hosted-server";
import { Effect, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { CloudEntry, CloudEntryPage } from "../contracts/entry.ts";
import { Onboarding, OnboardingInvitation, OnboardingReady } from "../contracts/onboarding.ts";
import { passkeyEnrollmentCookie } from "../contracts/passkey-enrollment.ts";
import { reportCloudFailure } from "./error-reporting.ts";

const privateHeaders = {
  "cache-control": "private, no-store",
  vary: "Cookie",
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
};

/** Resolve sign-in and first-team entry using the current request's verified session. */
export const resolveCloudEntry = (
  session: (headers: Headers) => Effect.Effect<BrowserSession, AuthenticationUnavailable>,
  page: "login" | "login/sso" | "create",
  redirect: string,
  headers: Headers,
) =>
  Effect.gen(function* () {
    const current = yield* session(headers);
    if (current === null)
      return page !== "create"
        ? CloudEntryPage.make({
            kind: "page",
            path: `/${page}`,
            session: null,
            onboarding: null,
            passkeyEnrollment: false,
          })
        : { kind: "redirect" as const, location: "/login?redirect=%2Fcreate" };
    // The page cannot read this browser's cookie while the server renders it, so it gets the answer.
    const enrollment = (headers.get("cookie") ?? "")
      .split(";")
      .some(
        (cookie) =>
          cookie.trim() ===
          `${passkeyEnrollmentCookie.name}=${encodeURIComponent(current.user.id)}`,
      );
    if (page !== "create") {
      if (enrollment)
        return CloudEntryPage.make({
          kind: "page",
          path: "/login",
          session: current,
          onboarding: null,
          passkeyEnrollment: true,
        });
      const destination = browserReturnTo(redirect);
      if (destination !== "/" && destination !== "/create")
        return { kind: "redirect" as const, location: destination };
    }
    const onboarding = yield* Onboarding;
    const entry = yield* onboarding.prepare(current.user.id);
    if (Schema.is(OnboardingInvitation)(entry))
      return {
        kind: "redirect" as const,
        location: `/invite?invitation=${encodeURIComponent(entry.invitation)}`,
      };
    if (Schema.is(OnboardingReady)(entry)) {
      const only = entry.organizations.length === 1 ? entry.organizations[0] : undefined;
      if (only)
        return {
          kind: "redirect" as const,
          location: `/org/${encodeURIComponent(only.slug)}/apps`,
        };
      return CloudEntryPage.make({
        kind: "page",
        path: entry.organizations.length > 0 ? "/" : "/create",
        session: current,
        onboarding: entry,
        passkeyEnrollment: enrollment,
      });
    }
    return CloudEntryPage.make({
      kind: "page",
      path: "/create",
      session: current,
      onboarding: entry,
      passkeyEnrollment: enrollment,
    });
  });

/**
 * Redirect before any HTML, or render the selected page with its resolved setup data. A page
 * resolved for another address, such as team setup after sign-in, is opened at that address.
 */
export const cloudEntryDocument = <E, R, E2, R2>(
  entry: Effect.Effect<CloudEntry, E, R>,
  render: (entry: CloudEntryPage) => Effect.Effect<HttpServerResponse.HttpServerResponse, E2, R2>,
) =>
  Effect.gen(function* () {
    const resolved = yield* entry;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requested = new URL(request.url, "https://entry.invalid").pathname.replace(
      /(.)\/$/,
      "$1",
    );
    if (resolved.kind === "redirect" || resolved.path !== requested)
      return HttpServerResponse.empty({
        status: 302,
        headers: {
          ...privateHeaders,
          location: resolved.kind === "redirect" ? resolved.location : resolved.path,
        },
      });
    return yield* render(resolved);
  }).pipe(
    Effect.tapCause(reportCloudFailure),
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.html(
          '<!doctype html><title>Unable to open Executor</title><main><h1>Unable to open Executor</h1><p>Please try again.</p><a href="">Try again</a></main>',
        ).pipe(HttpServerResponse.setStatus(503), HttpServerResponse.setHeaders(privateHeaders)),
      ),
    ),
  );

/** The development document adapter shares the Worker's resolver through this private HTTP response. */
export const cloudEntryApi = (session: Parameters<typeof resolveCloudEntry>[0]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "https://entry.invalid");
    const page = url.searchParams.get("page");
    if (page !== "login" && page !== "login/sso" && page !== "create")
      return HttpServerResponse.empty({ status: 400, headers: privateHeaders });
    const result = yield* resolveCloudEntry(
      session,
      page,
      browserReturnTo(url.searchParams.get("redirect")),
      new Headers(request.headers),
    );
    return yield* HttpServerResponse.json(result, { headers: privateHeaders });
  });
