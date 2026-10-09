import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { acceptedToken, accountCheckUpstream } from "../support/account-check-upstream.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

/** The synthetic photo the identity check reports; the browser request is answered locally. */
const avatar = "https://avatars.example.test/u/4242.png";
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const Health = Schema.Struct({
  account: Schema.String,
  info: Schema.NullOr(
    Schema.Struct({
      externalId: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.String),
      username: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      avatarUrl: Schema.optional(Schema.String),
      profileUrl: Schema.optional(Schema.String),
    }),
  ),
  infoCheckedAt: Schema.NullOr(Schema.String),
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      checkable: Schema.Boolean,
      check: Schema.NullOr(
        Schema.Struct({
          status: Schema.String,
          checkedAt: Schema.String,
          current: Schema.Boolean,
          message: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
const Detail = Schema.Struct({ health: Health });
const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(
      Schema.String,
      Schema.Struct({ provider: Schema.String, health: Schema.optional(Schema.Literal(true)) }),
    ),
  }),
});

/** Every app declares the same provider, so one account serves all three. */
const provider = (health: string) => `const service = defineProvider({
  name: "Checked service",
  auth: { apiKey: secrets({ label: "API key", fields: object({ token: string() }) }) },
  ${health}
});`;

const source = (health: string) => `import {
  decodeJson, defineApp, defineProvider, object, ProviderError, query, router, secrets, string,
} from "apps";
const User = object({ id: string(), name: string(), login: string(), avatar: string() });
${provider(health)}
export default defineApp({ accounts: { service } }, {
  tools: router({ ping: query({ input: object({}) }, async () => ({ ok: true })) }),
});`;

/** Reads the service's current user; an explicit insufficient-scope answer is a permission gap. */
const identityCheck = (origin: string) => `async health({ account, fetch, signal }) {
    const response = await fetch(${JSON.stringify(`${origin}/me`)}, {
      signal,
      headers: { authorization: "Bearer " + account.fields.token },
    });
    if (response.status === 403 && /insufficient_scope/.test(response.headers.get("www-authenticate") ?? ""))
      throw new ProviderError({ reason: "forbidden", status: 403 });
    const user = await decodeJson(response, User);
    return {
      accountInfo: {
        externalId: user.id,
        displayName: user.name,
        username: user.login,
        avatarUrl: user.avatar,
      },
    };
  },`;

layer(HostedLive, { excludeTestServices: true })("Account health", (it) => {
  it.effect(scenarios.accountHealth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const upstream = yield* accountCheckUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = (name: string, health: string) =>
          Effect.gen(function* () {
            const created = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files: [{ path: "index.ts", content: source(health) }, appsManifest],
            });
            expect(created.status, JSON.stringify(created.body)).toBe(200);
            return yield* body(App, created);
          });
        // Two apps check the same account differently; the third defines no check.
        const identity = yield* deploy("Identity check", identityCheck(upstream.origin));
        const plain = yield* deploy("Plain check", "async health() { return {}; },");
        const unchecked = yield* deploy("Without check", "");
        const apps = [identity, plain, unchecked];
        const paths = apps.map((app) => `${prefix}/apps/${app.id}`);
        const [identityPath, plainPath, uncheckedPath] = paths;
        if (identityPath === undefined || plainPath === undefined || uncheckedPath === undefined)
          return yield* Effect.die("Missing app paths");
        const profiles = yield* Effect.forEach(paths, (path) => createProfile(actors.owner, path));
        const [identityProfile] = profiles;
        if (identityProfile === undefined) return yield* Effect.die("Missing profile");
        let account: string | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const [index, path] of paths.entries()) {
              const profile = profiles[index];
              if (profile !== undefined)
                yield* api.request(actors.owner, "DELETE", `${path}/profiles/${profile.id}`);
              yield* api.request(actors.owner, "DELETE", path);
            }
            if (account !== undefined)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );

        // Identical declarations share a provider even though each app checks differently.
        const providers = new Set(apps.map((app) => app.requirements.accounts.service?.provider));
        expect(providers.size).toBe(1);
        expect(identity.requirements.accounts.service?.health).toBe(true);
        expect(unchecked.requirements.accounts.service?.health).toBeUndefined();

        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${identityPath}/connections`, {
            requirement: "service",
            profile: identityProfile.id,
          }),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "apiKey", fields: { token: acceptedToken } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const accountId = (yield* body(Resource, saved)).id;
        account = accountId;
        for (const [index, path] of paths.entries()) {
          const profile = profiles[index];
          if (index === 0 || profile === undefined) continue;
          const selected = yield* selectProfileAccounts(actors.owner, path, profile.id, {
            service: accountId,
          });
          expect(selected.status, JSON.stringify(selected.body)).toBe(200);
        }

        const accountPath = `${prefix}/accounts/${accountId}`;
        const read = () =>
          Effect.flatMap(api.request(actors.owner, "GET", accountPath), (response) =>
            Effect.map(body(Detail, response), (detail) => detail.health),
          );
        const check = () =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${accountPath}/health`);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return yield* body(Health, response);
          });
        const entry = (health: typeof Health.Type, app: typeof App.Type) => {
          const found = health.apps.find((item) => item.app === app.id);
          expect(found, `${app.name} is listed`).toBeDefined();
          return found;
        };

        // Reading never checks, and nothing is reported as healthy by default.
        const initial = yield* read();
        expect(initial.info).toBeNull();
        expect(apps.map((app) => entry(initial, app))).toEqual([
          { app: identity.id, checkable: true, check: null },
          { app: plain.id, checkable: true, check: null },
          { app: unchecked.id, checkable: false, check: null },
        ]);

        // A passing identity check reports the upstream account without changing the label.
        const healthy = yield* check();
        expect(entry(healthy, identity)?.check).toMatchObject({ status: "healthy", current: true });
        expect(entry(healthy, plain)?.check).toMatchObject({ status: "healthy", current: true });
        expect(entry(healthy, unchecked)?.check).toBeNull();
        expect(healthy.info).toEqual({
          externalId: "user-4242",
          displayName: "Synthetic Person",
          username: "synthetic-person",
          avatarUrl: avatar,
        });
        const reportedAt = healthy.infoCheckedAt;
        expect(reportedAt).not.toBeNull();

        // Failures are classified per app. The plain app's check does not call the service, so it
        // still passes, and the identity reported earlier is kept with its original time. A check
        // that fails without a status naming the cause keeps the reason, including running out of
        // time.
        for (const [answer, status, message] of [
          [{ kind: "status", status: 401 }, "credentials_rejected", undefined],
          [
            {
              kind: "status",
              status: 403,
              headers: { "www-authenticate": 'Bearer error="insufficient_scope"' },
            },
            "forbidden",
            undefined,
          ],
          [{ kind: "status", status: 403 }, "check_failed", "The service answered HTTP 403."],
          [{ kind: "status", status: 503 }, "upstream_unavailable", undefined],
          [{ kind: "hang" }, "check_failed", "The check did not finish within 15 seconds."],
        ] as const) {
          yield* upstream.answer(answer);
          const failed = yield* check();
          expect(entry(failed, identity)?.check, JSON.stringify(answer)).toEqual({
            status,
            checkedAt: expect.any(String),
            current: true,
            ...(message === undefined ? {} : { message }),
          });
          // The reason is kept with the result, not only returned by the check.
          expect(entry(yield* read(), identity)?.check?.message).toBe(message);
          expect(entry(failed, plain)?.check?.status).toBe("healthy");
          expect(failed.info?.displayName).toBe("Synthetic Person");
          expect(failed.infoCheckedAt).toBe(reportedAt);
        }
        const rejected = yield* read();
        expect(JSON.stringify(rejected)).not.toContain("synthetic failure");
        expect(JSON.stringify(rejected)).not.toContain(acceptedToken);

        // The account's health shows why the last check failed.
        yield* browser.login(actors.owner);
        yield* browser.use("Serve the reported photo from its external origin", (page) =>
          page
            .context()
            .route(avatar, (route) =>
              route.fulfill({ contentType: "image/png", body: Buffer.from(pixel, "base64") }),
            ),
        );
        yield* browser.use("Open the accounts with a failed check", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/accounts`)
            .then(() => page.getByText("Synthetic Person").first().waitFor()),
        );
        yield* browser.use("Open the failed account's health", (page) =>
          page
            .getByRole("button", { name: "Manage Default" })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Check health" }).click()),
        );
        expect(
          yield* browser.use("The reason is shown with the failed check", (page) =>
            page.getByRole("dialog").locator("[data-check-message]").first().innerText(),
          ),
        ).toBe("The check did not finish within 15 seconds.");
        yield* browser.checkpoint("Failed check with its reason");
        yield* browser.use("Close the failed account's health", (page) =>
          page.getByRole("button", { name: "Close", exact: true }).first().click(),
        );

        // New credentials make every earlier result outdated rather than current.
        yield* upstream.answer({ kind: "user" });
        const reconnect = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${identityPath}/connections`, {
            requirement: "service",
            profile: identityProfile.id,
            account: accountId,
          }),
        );
        const replaced = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${reconnect.id}/submit`,
          { method: "apiKey", fields: { token: "synthetic-rotated-token" } },
        );
        expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
        const outdated = yield* read();
        expect(entry(outdated, identity)?.check).toMatchObject({ current: false });
        expect(entry(outdated, plain)?.check).toMatchObject({ current: false });
        // The rotated token is refused by the service, and only this app's check says so.
        const refused = yield* check();
        expect(entry(refused, identity)?.check).toMatchObject({
          status: "credentials_rejected",
          current: true,
        });
        expect(entry(refused, plain)?.check).toMatchObject({ status: "healthy", current: true });

        // Recovery replaces the failure, and a redeploy makes the result outdated again.
        const restore = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${identityPath}/connections`, {
            requirement: "service",
            profile: identityProfile.id,
            account: accountId,
          }),
        );
        expect(
          (yield* api.request(actors.owner, "POST", `${prefix}/connections/${restore.id}/submit`, {
            method: "apiKey",
            fields: { token: acceptedToken },
          })).status,
        ).toBe(200);
        const recovered = entry(yield* check(), identity)?.check;
        expect(recovered).toMatchObject({ status: "healthy", current: true });
        // A passing check clears the earlier failure's reason.
        expect(recovered?.message).toBeUndefined();
        const redeployed = yield* api.request(actors.owner, "POST", `${identityPath}/deploy`, {
          files: [
            {
              path: "index.ts",
              content: `${source(identityCheck(upstream.origin))}\n// redeployed`,
            },
            appsManifest,
          ],
        });
        expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
        expect(entry(yield* read(), identity)?.check).toMatchObject({
          status: "healthy",
          current: false,
        });

        // The account list marks the outdated result and shows the reported identity.
        yield* browser.use("Open the accounts", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/accounts`)
            .then(() => page.getByText("Synthetic Person").first().waitFor()),
        );
        expect(
          yield* browser.use("Outdated result is marked", (page) =>
            page.locator('[data-check-status="healthy"][data-check-current="false"]').count(),
          ),
        ).toBe(1);
        // Opening the account's health rechecks it and lists each app's result.
        yield* browser.use("Open account health", (page) =>
          page
            .getByRole("button", { name: "Manage Default" })
            .click()
            .then(() => page.getByRole("menuitem", { name: "Check health" }).click()),
        );
        yield* browser.use("Outdated result is rechecked", (page) =>
          page
            .getByRole("dialog")
            .locator('[data-check-status="healthy"][data-check-current="true"]')
            .nth(1)
            .waitFor(),
        );
        expect(
          yield* browser.use("Unchecked app is labelled", (page) =>
            page.getByRole("dialog").getByText("No check", { exact: true }).count(),
          ),
        ).toBe(1);
        yield* browser.checkpoint("Account health by app");
        yield* browser.use("Close account health", (page) =>
          page.getByRole("button", { name: "Close", exact: true }).first().click(),
        );
        yield* browser.use("The list shows the new result", (page) =>
          page.locator('[data-check-status="healthy"][data-check-current="true"]').nth(1).waitFor(),
        );
        // The reported photo stands beside the identity in the list.
        expect(
          yield* browser.use("The list shows the reported photo", (page) => {
            const photo = page.locator(".account-identity [data-slot='avatar-image']").first();
            return photo.waitFor({ state: "visible" }).then(() => photo.getAttribute("src"));
          }),
        ).toBe(avatar);
        yield* browser.checkpoint("Account list with check results");

        // Another redeploy makes the result outdated; viewing the app's accounts shows it at once
        // and checks it again in the background, without any action.
        const again = yield* api.request(actors.owner, "POST", `${identityPath}/deploy`, {
          files: [
            {
              path: "index.ts",
              content: `${source(identityCheck(upstream.origin))}\n// redeployed again`,
            },
            appsManifest,
          ],
        });
        expect(again.status, JSON.stringify(again.body)).toBe(200);
        expect(entry(yield* read(), identity)?.check).toMatchObject({ current: false });

        // The app's accounts show each account with its reported photo.
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(
            `/org/${actors.organization.slug}/apps/${identity.id}?view=accounts&profile=${identityProfile.id}`,
          ),
        );
        expect(
          yield* browser.use("The account row shows the reported photo", (page) => {
            const photo = page
              .locator(".accounts-section li")
              .filter({ hasText: "Default" })
              .locator("[data-slot='account-avatar'] [data-slot='avatar-image']");
            return photo.waitFor({ state: "visible" }).then(() => photo.getAttribute("src"));
          }),
        ).toBe(avatar);
        yield* browser.use("The outdated result is checked again on view", (page) =>
          page
            .locator(".accounts-section li")
            .filter({ hasText: "Default" })
            .locator('[data-check-status="healthy"][data-check-current="true"]')
            .waitFor(),
        );
        expect(entry(yield* read(), identity)?.check).toMatchObject({
          status: "healthy",
          current: true,
        });
        yield* browser.checkpoint("App accounts with the reported photo");
        expect(entry(yield* read(), identity)?.check).toMatchObject({
          status: "healthy",
          current: true,
        });
      }),
    ),
  );
});
