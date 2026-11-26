import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { Actors, freshOwnerSession, password } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth, type Grant } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";
import { serverControl } from "../support/server-control.ts";

const minute = 60_000;
const day = 24 * 60 * minute;
const Agents = Schema.Array(Schema.Struct({ id: Schema.String }));

layer(HostedLive, { excludeTestServices: true })("MCP OAuth refresh", (it) => {
  it.effect(scenarios.mcpStaleRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        yield* browser.login(actors.owner);
        const stored = yield* evidence.step("Authorize one MCP grant", oauth.authorize);
        const first = yield* evidence.step(
          "The first instance refreshes the stored grant",
          oauth.refresh(stored),
        );
        const active = yield* mcp.connect(
          Redacted.make(Redacted.value(first.tokens).access_token),
          "active-instance",
        );
        const listed = yield* active.use("The first instance lists tools", (client) =>
          client.listTools(),
        );
        expect(listed.tools.length).toBeGreaterThan(0);
        const sibling = yield* evidence.step(
          "A sibling instance refreshes with the token it loaded earlier",
          oauth.refresh(stored),
        );
        const same =
          Redacted.value(sibling.tokens).access_token ===
            Redacted.value(first.tokens).access_token &&
          Redacted.value(sibling.tokens).refresh_token ===
            Redacted.value(first.tokens).refresh_token;
        expect(same).toBe(true);
        const stillListed = yield* active.use(
          "The first instance stays signed in after its sibling's refresh",
          (client) => client.listTools(),
        );
        expect(stillListed.tools.length).toBe(listed.tools.length);
        const next = yield* evidence.step(
          "The shared grant keeps refreshing",
          oauth.refresh(first),
        );
        const renewed = yield* mcp.connect(
          Redacted.make(Redacted.value(next.tokens).access_token),
          "renewed-instance",
        );
        yield* renewed.use("The renewed token lists tools", (client) => client.listTools());
        yield* evidence.step(
          "Revoking the grant still ends every copy",
          Effect.gen(function* () {
            yield* oauth.revoke(next);
            expect(yield* oauth.refreshStatus(next)).toBe(400);
            expect(yield* oauth.refreshStatus(stored)).toBe(400);
            const denied = yield* api.request(yield* api.session(), "GET", "/mcp", undefined, {
              authorization: `Bearer ${Redacted.value(next.tokens).access_token}`,
            });
            expect(denied.status).toBe(401);
          }),
        );
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
  it.effect(scenarios.mcpLateRefreshReuse.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth;
        yield* browser.login(actors.owner);
        const stored = yield* evidence.step("Authorize one MCP grant", oauth.authorize);
        const first = yield* evidence.step(
          "The first instance refreshes the stored grant",
          oauth.refresh(stored),
        );
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 59 * 60_000 });
        yield* serverControl("start");
        const sibling = yield* evidence.step(
          "A sibling refreshes with the rotated token 59 minutes later",
          oauth.refresh(stored),
        );
        const joined =
          Redacted.value(sibling.tokens).refresh_token ===
          Redacted.value(first.tokens).refresh_token;
        expect(joined).toBe(true);
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 2 * 60_000 });
        yield* serverControl("start");
        const current = yield* evidence.step(
          "Replaying the rotated token 61 minutes later is refused, and the current token still refreshes",
          Effect.gen(function* () {
            expect(yield* oauth.refreshStatus(stored)).toBe(400);
            return yield* oauth.refresh(first);
          }),
        );
        yield* serverControl("stop");
        yield* serverControl("clock/advance", 200, { milliseconds: 24 * 3600_000 });
        yield* serverControl("start");
        yield* evidence.step(
          "Replaying the rotated token more than a day later ends every copy",
          Effect.gen(function* () {
            expect(yield* oauth.refreshStatus(stored)).toBe(400);
            expect(yield* oauth.refreshStatus(current)).toBe(400);
          }),
        );
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
  it.effect(scenarios.mcpOfflineGrantOutlivesSession.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth,
          http = yield* HttpClient.HttpClient;
        const advance = (milliseconds: number) =>
          Effect.gen(function* () {
            yield* serverControl("stop");
            yield* serverControl("clock/advance", 200, { milliseconds });
            yield* serverControl("start");
          });
        const mcpStatus = (grant: Grant) =>
          Effect.scoped(
            Effect.gen(function* () {
              const response = yield* http.execute(
                HttpClientRequest.post(grant.resource).pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                      protocolVersion: "2025-06-18",
                      capabilities: {},
                      clientInfo: { name: "Offline grant", version: "1.0.0" },
                    },
                  }),
                  HttpClientRequest.setHeaders({
                    authorization: `Bearer ${Redacted.value(grant.tokens).access_token}`,
                    accept: "application/json, text/event-stream",
                  }),
                ),
              );
              return response.status;
            }),
          ).pipe(Effect.timeout("30 seconds"), Effect.orDie);
        const agentsPath = `/api/organizations/${actors.organization.id}/mcp-agents`;

        const approving = yield* freshOwnerSession;
        yield* browser.login(approving);
        const idle = yield* evidence.step(
          "Authorize an agent that stays idle",
          oauth.authorizeNamed("Idle agent"),
        );
        let daily = yield* evidence.step(
          "Authorize an agent that refreshes every day",
          oauth.authorizeNamed("Daily agent"),
        );
        const revoked = yield* evidence.step(
          "Authorize an agent that is revoked later",
          oauth.authorizeNamed("Revoked agent"),
        );
        const narrowed = yield* evidence.step(
          "Authorize an agent and narrow its refresh token to the mcp scope",
          Effect.flatMap(oauth.authorizeNamed("Narrowed agent"), (grant) =>
            oauth.refresh(grant, undefined, "mcp"),
          ),
        );
        for (let elapsed = 1; elapsed <= 6; elapsed++) {
          yield* advance(day);
          daily = yield* evidence.step(
            `The daily agent refreshes on day ${elapsed}`,
            oauth.refresh(daily),
          );
        }
        yield* advance(day - 30 * minute);
        daily = yield* evidence.step(
          "The daily agent refreshes half an hour before the session expires",
          oauth.refresh(daily),
        );
        expect(yield* mcpStatus(daily)).toBe(200);
        const beforeExpiry = daily;
        yield* advance(40 * minute);

        const outcomes: Array<{
          readonly name: string;
          readonly observed: unknown;
          readonly expected: unknown;
        }> = [];
        const record = (name: string, observed: unknown, expected: unknown) =>
          Effect.sync(() => {
            outcomes.push({ name, observed, expected });
          });
        const refreshAndCall = (name: string, grant: Grant) =>
          Effect.gen(function* () {
            const refreshed = yield* oauth.refresh(grant).pipe(Effect.option);
            yield* record(`${name}: refresh`, refreshed._tag === "Some" ? 200 : "refused", 200);
            if (refreshed._tag === "None") return grant;
            yield* record(
              `${name}: MCP with the refreshed token`,
              yield* mcpStatus(refreshed.value),
              200,
            );
            return refreshed.value;
          });

        const signIn = yield* api.request(actors.owner, "POST", "/api/auth/sign-in/email", {
          email: "owner@example.test",
          password,
        });
        expect(signIn.status).toBe(200);
        const owner = actors.owner;
        const listedAgents = api.request(owner, "GET", agentsPath).pipe(
          Effect.flatMap((response) => body(Agents, response)),
          Effect.map((listed) => new Set(listed.map((agent) => agent.id))),
        );
        yield* evidence.step(
          "Before it refreshes, the idle agent is listed through its refresh token alone",
          Effect.gen(function* () {
            yield* record(
              "idle agent: listed before it refreshes",
              (yield* listedAgents).has(idle.grantId),
              true,
            );
          }),
        );
        const idleAfter = yield* evidence.step(
          "Ten minutes after the session expired, the idle agent refreshes and calls MCP",
          Effect.gen(function* () {
            return yield* refreshAndCall("idle agent", idle);
          }),
        );
        const replayable = yield* evidence.step(
          "The daily agent's last token named the expired session; it refreshes and keeps working",
          Effect.gen(function* () {
            yield* record(
              "daily agent: MCP with the token issued before the session expired",
              yield* mcpStatus(beforeExpiry),
              401,
            );
            daily = yield* refreshAndCall("daily agent", daily);
            const rotated = daily;
            daily = yield* refreshAndCall("daily agent, second refresh after expiry", daily);
            return rotated;
          }),
        );
        yield* evidence.step(
          "The narrowed refresh token, without offline access, ended with the session",
          Effect.gen(function* () {
            yield* record("narrowed agent: refresh", yield* oauth.refreshStatus(narrowed), 400);
          }),
        );
        const revokedAfter = yield* evidence.step(
          "The agent to be revoked still works after the session expired",
          Effect.gen(function* () {
            return yield* refreshAndCall("revoked agent, before revocation", revoked);
          }),
        );
        yield* evidence.step(
          "Connected agents lists the agents that can still refresh",
          Effect.gen(function* () {
            const ids = yield* listedAgents;
            for (const [name, grant, expected] of [
              ["idle agent", idle, true],
              ["daily agent", daily, true],
              ["revoked agent", revoked, true],
              ["narrowed agent", narrowed, false],
            ] as const)
              yield* record(
                `${name}: listed in connected agents`,
                ids.has(grant.grantId),
                expected,
              );
          }),
        );
        yield* evidence.step(
          "Revoking an agent from the dashboard ends it",
          Effect.gen(function* () {
            const response = yield* api.request(
              owner,
              "POST",
              `${agentsPath}/${revoked.grantId}/revoke`,
            );
            yield* record("revoked agent: revoke", response.status, 200);
            yield* record(
              "revoked agent: MCP after revocation",
              yield* mcpStatus(revokedAfter),
              401,
            );
            yield* record(
              "revoked agent: refresh after revocation",
              yield* oauth.refreshStatus(revokedAfter),
              400,
            );
          }),
        );
        yield* evidence.step(
          "An agent approved by a session that then signs out keeps working",
          Effect.gen(function* () {
            const signingOut = yield* freshOwnerSession;
            yield* browser.login(signingOut);
            const agent = yield* oauth.authorizeNamed("Signed-out agent");
            const signedOut = yield* api.request(signingOut, "POST", "/api/auth/sign-out", {});
            yield* record("signed-out agent: sign-out", signedOut.status, 200);
            yield* refreshAndCall("signed-out agent", agent);
          }),
        );

        yield* advance(61 * minute);
        yield* evidence.step(
          "An access token issued after the session expired ends after its hour",
          Effect.gen(function* () {
            yield* record(
              "idle agent: MCP an hour after its refresh",
              yield* mcpStatus(idleAfter),
              401,
            );
            yield* refreshAndCall("idle agent, an hour later", idleAfter);
          }),
        );
        yield* advance(25 * 60 * minute);
        yield* evidence.step(
          "Replaying a rotated token more than a day later still ends the grant",
          Effect.gen(function* () {
            yield* record(
              "daily agent: replayed rotated token",
              yield* oauth.refreshStatus(replayable),
              400,
            );
            yield* record(
              "daily agent: current token after the replay",
              yield* oauth.refreshStatus(daily),
              400,
            );
          }),
        );
        expect(outcomes.map(({ name, observed }) => [name, observed])).toEqual(
          outcomes.map(({ name, expected }) => [name, expected]),
        );
      }).pipe(Effect.provide(McpOAuth.layer)),
    ),
  );
});
