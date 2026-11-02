/** Successful checks cannot publish credentials in display strings or plaintext storage. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { accountStatusSource, displayedStatus } from "../support/account-status-fixture.ts";
import { interactiveBackendKey } from "../support/interactive-account-backend.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { statusAccount } from "../support/status-account.ts";
import { scenarios } from "../test-plan.ts";

const Health = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      check: Schema.NullOr(
        Schema.Struct({ status: Schema.String, displayStatus: Schema.optionalKey(Schema.Unknown) }),
      ),
    }),
  ),
});
layer(HostedLive, { excludeTestServices: true })("Status confidentiality", (it) => {
  it.effect(scenarios.accountStatusPrivacy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const contact = "owner@example.test";
        const fixture = yield* statusAccount(
          (connect, check) =>
            accountStatusSource(connect, check)
              .replace(
                "defineApp, defineProvider, interactive,",
                "defineApp, defineProvider, interactive, plain,",
              )
              .replace(
                "token: string()",
                "token: string(), short: string(), tone: string(), contact: plain(string())",
              ),
          { contact, tone: "warning" },
        );
        const leaks = (secret: string) => [
          { ...displayedStatus, badges: [{ label: `plan ${secret}`, tone: "good" }] },
          { ...displayedStatus, meters: [{ label: `quota ${secret}`, remaining: 0.5 }] },
          {
            ...displayedStatus,
            meters: [{ label: "Quota", remaining: null, detail: `detail ${secret}` }],
          },
          { ...displayedStatus, stats: [{ label: `usage ${secret}`, value: "1" }] },
          { ...displayedStatus, stats: [{ label: "Usage", value: `value ${secret}` }] },
        ];
        for (const secret of ["opaque-1", interactiveBackendKey]) {
          for (const status of leaks(secret)) {
            yield* fixture.statusBackend.answer({ status: 200, body: { status } });
            const response = yield* fixture.check();
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const health = yield* body(Health, response);
            expect(health.apps[0]?.check?.status).toBe("check_failed");
            expect(health.apps[0]?.check?.displayStatus).toBeUndefined();
            expect(JSON.stringify(response.body)).not.toContain(secret);
            expect(JSON.stringify((yield* fixture.read()).body)).not.toContain(secret);
          }
        }
        // A short secret may be chance, so only the item that contains it is hidden.
        const hiddenTone = { ...displayedStatus, badges: [{ label: "Plan", tone: "warning" }] };
        for (const status of [...leaks("xy"), hiddenTone]) {
          yield* fixture.statusBackend.answer({ status: 200, body: { status } });
          const response = yield* fixture.check();
          expect((yield* body(Health, response)).apps[0]?.check?.status).toBe("healthy");
          const hidden = status === hiddenTone ? "warning" : "xy";
          expect(JSON.stringify(response.body)).not.toContain(hidden);
          expect(JSON.stringify((yield* fixture.read()).body)).not.toContain(hidden);
        }
        // Inside a longer word or as its hex, the item is hidden too; the rest and plain() fields show.
        yield* fixture.statusBackend.answer({
          status: 200,
          body: {
            accountInfo: { email: contact },
            status: {
              ...displayedStatus,
              badges: [
                { label: "Proxy", tone: "good" },
                { label: "Available", tone: "good" },
              ],
              stats: [
                { label: "Hex", value: Buffer.from("xy").toString("hex") },
                { label: "Requests", value: "42" },
              ],
            },
          },
        });
        const healthy = yield* fixture.check();
        expect((yield* body(Health, healthy)).apps[0]?.check?.status).toBe("healthy");
        const shown = JSON.stringify((yield* fixture.read()).body);
        for (const kept of [contact, "Available", "Requests"]) expect(shown).toContain(kept);
        for (const hidden of ["Proxy", "7879"]) expect(shown).not.toContain(hidden);
        const stored = yield* legacyStorage([
          {
            sql: "SELECT account_info, message FROM executor_account_checks WHERE account = $1",
            params: [fixture.account],
          },
        ]);
        expect(JSON.stringify(stored)).not.toContain("opaque-1");
        expect(JSON.stringify(stored)).not.toContain(interactiveBackendKey);
        yield* serverControl("start");
      }),
    ),
  );
});
