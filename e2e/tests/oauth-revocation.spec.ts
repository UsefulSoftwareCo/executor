/** Account deletion revokes the provider grant through RFC 7009 without ever depending on it. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { oauthMcpAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const SignIn = Schema.Struct({ authorizationUrl: Schema.String });
const Detail = Schema.Struct({ revocation: Schema.Literals(["automatic", "manual"]) });

layer(HostedLive, { excludeTestServices: true })("OAuth revocation", (it) => {
  it.effect(scenarios.oauthRevocation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient,
          browser = yield* Browser;
        const issuer = yield* oauthSetupIssuer;
        const prefix = `/api/organizations/${actors.organization.id}`;
        yield* issuer.configure({ refreshTokens: true, revocation: "recorded" });
        const name = `Revocation ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: oauthMcpAppFiles(name, `${issuer.origin}/mcp`),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(Resource, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );

        /** Connect one account through the real start, consent and callback boundaries. */
        const connect = (label: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
                {},
              ),
            );
            const started = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "oauth", label },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const { authorizationUrl } = yield* body(SignIn, started);
            const callbackUrl = yield* Effect.scoped(
              Effect.gen(function* () {
                const consent = yield* HttpClient.withScope(http).get(authorizationUrl);
                expect(consent.status).toBe(302);
                const location = consent.headers.location;
                if (location === undefined)
                  return yield* Effect.die("Issuer did not return a callback");
                return location;
              }),
            ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
            const completed = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/complete`,
              { callbackUrl },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            return yield* body(Resource, completed);
          });

        /** Revocation runs after the response, so wait for the issuer to observe it. */
        const revocations = (count: number) =>
          issuer.metrics.pipe(
            Effect.map((metrics) => metrics.revocations),
            Effect.flatMap((calls) =>
              calls.length >= count
                ? Effect.succeed(calls)
                : Effect.fail(new Error("Revocation has not arrived")),
            ),
            Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
          );

        /** Delete through the public API. */
        const remove = (account: string) =>
          Effect.gen(function* () {
            expect(
              (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${account}`)).status,
            ).toBe(200);
            return yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          });

        /** The delete dialog tells the person what deleting does at the service. */
        const deleteNotice = (label: string, revocation: "automatic" | "manual") =>
          Effect.gen(function* () {
            yield* browser.use(`Open deleting ${label}`, (page) =>
              page
                .goto(`/org/${actors.organization.slug}/accounts`)
                .then(() =>
                  page.getByRole("button", { name: `Manage ${label}`, exact: true }).click(),
                )
                .then(() =>
                  page.getByRole("menuitem", { name: "Delete account", exact: true }).click(),
                ),
            );
            const notice = yield* browser.use(`Read what deleting ${label} does`, (page) =>
              page
                .getByRole("dialog")
                .getByText(/^This deletes the saved credentials from Executor/)
                .textContent(),
            );
            expect(notice).toContain(
              revocation === "automatic"
                ? `asks ${name} to revoke its access.`
                : `does not revoke access at ${name}. To end access, revoke it there too.`,
            );
            yield* browser.use("Let the menu close and the dialog finish opening", (page) =>
              page.waitForFunction(() =>
                document.getAnimations().every((animation) => animation.playState !== "running"),
              ),
            );
            yield* browser.checkpoint(
              revocation === "automatic" ? "Delete revokes access" : "Delete without revocation",
            );
            yield* browser.use(`Keep ${label}`, (page) =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: "Close", exact: true })
                .click()
                .then(() => page.getByRole("dialog").waitFor({ state: "hidden" })),
            );
          });
        const revocationOf = (account: string) =>
          api
            .request(actors.owner, "GET", `${prefix}/accounts/${account}`)
            .pipe(Effect.flatMap((response) => body(Detail, response)));
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);

        // A successful deletion revokes the refresh token with the grant's own client.
        const revoked = yield* connect("Revoked account");
        // The person is told so before deleting.
        expect(yield* revocationOf(revoked.id)).toEqual({ revocation: "automatic" });
        yield* deleteNotice("Revoked account", "automatic");
        const deleted = yield* remove(revoked.id);
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        // Hosted access checks refuse an account that no longer exists.
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${revoked.id}`)).status,
        ).toBe(403);
        expect(yield* revocations(1)).toEqual([
          { token: "refresh", hint: "refresh_token", clientAuthenticated: true },
        ]);

        // A failing revocation endpoint never blocks or rolls back the deletion.
        yield* issuer.configure({ revocation: "failing" });
        const kept = yield* connect("Revocation fails");
        const removed = yield* remove(kept.id);
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/accounts/${kept.id}`)).status,
        ).toBe(403);
        expect((yield* revocations(2))[1]).toEqual({
          token: "refresh",
          hint: "refresh_token",
          clientAuthenticated: true,
        });

        // A service without a revocation endpoint is never asked, and the person is told to
        // revoke access there themselves.
        yield* issuer.configure({ revocation: "none" });
        const unrevocable = yield* connect("No revocation");
        expect(yield* revocationOf(unrevocable.id)).toEqual({ revocation: "manual" });
        yield* deleteNotice("No revocation", "manual");
        const unrevoked = yield* remove(unrevocable.id);
        expect(unrevoked.status, JSON.stringify(unrevoked.body)).toBe(200);
        expect((yield* issuer.metrics).revocations).toHaveLength(2);
      }),
    ),
  );
});
