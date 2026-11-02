/** App checks use real linked backend credentials and expose bounded display data through HTTP and the row. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Evidence } from "../support/evidence.ts";
import {
  accountStatusBackend,
  accountStatusSource,
  displayedStatus,
} from "../support/account-status-fixture.ts";
import {
  interactiveAccountBackend,
  interactiveBackendKey,
} from "../support/interactive-account-backend.ts";
import { scenarios } from "../test-plan.ts";

const Detail = Schema.Struct({
  health: Schema.Struct({
    info: Schema.Unknown,
    apps: Schema.Array(
      Schema.Struct({
        checkable: Schema.Boolean,
        check: Schema.NullOr(
          Schema.Struct({
            status: Schema.String,
            current: Schema.Boolean,
            displayStatus: Schema.optionalKey(Schema.Unknown),
          }),
        ),
      }),
    ),
  }),
});
const Health = Detail.fields.health;
const Connected = Schema.Struct({ state: Schema.Literal("connected"), account: Resource });

layer(HostedLive, { excludeTestServices: true })("Account display status", (it) => {
  it.effect(scenarios.accountDisplayStatus.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence;
        const backend = yield* interactiveAccountBackend;
        const statusBackend = yield* accountStatusBackend;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Account status fixture",
          files: [
            {
              path: "index.ts",
              content: accountStatusSource(backend.origin, statusBackend.origin),
            },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed),
          path = `${prefix}/apps/${app.id}`;
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", path);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${path}/accounts/app/backend/connections`, {}),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "key", fields: { token: interactiveBackendKey } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        accounts.push((yield* body(Resource, saved)).id);
        const pending = yield* body(
          Resource,
          yield* api.request(
            actors.owner,
            "POST",
            `${path}/accounts/user/identity/connections`,
            {},
          ),
        );
        const steps = `${prefix}/connections/${pending.id}/interactive`;
        expect(
          (yield* api.request(actors.owner, "POST", `${steps}/start`, { method: "device" })).status,
        ).toBe(200);
        yield* api.request(actors.owner, "GET", `${steps}/status`);
        const connected = yield* body(
          Connected,
          yield* api.request(actors.owner, "GET", `${steps}/status`),
        );
        const account = connected.account.id;
        accounts.push(account);
        const accountPath = `${prefix}/accounts/${account}`;
        const check = () =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${accountPath}/health`);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            expect(JSON.stringify(response.body)).not.toContain(
              "must-not-cross-the-check-boundary",
            );
            expect(JSON.stringify(response.body)).not.toContain(interactiveBackendKey);
            return yield* body(Health, response);
          });
        const health = yield* check();
        expect(health.info).toMatchObject({ displayName: "Checked fixture identity" });
        expect(health.apps[0]).toMatchObject({
          checkable: true,
          check: { status: "healthy", current: true, displayStatus: displayedStatus },
        });
        expect(yield* statusBackend.calls).toBe(1);
        expect(
          (yield* body(Detail, yield* api.request(actors.owner, "GET", accountPath))).health,
        ).toEqual(health);
        yield* browser.login(actors.owner);
        yield* browser.use("Open the account status row", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Wait for the account status", (page) =>
          page
            .getByRole("region", { name: "Your accounts", exact: true })
            .getByRole("group", { name: "Account status", exact: true })
            .getByText("Available", { exact: true })
            .waitFor(),
        );
        const visible = yield* browser.use("Read the status row and accessible meter", (page) => {
          const status = page
            .getByRole("region", { name: "Your accounts", exact: true })
            .getByRole("group", { name: "Account status", exact: true });
          return Promise.all([
            status.getByText("Pro", { exact: true }).count(),
            status.getByRole("meter", { name: "5h", exact: true }).getAttribute("aria-valuenow"),
            status.getByRole("meter", { name: "5h", exact: true }).getAttribute("data-meter-state"),
            status
              .getByRole("meter", { name: "Weekly", exact: true })
              .getAttribute("data-meter-state"),
            status
              .getByRole("meter", { name: "Daily", exact: true })
              .getAttribute("data-meter-state"),
            status
              .getByRole("meter", { name: "Monthly", exact: true })
              .getAttribute("data-meter-state"),
            status.getByText("Rem unknown", { exact: true }).count(),
            status.innerText(),
            status.locator("..").getByText("Working", { exact: true }).count(),
          ]);
        });
        expect(visible[0]).toBe(1);
        expect(visible[1]).toBe("75");
        expect(visible[2]).toBe("neutral");
        expect(visible[3]).toBe("unknown");
        expect(visible[4]).toBe("warning");
        expect(visible[5]).toBe("exhausted");
        expect(visible[6]).toBe(1);
        expect(visible[7]).toContain("Rem 75%");
        expect(visible[7]).toContain("in 6 days");
        expect(visible[7]).toContain("Rem unknown");
        expect(visible[7]).toContain("Reset unknown");
        expect(visible[7]).toContain("Rem 20% · Low");
        expect(visible[7]).toContain("Rem 0% · Exhausted");
        expect(visible[7]).toContain("in 2 days");
        expect(visible[7]).toContain("↻ 2 banked · next expires in 3 days");
        expect(visible[7]).toContain("Requests: 42");
        expect(visible[7]).toContain("Tokens: 12,345");
        expect(visible[7]).toContain("Cost: $1.23");
        expect(visible[8]).toBe(1);
        yield* evidence.attach(
          "account-status-row.png",
          "image/png",
          yield* browser.use("Capture the status row", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );
        yield* browser.use("Check the narrow account row", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        const box = yield* browser.use("Read the narrow status bounds", (page) =>
          page
            .getByRole("region", { name: "Your accounts", exact: true })
            .getByRole("group", { name: "Account status", exact: true })
            .boundingBox(),
        );
        expect(box).not.toBeNull();
        if (box !== null) expect(box.x + box.width).toBeLessThanOrEqual(390);
        yield* browser.use("Show the selected account at phone width", (page) =>
          page.getByRole("region", { name: "Your accounts", exact: true }).scrollIntoViewIfNeeded(),
        );
        yield* evidence.attach(
          "account-status-mobile.png",
          "image/png",
          yield* browser.use("Capture the narrow status row", (page) =>
            page.screenshot({ fullPage: true }),
          ),
        );
        yield* browser.use("Restore the dashboard viewport", (page) =>
          page.setViewportSize({ width: 1280, height: 800 }),
        );
        // The existing check remains fresh on opening and revisiting the tab.
        expect(yield* statusBackend.calls).toBe(1);
        for (const [status, classified] of [
          [401, "credentials_rejected"],
          [403, "forbidden"],
          [503, "upstream_unavailable"],
        ] as const) {
          yield* statusBackend.answer({ status, body: {} });
          const failed = yield* check();
          expect(failed.apps[0]?.check).toMatchObject({ status: classified, current: true });
          expect(failed.apps[0]?.check?.displayStatus).toBeUndefined();
          expect(failed.info).toMatchObject({ displayName: "Checked fixture identity" });
        }
        // Bounds fail the check rather than publishing oversized or invalid display data.
        for (const status of [
          {
            ...displayedStatus,
            badges: Array.from({ length: 9 }, () => ({ label: "Plan", tone: "neutral" })),
          },
          { ...displayedStatus, badges: [{ label: "x".repeat(65), tone: "neutral" }] },
          { ...displayedStatus, meters: [{ label: "5h", remaining: 1.1 }] },
          { ...displayedStatus, stats: [{ label: "Cost", value: "x".repeat(129) }] },
        ]) {
          yield* statusBackend.answer({ status: 200, body: { status } });
          expect((yield* check()).apps[0]?.check?.status).toBe("check_failed");
        }
        yield* statusBackend.answer({ status: "timeout" });
        expect((yield* check()).apps[0]?.check?.status).toBe("check_failed");
      }),
    ),
  );
});
