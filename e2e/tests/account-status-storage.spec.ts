/** Display status reuses health JSON without advancing the schema or losing checked identity. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { accountStatusSource, displayedStatus } from "../support/account-status-fixture.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { statusAccount } from "../support/status-account.ts";
import { scenarios } from "../test-plan.ts";
layer(HostedLive, { excludeTestServices: true })("Status persistence", (it) => {
  it.effect(scenarios.accountStatusStorage.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* statusAccount(accountStatusSource);
        expect((yield* fixture.check()).status).toBe(200);
        const [version, columns, records] = yield* legacyStorage([
          { sql: "SELECT value FROM private_executor_settings WHERE key = 'version'" },
          {
            sql: "SELECT column_name FROM information_schema.columns WHERE table_name = 'executor_account_checks' AND column_name = 'display_status'",
          },
          {
            sql: "SELECT account_info FROM executor_account_checks WHERE account = $1",
            params: [fixture.account],
          },
        ]);
        expect(version).toEqual([{ value: "4.0.15" }]);
        expect(columns).toEqual([]);
        expect(records).toEqual([
          {
            account_info: {
              displayName: "Checked fixture identity",
              displayStatus: displayedStatus,
            },
          },
        ]);
        yield* serverControl("start");
        expect((yield* fixture.read()).body).toMatchObject({
          health: {
            info: { displayName: "Checked fixture identity" },
            apps: [{ check: { displayStatus: displayedStatus } }],
          },
        });
        yield* fixture.statusBackend.answer({
          status: 200,
          body: { status: { ...displayedStatus, stats: [{ label: "Requests", value: "43" }] } },
        });
        expect((yield* fixture.check()).status).toBe(200);
        expect((yield* fixture.read()).body).toMatchObject({
          health: {
            info: { displayName: "Checked fixture identity" },
            apps: [{ check: { displayStatus: { stats: [{ label: "Requests", value: "43" }] } } }],
          },
        });
        yield* fixture.statusBackend.answer({ status: 503, body: {} });
        expect((yield* fixture.check()).status).toBe(200);
        yield* serverControl("restart");
        expect((yield* fixture.read()).body).toMatchObject({
          health: {
            info: { displayName: "Checked fixture identity" },
            apps: [{ check: { status: "upstream_unavailable" } }],
          },
        });
        const persisted = yield* legacyStorage([
          {
            sql: "SELECT account_info FROM executor_account_checks WHERE account = $1",
            params: [fixture.account],
          },
        ]);
        expect(persisted).toEqual([
          [{ account_info: { displayName: "Checked fixture identity" } }],
        ]);
        yield* serverControl("start");
      }),
    ),
  );
});
