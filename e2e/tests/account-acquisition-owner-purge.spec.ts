import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { acquisitionSdk } from "../support/account-acquisition-sdk.ts";
import { interactiveAccountBackend } from "../support/interactive-account-backend.ts";
import { body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { legacyStorage } from "../support/legacy-storage.ts";

const Connected = Schema.Struct({ state: Schema.Literal("connected"), account: Resource });
layer(TestLive, { excludeTestServices: true })("SDK owner purge", (it) => {
  it.effect(scenarios.accountAcquisitionOwnerPurge.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const backend = yield* interactiveAccountBackend;
        const sdk = yield* acquisitionSdk(backend.origin);
        const connect = (owner: string, app: string) =>
          Effect.gen(function* () {
            const pending = yield* sdk.request("POST", "/v1/account-connections", {
              owner,
              target: { app, requirement: "identity" },
            });
            expect(pending.status, JSON.stringify(pending.body)).toBe(200);
            const connection = (yield* body(Resource, pending)).id;
            expect(
              (yield* sdk.request("POST", "/v1/account-connections/interactive/start", {
                owner,
                connection,
                method: "paste",
              })).status,
            ).toBe(200);
            const completed = yield* sdk.request(
              "POST",
              "/v1/account-connections/interactive/submit",
              {
                owner,
                connection,
                value: "http://localhost:48765/done?code=synthetic",
              },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            return (yield* body(Connected, completed)).account.id;
          });
        const first = yield* connect(sdk.owner, sdk.app);
        expect(
          (yield* sdk.request("DELETE", `/v1/accounts/${first}?owner=${sdk.owner}`)).status,
        ).toBe(500);
        expect(yield* sdk.retireChecks).toBe(1);
        expect(yield* backend.removeCalls).toEqual([]);
        yield* sdk.stop;
        yield* legacyStorage([
          { sql: "CREATE TABLE purge_fault (phase text NOT NULL)" },
          { sql: "INSERT INTO purge_fault VALUES ('before')" },
          {
            sql: `CREATE FUNCTION refuse_purge() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF EXISTS (SELECT 1 FROM purge_fault WHERE phase = 'before') OR (
                EXISTS (SELECT 1 FROM purge_fault WHERE phase = 'after') AND
                EXISTS (SELECT 1 FROM executor_account_acquisitions
                  WHERE owner = OLD.owner AND removal IS NOT NULL AND removal->>'removed' = 'true')
              ) THEN
                RAISE EXCEPTION 'Synthetic purge storage failure';
              END IF;
              RETURN OLD;
            END $$`,
          },
          {
            sql: "CREATE TRIGGER refuse_purge BEFORE DELETE ON executor_apps FOR EACH ROW EXECUTE FUNCTION refuse_purge()",
          },
        ]);
        yield* sdk.start;
        const fault = (phase: "off" | "after") =>
          Effect.gen(function* () {
            yield* sdk.stop;
            yield* legacyStorage([{ sql: "UPDATE purge_fault SET phase = $1", params: [phase] }]);
            yield* sdk.start;
          });
        expect((yield* sdk.request("DELETE", `/v1/owners/${sdk.owner}`)).status).toBe(500);
        expect(yield* backend.removeCalls).toEqual([]);
        expect((yield* sdk.request("GET", `/v1/accounts/${first}?owner=${sdk.owner}`)).status).toBe(
          200,
        );
        yield* fault("off");
        const purged = yield* sdk.request("DELETE", `/v1/owners/${sdk.owner}`);
        expect(purged.status, JSON.stringify(purged.body)).toBe(200);
        expect(purged.body).toMatchObject({ accounts: 1, apps: 1 });
        expect(yield* sdk.retireChecks).toBe(1);
        expect((yield* backend.removeCalls).map((call) => call.ref)).toEqual(["opaque-1"]);

        const owner = "purge-owner-second";
        const deployed = yield* sdk.request("POST", "/v1/apps/deploy", {
          owner,
          name: "Purge retry manager",
          files: sdk.files,
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = (yield* body(Schema.Struct({ app: Resource }), deployed)).app.id;
        const account = yield* connect(owner, app);
        // The preflight rolls back without a receipt; only the final purge sees removed=true.
        yield* fault("after");
        expect((yield* sdk.request("DELETE", `/v1/owners/${owner}`)).status).toBe(500);
        expect((yield* sdk.request("GET", `/v1/accounts/${account}?owner=${owner}`)).status).toBe(
          200,
        );
        const completed = yield* backend.removeCalls;
        expect(completed.map((call) => call.ref)).toEqual(["opaque-1", "opaque-2"]);
        expect(completed[1]?.operation).toBeTruthy();
        yield* fault("off");
        expect((yield* sdk.request("DELETE", `/v1/owners/${owner}`)).status).toBe(200);
        expect(yield* backend.removeCalls).toEqual(completed);
        expect((yield* sdk.request("DELETE", `/v1/owners/${owner}`)).status).toBe(200);
        expect(yield* backend.removeCalls).toEqual(completed);
        expect((yield* sdk.request("GET", `/v1/accounts/${account}?owner=${owner}`)).status).toBe(
          404,
        );
        expect(yield* sdk.retireChecks).toBe(1);
      }),
    ),
  );
});
