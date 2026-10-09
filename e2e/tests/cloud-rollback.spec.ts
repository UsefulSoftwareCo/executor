/**
 * Cloud's rollback switch (`CLOUD_BROWSER_ORIGIN=deployment`, `notes/cloud-domains.md`) moves the
 * dashboard and sign-in back to the deployment origin (`v2.executor.sh`'s place) and nothing else:
 * `app.` sends its pages there, while the role hosts, the issuer on the edge, the canonical
 * resources and the edge's provider returns stay as they are, so grants keep working.
 *
 * The run's one local Cloud starts with the switch on (`e2e:cloud --rollback`), so the grant here
 * is obtained under it. A grant obtained before the switch, on a redeployed stage, is checked on
 * a test stage (`notes/cloud-domains.md#rollback`).
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Emulators } from "../support/emulators.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth, type Grant } from "../support/mcp-oauth.ts";
import { Onboarding } from "../support/onboarding.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, roleHost, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const AuthorizationServer = Schema.fromJsonString(
  Schema.Struct({
    issuer: Schema.String,
    authorization_endpoint: Schema.String,
    token_endpoint: Schema.String,
    registration_endpoint: Schema.String,
  }),
);
const ProtectedResource = Schema.fromJsonString(
  Schema.Struct({ resource: Schema.String, authorization_servers: Schema.Array(Schema.String) }),
);
const accessToken = (grant: Grant) => Redacted.value(grant.tokens).access_token;
const html = { headers: { accept: "text/html" } };

layer(HostedLive, { excludeTestServices: true })("Cloud rollback switch", (it) => {
  it.effect(scenarios.cloudRollbackSwitch.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          actors = yield* Actors,
          browser = yield* Browser,
          onboarding = yield* Onboarding,
          oauth = yield* McpOAuth,
          clients = yield* McpClient;
        const { deployment, browser: signIn, mcp, edge } = targetHosts(target);
        const app = roleHost(deployment, "app");
        // Under the switch the browser origin is the deployment origin.
        expect(signIn).toBe(deployment);

        // The deployment origin serves its pages again; `app.` sends them there for now, with
        // path and query, and keeps answering everything else, such as the session endpoint.
        expect((yield* rawRequest(`${deployment}/login`, html)).status).toBe(200);
        for (const path of [
          "/",
          "/login?redirect=%2Forg%2Fexample",
          `/org/${actors.organization.slug}/apps`,
          "/api/auth/oauth2/authorize?client_id=example&state=s",
        ]) {
          const page = yield* rawRequest(`${app}${path}`, html);
          expect(page.status, path).toBe(307);
          expect(page.location, path).toBe(`${deployment}${path}`);
          expect(page.cacheControl, path).toBe("no-store");
        }
        expect((yield* rawRequest(`${app}/api/auth/get-session`)).status).toBe(200);

        // The issuer and its metadata stay on the edge; the endpoints follow sign-in.
        const issuer = `${edge}/api/auth`;
        const metadata = yield* rawRequest(
          `${edge}/.well-known/oauth-authorization-server/api/auth`,
        );
        expect(metadata.status).toBe(200);
        expect(yield* Schema.decodeUnknownEffect(AuthorizationServer)(metadata.text)).toEqual({
          issuer,
          authorization_endpoint: `${deployment}/api/auth/oauth2/authorize`,
          token_endpoint: `${deployment}/api/auth/oauth2/token`,
          registration_endpoint: `${deployment}/api/auth/oauth2/register`,
        });
        // `mcp.` is still the canonical MCP resource, and names the same issuer.
        const resource = yield* rawRequest(`${mcp}/.well-known/oauth-protected-resource/mcp`);
        expect(resource.status).toBe(200);
        expect(yield* Schema.decodeUnknownEffect(ProtectedResource)(resource.text)).toEqual({
          resource: `${mcp}/mcp`,
          authorization_servers: [issuer],
        });

        // A provider still returns to the edge, which now sends the browser to the deployment
        // origin, where the sign-in's state cookie is. A real social sign-in completes there.
        const callback = "/api/auth/callback/google?code=single-use&state=signed";
        const bounced = yield* rawRequest(`${edge}${callback}`);
        expect(bounced.status).toBe(302);
        expect(bounced.location).toBe(`${deployment}${callback}`);
        // A connected-account sign-in returns to the deployment origin's callback, which sends it
        // to the callback page there; the edge's callback, kept for the move, does the same.
        const account = "?state=x2.synthetic-state&code=single-use";
        for (const origin of [deployment, edge]) {
          const accountReturn = yield* rawRequest(`${origin}/api/oauth/callback${account}`);
          expect(accountReturn.status).toBe(302);
          expect(accountReturn.location).toBe(`${deployment}/oauth/callback${account}`);
        }
        yield* onboarding.socialSignIn("google");
        const signedIn = yield* browser.use("Read the signed-in page", (page) =>
          Promise.resolve(page.url()),
        );
        expect(new URL(signedIn).origin).toBe(deployment);

        // An MCP grant for `mcp.`, consented on the deployment origin, calls a tool there and at
        // the deployment origin, and refreshes at the deployment origin's token endpoint and at
        // `app.`'s, where a client that found the endpoints before the rollback still sends it.
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorizeAt("mcp", mcp);
        expect(grant.resource).toBe(`${mcp}/mcp`);
        const listTools = (token: string, label: string, at: string) =>
          Effect.gen(function* () {
            const client = yield* clients.connect(Redacted.make(token), label, { origin: at });
            const tools = yield* client.use("List tools", (client, signal) =>
              client.listTools(undefined, { signal }),
            );
            expect(tools.tools.length, label).toBeGreaterThan(0);
          }).pipe(Effect.scoped);
        yield* listTools(accessToken(grant), "grant-on-mcp", mcp);
        yield* listTools(accessToken(grant), "grant-on-deployment", deployment);
        const refreshed = yield* oauth.refresh(grant);
        yield* listTools(accessToken(refreshed), "refreshed-on-mcp", mcp);
        const refreshedAtApp = yield* oauth.refresh(refreshed, app);
        yield* listTools(accessToken(refreshedAtApp), "refreshed-at-app-on-mcp", mcp);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(McpOAuth.layer, McpClient.layer, Onboarding.layer, Emulators.layer),
        ),
      ),
    ),
  );
});
