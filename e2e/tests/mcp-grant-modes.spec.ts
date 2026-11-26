import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { dataStepSummaries, nextDataStepSummary } from "../support/data-steps.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { clientGrantId, consentTo, revokeClientGrants } from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { serverControl } from "../support/server-control.ts";

const step = "12_store_agent_grant_modes";

const whoamiMode = (token: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const response = yield* rawRequest(`${targetHosts(target).mcp}/mcp/whoami`, {
      headers: { authorization: `Bearer ${Redacted.value(token)}` },
    });
    expect(response.status, response.text).toBe(200);
    return (yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ mode: Schema.String })),
    )(response.text)).mode;
  });

layer(HostedLive, { excludeTestServices: true })("MCP grant approval modes", (it) => {
  it.effect(scenarios.grantModeBackfill.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          target = yield* Target;
        const log = `${target.directory}/server.log`;
        const clients: string[] = [];
        yield* revokeClientGrants(actors.owner, () => clients);
        yield* Effect.addFinalizer(() => serverControl("start").pipe(Effect.orDie));
        const consent = yield* consentTo(
          actors.owner,
          `${targetHosts(target).mcp}/mcp?elicitation_mode=browser`,
          { "x-executor-organization": actors.organization.id },
        );
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const grant = yield* clientGrantId(actors.owner, consent.clientId);
        expect(yield* whoamiMode(token)).toBe("browser");
        const dropped = yield* legacyStorage([{ sql: `alter table "mcpGrant" drop column mode` }]);
        expect(dropped).toEqual([[]]);
        const seen = (yield* dataStepSummaries(log, step)).length;
        yield* serverControl("start");
        const report = yield* nextDataStepSummary(log, step, seen);
        expect(report).toMatchObject({ mode: "report", outcomes: { missing: 1 } });
        expect(yield* whoamiMode(token)).toBe("browser");
        const mode = (rows: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
          rows[0]?.[0]?.["mode"];
        const reported = yield* legacyStorage([
          { sql: `select mode from "mcpGrant" where id = $1`, params: [grant] },
        ]);
        expect(mode(reported)).toBeNull();
        const applied = (yield* dataStepSummaries(log, step)).length;
        yield* serverControl("data-steps", 200, { mode: "apply" });
        yield* serverControl("start");
        const stored = yield* nextDataStepSummary(log, step, applied);
        expect(stored).toMatchObject({
          mode: "apply",
          status: "complete",
          outcomes: { stored: 1 },
        });
        expect(yield* whoamiMode(token)).toBe("browser");
        const after = yield* legacyStorage([
          { sql: `select mode from "mcpGrant" where id = $1`, params: [grant] },
        ]);
        expect(mode(after)).toBe("browser");
        const repeated = (yield* dataStepSummaries(log, step)).length;
        yield* serverControl("start");
        expect(yield* whoamiMode(token)).toBe("browser");
        expect((yield* dataStepSummaries(log, step)).length).toBe(repeated);
      }),
    ),
  );
});
