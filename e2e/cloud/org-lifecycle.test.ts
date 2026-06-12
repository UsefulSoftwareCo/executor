// Cloud-only: a team's first week with the product, end to end — the whole
// multiplayer lifecycle in one journey instead of isolated per-feature
// checks. Three real users (real sign-ins, real sealed sessions) assemble an
// org through the genuine invite → accept flow, share an integration, split
// shared vs personal credentials, and actually invoke tools — proven by the
// upstream API's request log showing each member's calls arriving with the
// right credential:
//
//   1. The founder signs up, gets an org, and invites two teammates; both
//      accept. The members page shows the team of three, filling exactly the
//      free plan's seats.
//   2. The founder registers a real upstream API (a live HTTP server started
//      inside the scenario) and stores the team's SHARED org credential.
//   3. A teammate — not the founder — uses the shared connection: the stamped
//      tool is visible to her, the execution completes, and the upstream
//      receives her call bearing the SHARED key.
//   4. The other teammate adds his own PERSONAL connection with his own key.
//      His execution reaches the upstream with HIS key — and his teammates
//      never see his connection or his tools.
import { randomBytes } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpApiClient } from "effect/unstable/httpapi";
import { AccountHttpApi } from "@executor-js/api";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { serveOpenApiEchoTestServer } from "@executor-js/plugin-openapi/testing";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { joinOrg } from "../src/org";
import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);
type Client = HttpApiClient.ForApi<typeof api>;

const API_KEY = AuthTemplateSlug.make("apiKey");
const SHARED = ConnectionName.make("shared");
const PERSONAL = ConnectionName.make("personal");

/** Narrow an execution result to "completed", failing with the run's text. */
const completed = <R extends { status: string; text: string }>(
  execution: R,
): Extract<R, { status: "completed" }> => {
  if (execution.status !== "completed") {
    throw new Error(`execution did not complete (status=${execution.status}): ${execution.text}`);
  }
  return execution as Extract<R, { status: "completed" }>;
};

/** Run `code` in the sandbox as this member and return the completed result. */
const invoke = (client: Client, code: string) =>
  Effect.map(client.executions.execute({ payload: { code } }), completed);

scenario(
  "Organizations · a team forms, shares an integration, and members invoke with shared and personal credentials",
  { timeout: 240_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const apiSurface = yield* Api;

      // ── 1. The team assembles through the real product flows ────────────
      const founder = yield* target.newIdentity();
      const alice = yield* joinOrg(target, founder, yield* target.newIdentity({ org: false }));
      const bob = yield* joinOrg(target, founder, yield* target.newIdentity({ org: false }));

      const founderClient = yield* apiSurface.client(api, founder);
      const aliceClient = yield* apiSurface.client(api, alice);
      const bobClient = yield* apiSurface.client(api, bob);

      const account = yield* apiSurface.client(AccountHttpApi, founder);
      const roster = yield* account.account.listMembers();
      expect(
        roster.members.map((member) => member.email).sort(),
        "the members page lists the founder and both accepted teammates",
      ).toEqual([founder.label, alice.label, bob.label].sort());
      expect(
        roster.seats,
        "three members fill exactly the free plan's seat allowance",
      ).toMatchObject({ used: 3, granted: 3, unlimited: false });

      // ── 2. The founder registers a real upstream and the shared key ─────
      // A live HTTP server inside the scenario — executions actually hit it,
      // and its request log is the proof of who called with which credential.
      const upstream = yield* serveOpenApiEchoTestServer();
      const slug = IntegrationSlug.make(`team_api_${randomBytes(4).toString("hex")}`);
      const sharedKey = `team-shared-${randomBytes(8).toString("hex")}`;

      yield* founderClient.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: upstream.specJson },
          slug,
          description: "The team's upstream API",
          baseUrl: upstream.baseUrl,
          authenticationTemplate: [
            {
              slug: "apiKey",
              type: "apiKey",
              headers: { authorization: ["Bearer ", { type: "variable", name: "token" }] },
            },
          ],
        },
      });
      yield* founderClient.connections.create({
        payload: {
          owner: "org",
          name: SHARED,
          integration: slug,
          template: API_KEY,
          value: sharedKey,
        },
      });

      // ── 3. A teammate uses the SHARED connection ─────────────────────────
      const sharedAddress = `tools.${slug}.org.${SHARED}.echo.echoMessage`;
      const aliceTools = yield* aliceClient.tools.list({ query: { integration: slug } });
      expect(
        aliceTools.map((tool) => String(tool.address)),
        "the org connection's tools are advertised to an invited member",
      ).toContain(sharedAddress);

      const aliceRun = yield* invoke(
        aliceClient,
        [
          `const result = await ${sharedAddress}({ message: "hello", suffix: "from-alice" });`,
          "return result;",
        ].join("\n"),
      );
      expect(aliceRun.isError, `alice's execution succeeded: ${aliceRun.text}`).toBe(false);
      expect(aliceRun.structured, "the upstream's echo came back to alice").toMatchObject({
        result: { ok: true, data: { message: "hello", suffix: "from-alice" } },
      });

      // ── 4. The other teammate brings his own PERSONAL credential ────────
      const bobKey = `bob-personal-${randomBytes(8).toString("hex")}`;
      yield* bobClient.connections.create({
        payload: {
          owner: "user",
          name: PERSONAL,
          integration: slug,
          template: API_KEY,
          value: bobKey,
        },
      });
      const personalAddress = `tools.${slug}.user.${PERSONAL}.echo.echoMessage`;

      const bobRun = yield* invoke(
        bobClient,
        [
          `const result = await ${personalAddress}({ message: "hi", suffix: "from-bob" });`,
          "return result;",
        ].join("\n"),
      );
      expect(bobRun.isError, `bob's execution succeeded: ${bobRun.text}`).toBe(false);

      // The upstream saw both invocations, each carrying the credential of
      // the connection it went through — the shared key for the org tool,
      // bob's own key for his personal tool.
      const calls = yield* upstream.requests;
      const authOf = (suffix: string) =>
        calls.find((request) => request.url.includes(`suffix=${suffix}`))?.headers["authorization"];
      expect(authOf("from-alice"), "alice's call used the team's shared key").toBe(
        `Bearer ${sharedKey}`,
      );
      expect(authOf("from-bob"), "bob's call used his own personal key").toBe(`Bearer ${bobKey}`);

      // Personal stays personal: bob's connection and tools are invisible to
      // the founder (org admin) and to alice.
      const founderConnections = yield* founderClient.connections.list({
        query: { integration: slug },
      });
      expect(
        founderConnections.map((connection) => connection.name),
        "the founder sees the shared connection but not bob's personal one",
      ).toEqual([SHARED]);
      const aliceAddresses = (yield* aliceClient.tools.list({ query: { integration: slug } })).map(
        (tool) => String(tool.address),
      );
      expect(aliceAddresses, "alice is not offered bob's personal tool").not.toContain(
        personalAddress,
      );
      expect(aliceAddresses, "alice keeps the shared tool").toContain(sharedAddress);
    }),
  ),
);
