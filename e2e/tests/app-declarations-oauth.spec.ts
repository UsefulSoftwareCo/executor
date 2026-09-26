/** Kept app declarations are never served for an OAuth account that a live read would refuse. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { clientCredentialsIssuer, machineClient } from "../support/client-credentials-issuer.ts";
import { createProfile } from "../support/profiles.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  account: Schema.Struct({ id: Schema.String }),
});
const Workflows = Schema.Array(Schema.Struct({ name: Schema.String }));
const Bundle = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
});
const Failure = Schema.Struct({ _tag: Schema.String });

/** Token lifetime in seconds. Renewal starts 30 s before expiry, so 40 s gives a 10 s window. */
const lifetime = 40;

layer(HostedLive, { excludeTestServices: true })("App declarations and OAuth grants", (it) => {
  it.effect(
    scenarios.appDeclarationsOAuth.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            evidence = yield* Evidence,
            telemetry = yield* Telemetry;
          const issuer = yield* clientCredentialsIssuer;
          yield* issuer.configure({
            method: "client_secret_basic",
            expiresIn: lifetime,
            rejected: false,
          });
          const prefix = `/api/organizations/${actors.organization.id}`;
          const token = JSON.stringify(`${issuer.origin}/token`);
          const resource = JSON.stringify(`${issuer.origin}/resource`);
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Declarations OAuth ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import {defineApp,defineProvider,oauth2,query,workflow,object} from "apps";
const service=defineProvider({name:"Reporting",auth:{machine:oauth2({grant:"client_credentials",tokenUrl:${token},scopes:["reports:read"],resource:${resource},tokenEndpointAuthMethod:"client_secret_basic"})}});
const noop=workflow({input:object({})},async()=>null);
export default defineApp({accounts:{service}},async({accounts})=>{
  const generation=accounts.service.fields.access_token.split("-").pop();
  return {
    queries:{read:query({input:object({})},async({fetch})=>(await fetch(${resource},{headers:{authorization:"Bearer "+accounts.service.fields.access_token}})).json())},
    workflows:{["grant_"+generation]:noop},
    skills:[{name:"grant-guide",description:"Grant "+generation,files:[{path:"SKILL.md",content:"---\\nname: grant-guide\\ndescription: Grant "+generation+"\\n---\\n# Grant"}]}],
  };
});`,
              },
            ],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(Resource, deployed);
          const path = `${prefix}/apps/${app.id}`;
          let account: string | undefined;
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* api.request(actors.owner, "DELETE", path);
              if (account !== undefined)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
            }).pipe(Effect.orDie),
          );
          const profile = yield* createProfile(actors.owner, path);
          const connection = yield* body(
            Resource,
            yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "service",
              profile: profile.id,
            }),
          );
          const completed = yield* body(
            Completed,
            yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/oauth/start`,
              { method: "machine", label: "Reporting", client: machineClient },
            ),
          );
          account = completed.account.id;
          const connectedAt = Date.now();

          /** The cache outcome recorded by the SDK span of the latest request's own trace. */
          const outcome = Effect.gen(function* () {
            const request = (yield* evidence.requests).at(-1);
            if (request === undefined) return yield* Effect.fail(new Error("Missing request"));
            const spans = yield* telemetry.query(request.traceId).pipe(
              Effect.flatMap((result) => {
                const tagged = result.data.filter(
                  ({ span }) => span.tags["executor.declarations.cache"] !== undefined,
                );
                return tagged.length === 0
                  ? Effect.fail(new Error("Missing declaration read span"))
                  : Effect.succeed(tagged);
              }),
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
            );
            expect(spans).toHaveLength(1);
            return spans[0]?.span.tags["executor.declarations.cache"];
          });
          const workflows = api.request(
            actors.owner,
            "GET",
            `${path}/workflows?profile=${profile.id}`,
          );
          const bundle = api.request(
            actors.owner,
            "GET",
            `${path}/skill-bundle?profile=${profile.id}`,
          );
          const names = (response: { status: number; body: unknown }) =>
            body(Workflows, response).pipe(Effect.map((rows) => rows.map((row) => row.name)));
          const descriptions = (response: { status: number; body: unknown }) =>
            body(Bundle, response).pipe(
              Effect.map((value) => value.skills.map((skill) => skill.description)),
            );

          // Evaluated with the first issued token, then kept for identical reads.
          const first = yield* workflows;
          expect(first.status, JSON.stringify(first.body)).toBe(200);
          expect(yield* names(first)).toEqual(["grant_1"]);
          expect(yield* outcome).toBe("miss");
          const kept = yield* workflows;
          expect(yield* names(kept)).toEqual(["grant_1"]);
          expect(yield* outcome).toBe("hit");
          const skills = yield* bundle;
          expect(yield* descriptions(skills)).toEqual(["Grant 1"]);
          expect(yield* outcome).toBe("miss");
          expect(yield* descriptions(yield* bundle)).toEqual(["Grant 1"]);
          expect(yield* outcome).toBe("hit");
          // Every read above ran before renewal was due, so the stored credential never changed.
          expect(Date.now() - connectedAt).toBeLessThan((lifetime - 30) * 1000);

          // Once renewal is due, the provider refuses it and the grant needs reconnecting.
          yield* Effect.sleep(Math.max(0, connectedAt + (lifetime - 29) * 1000 - Date.now()));
          yield* issuer.configure({ rejected: true });
          const refused = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
            profile: profile.id,
            tool: "queries.read",
            input: {},
          });
          expect(refused.status, JSON.stringify(refused.body)).toBe(409);
          expect((yield* body(Failure, refused))._tag).toBe("OAuthReconnectRequired");

          // Both kept results are still within their stale bound, yet neither is served.
          for (const read of [workflows, bundle]) {
            const denied = yield* read;
            expect(denied.status, JSON.stringify(denied.body)).toBe(409);
            expect((yield* body(Failure, denied))._tag).toBe("OAuthReconnectRequired");
          }
          expect(Date.now() - connectedAt).toBeLessThan(60_000);
        }),
      ),
    { timeout: 120_000 },
  );
});
