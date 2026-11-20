/**
 * The Executor app's managed key: revoking it on the Tokens page no longer breaks the app, only a
 * member who may hold it gets it back, and an Executor API key account is checked when connected.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import type { Response } from "../support/platform.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import {
  connectionsPath,
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
} from "../support/app-accounts.ts";
import { managementApp } from "../support/management-app.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";

const managedName = "Executor app (created automatically)";
/** What a call that may write says once access is restored, since it is not repeated. */
const restoredSentence =
  "Access was restored. This call was not repeated; earlier steps may have changed data. Check the result and retry only if the user chooses.";
/** The one sentence a refused API key's 401 gives the agent where recovery is not automatic. */
const replaceKeySentence =
  "This Executor API key was revoked, has expired or does not exist; unless Executor restores access by itself, create a new token on the Tokens page and connect it to the account that uses this key.";
const Keys = Schema.Struct({
  apiKeys: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
      metadata: Schema.NullOr(Schema.Struct({ organization: Schema.optional(Schema.String) })),
    }),
  ),
});
const Created = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Identity = Schema.Struct({ organization: Schema.String, role: Schema.String });
const Inventory = Schema.Struct({
  accounts: Schema.Array(Schema.Struct({ id: Schema.String, method: Schema.String })),
});
const Organizations = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }),
);
const Members = Schema.Struct({
  members: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String })),
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Identity }),
});
const Refused = Schema.Struct({
  _tag: Schema.Literal("AppProviderFailed"),
  reason: Schema.Literal("unauthorized"),
  status: Schema.Literal(401),
  account: Schema.Struct({ id: Schema.String }),
  upstream: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const KeyRefused = Schema.Struct({
  _tag: Schema.Literal("ExecutorKeyRefused"),
  reason: Schema.String,
  message: Schema.String,
});
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Deployed = Schema.Struct({ id: Schema.String });
const OrganizationCreated = Schema.Struct({ id: Schema.String, slug: Schema.String });
/**
 * Another app with the Executor app's own provider. Its one tool reports that the service refused
 * the caller's account, without calling the service, as any app's code can.
 */
const refusingApp = `import { defineApp, query, router, object, ProviderError } from "apps";
import { provider } from "./provider.ts";
export default defineApp({ user: { accounts: { service: provider } } }, async ({ user: { accounts } }) => ({
  tools: router({
    refuse: query({ input: object({}) }, async () => {
      throw new ProviderError({ reason: "unauthorized", status: 401, accountId: accounts.service.id });
    }),
  }),
}));
`;

/**
 * Wait for the page's finite animations, such as a dialog opening or a theme change, before a
 * screenshot. A looping animation never finishes, so it is not waited for.
 */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        // A transition another replaces is cancelled, which also ends it.
        .map((animation) => animation.finished.catch(() => animation)),
    ).then(() => undefined),
  );

/** The actor's keys named as the Executor app's, pinned to `organization`. */
const managedKeys = (actor: Session, organization: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const page = yield* body(
      Keys,
      yield* api.request(actor, "GET", "/api/auth/api-key/list?limit=100"),
    );
    return page.apiKeys.filter(
      (key) => key.name === managedName && key.metadata?.organization === organization,
    );
  });

/** The organization's display name, which its URL slug is not. */
const organizationName = (actor: Session, organization: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const listed = yield* body(
      Organizations,
      yield* api.request(actor, "GET", "/api/auth/organization/list"),
    );
    const found = listed.find((item) => item.id === organization);
    if (found === undefined) return yield* Effect.die("The organization is not listed");
    return found.name;
  });

/** Revoke one of the actor's keys and require success. */
const revokeKey = (actor: Session, keyId: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const revoked = yield* api.request(actor, "POST", "/api/auth/api-key/delete", { keyId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  });

/** One confirmed read of the Executor app at `path` as `actor`. */
const contextRead = (actor: Session, path: string) =>
  Effect.flatMap(Api, (api) =>
    api.request(actor, "POST", `${path}/tools/call`, {
      tool: "context.get",
      kind: "query",
      input: {},
    }),
  );

/**
 * A refused read either answers, repeated with the renewed key, or, where the app has not confirmed
 * the tool only reads, fails once saying access was restored. Either way the next read answers.
 */
const answeredOrRestored = (response: Response, organization: string, restored: string[]) =>
  Effect.gen(function* () {
    if (response.status === 200) {
      expect(yield* body(Identity, response)).toEqual({ organization, role: "owner" });
      return;
    }
    expect(response.status, JSON.stringify(response.body)).toBe(502);
    expect(response.body).toMatchObject({ reason: "unauthorized", credentialsRenewed: true });
    // Its words are checked once the scenario's other checks have run (`saidRestored`).
    restored.push(JSON.stringify(response.body));
  });
/** Every call that failed once because access was restored says so in the same words. */
const saidRestored = (restored: ReadonlyArray<string>) =>
  Effect.sync(() => {
    for (const text of restored) expect(text).toContain(restoredSentence);
  });

const apiKeyAccounts = (actor: Session, organization: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const inventory = yield* body(
      Inventory,
      yield* api.request(actor, "GET", `/api/organizations/${organization}/inventory`),
    );
    return inventory.accounts.filter((item) => item.method === "apiKey").map((item) => item.id);
  });

layer(HostedLive, { excludeTestServices: true })("Executor app's managed key", (it) => {
  it.effect(scenarios.executorManagedKeyRenewed.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const organization = actors.organization.id;
        const name = yield* organizationName(actors.owner, organization);
        const { app, account } = yield* managementApp(actors.owner);
        const path = `/api/organizations/${organization}/apps/${app.id}`;
        const [original] = yield* managedKeys(actors.owner, organization);
        if (original === undefined) return yield* Effect.die("The managed key is missing");
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "executor-managed-key",
        );
        const contextGet = (name: string) =>
          client
            .use(name, (client, signal) =>
              client.callTool(
                {
                  name: "execute",
                  arguments: {
                    code: `return await tools[${JSON.stringify(app.slug)}].context.get({});`,
                  },
                },
                undefined,
                { signal },
              ),
            )
            .pipe(
              Effect.flatMap((called) =>
                Schema.decodeUnknownEffect(Completed)(called.structuredContent).pipe(
                  Effect.mapError(
                    (error) =>
                      new Error(`${error.message}\n${JSON.stringify(called.structuredContent)}`),
                  ),
                ),
              ),
              Effect.map((result) => result.execution.value),
            );
        expect(yield* contextGet("The Executor app answers before the key is revoked")).toEqual({
          organization,
          role: "owner",
        });

        yield* browser.use("Open the account Tokens page", (page) => page.goto("/account/tokens"));
        const row = yield* browser.use("The managed key is listed", (page) => {
          const row = page.getByRole("row").filter({ hasText: managedName });
          return row.waitFor().then(() => row);
        });
        for (const scheme of ["light", "dark"] as const) {
          yield* browser.use(`Use ${scheme} mode`, (page) =>
            page.emulateMedia({ colorScheme: scheme }).then(() => settled(page)),
          );
          yield* browser.checkpoint(`tokens-managed-key-${scheme}`);
        }
        const marking = yield* browser.use("Read the managed key's row", () => row.innerText());
        yield* browser.use("Open the managed key's revoke dialog", (page) =>
          page.getByRole("button", { name: `Revoke ${managedName}`, exact: true }).click(),
        );
        const dialog = yield* browser.use("The revoke dialog opens", (page) => {
          const dialog = page.getByRole("dialog");
          return dialog.waitFor().then(() => dialog);
        });
        for (const scheme of ["light", "dark"] as const) {
          yield* browser.use(`Use ${scheme} mode`, (page) =>
            page.emulateMedia({ colorScheme: scheme }).then(() => settled(page)),
          );
          yield* browser.checkpoint(`tokens-managed-key-revoke-${scheme}`);
        }
        expect(marking).toContain("In use by the Executor app");
        const explanation = yield* browser.use("Read the revoke dialog", () => dialog.innerText());
        expect(explanation).toContain(
          `The Executor app uses this key to run its management tools for you, for agents connected to ${name}.`,
        );
        expect(explanation).toContain(
          "On the next call, Executor creates a new key for the app automatically, so revoking it does not turn the app off.",
        );
        expect(explanation).toContain(
          "To stop the app acting for you, remove its account under Apps, Executor, Accounts instead.",
        );
        expect(explanation).not.toContain("Create and install a replacement first");
        expect(
          yield* browser.use("Revoke the managed key", (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  response.request().method() === "POST" &&
                  new URL(response.url()).pathname === "/api/auth/api-key/delete",
              ),
              dialog.getByRole("button", { name: "Revoke token", exact: true }).click(),
            ]).then(([response]) => response.status()),
          ),
        ).toBe(200);
        expect(yield* managedKeys(actors.owner, organization)).toEqual([]);

        // Ten agents' calls arrive together, each with the revoked key; each read is repeated once
        // with the one key the first renewal saved.
        const answers = yield* Effect.forEach(
          Array.from({ length: 10 }, (_, index) => index),
          (index) => contextGet(`Management call ${index + 1} after the key was revoked`),
          { concurrency: 10 },
        );
        expect(answers).toEqual(
          Array.from({ length: 10 }, () => ({ organization, role: "owner" })),
        );
        const renewed = yield* managedKeys(actors.owner, organization);
        expect(renewed).toHaveLength(1);
        expect(renewed[0]?.id).not.toBe(original.id);
        // The same account holds the new key and stays the app's one link for this member.
        expect(yield* apiKeyAccounts(actors.owner, organization)).toEqual([account]);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);
        expect(yield* contextGet("A later call uses the renewed key")).toEqual({
          organization,
          role: "owner",
        });
        expect((yield* managedKeys(actors.owner, organization)).map((key) => key.id)).toEqual([
          renewed[0]?.id,
        ]);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );

  it.effect(scenarios.executorManagedKeyIneligible.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organization = actors.organization.id;
        const { app, account } = yield* managementApp(actors.admin);
        const path = `/api/organizations/${organization}/apps/${app.id}`;
        const [key] = yield* managedKeys(actors.admin, organization);
        if (key === undefined) return yield* Effect.die("The admin's managed key is missing");
        expect(
          (yield* api.request(actors.admin, "POST", "/api/auth/api-key/delete", {
            keyId: key.id,
          })).status,
        ).toBe(200);
        const members = yield* body(
          Members,
          yield* api.request(
            actors.owner,
            "GET",
            `/api/auth/organization/list-members?organizationId=${organization}`,
          ),
        );
        const member = members.members.find((entry) => entry.role === "admin");
        if (member === undefined) return yield* Effect.die("Admin fixture missing");
        const setRole = (role: "admin" | "member") =>
          api
            .request(actors.owner, "POST", "/api/auth/organization/update-member-role", {
              organizationId: organization,
              memberId: member.id,
              role,
            })
            .pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))));
        const call = api.request(actors.admin, "POST", `${path}/tools/call`, {
          tool: "context.get",
          kind: "query",
          input: {},
        });
        // A member may not hold a managed key, so losing the admin role means nothing is minted.
        yield* setRole("member");
        for (const attempt of ["first", "second"]) {
          const refused = yield* call;
          expect(refused.status, `${attempt}: ${JSON.stringify(refused.body)}`).toBe(502);
          const failure = yield* Schema.decodeUnknownEffect(Refused)(refused.body);
          expect(failure.account.id).toBe(account);
          expect(failure.upstream.code).toBe("Unauthorized");
          expect(failure.upstream.message).toBe(replaceKeySentence);
          expect(yield* managedKeys(actors.admin, organization)).toEqual([]);
        }
        // The same member made admin again may hold it, and the next call restores it. A call that
        // names no kind may write, so it is not repeated: it fails once, saying access was restored.
        yield* setRole("admin");
        const renewing = yield* api.request(actors.admin, "POST", `${path}/tools/call`, {
          tool: "context.get",
          input: {},
        });
        expect(renewing.status, JSON.stringify(renewing.body)).toBe(502);
        expect(renewing.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "unauthorized",
          account: { id: account },
          credentialsRenewed: true,
        });
        expect(yield* Schema.decodeUnknownEffect(Refused)(renewing.body)).toMatchObject({
          upstream: { message: replaceKeySentence },
        });
        expect(JSON.stringify(renewing.body)).toContain(restoredSentence);
        expect(yield* managedKeys(actors.admin, organization)).toHaveLength(1);
        const restored = yield* call;
        expect(restored.status, JSON.stringify(restored.body)).toBe(200);
        expect(yield* body(Identity, restored)).toEqual({ organization, role: "admin" });
        expect(yield* managedKeys(actors.admin, organization)).toHaveLength(1);
        expect(yield* apiKeyAccounts(actors.admin, organization)).toEqual([account]);

        // A removed member loses their pinned keys and every call; nothing is minted for them.
        const removed = yield* api.request(
          actors.owner,
          "POST",
          "/api/auth/organization/remove-member",
          { organizationId: organization, memberIdOrEmail: member.id },
        );
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
        expect(yield* managedKeys(actors.admin, organization)).toEqual([]);
        for (const attempt of ["first", "second"]) {
          const refused = yield* call;
          expect(refused.status, `${attempt}: ${JSON.stringify(refused.body)}`).not.toBe(200);
          expect(yield* managedKeys(actors.admin, organization)).toEqual([]);
        }
      }),
    ),
  );

  it.effect(scenarios.executorKeyOrganizationChecked.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const organization = actors.organization;
        // A display name as people write one, which can never be read as a URL slug.
        const name = `Synthetic Key Check Team ${randomUUID().slice(0, 4)}`;
        const renamed = yield* api.request(actors.owner, "POST", "/api/auth/organization/update", {
          organizationId: organization.id,
          data: { name },
        });
        expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
        expect(yield* organizationName(actors.owner, organization.id)).toBe(name);
        const prefix = `/api/organizations/${organization.id}`;
        const { app, account } = yield* managementApp(actors.owner);
        const path = `${prefix}/apps/${app.id}`;
        const created = yield* body(
          Created,
          yield* api.request(actors.owner, "POST", "/api/auth/api-key/create", {
            name: "Synthetic replacement token",
            metadata: { organization: organization.id },
          }),
        );
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "POST", "/api/auth/api-key/delete", { keyId: created.id })
            .pipe(Effect.orDie),
        );
        const token = Redacted.value(created.key);

        yield* browser.login(actors.owner);
        yield* browser.use("Open the Executor app's accounts", (page) =>
          page.goto(`/org/${organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new account", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const connect = yield* browser.use("The connection dialog opens", (page) => {
          const dialog = page.getByRole("dialog", { name: "Connect Executor", exact: true });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        yield* browser.use("Choose the Executor API key method", (page) =>
          connect
            .getByRole("combobox", { name: "Sign-in method" })
            .click()
            .then(() =>
              page.getByRole("option", { name: "Executor API key", exact: true }).click(),
            ),
        );
        yield* browser.use("Enter the token", () =>
          connect.getByLabel("Token", { exact: true }).fill(token),
        );
        yield* browser.use("Enter the organization's name instead of its URL slug", () =>
          connect.getByLabel("Organization", { exact: true }).fill(name),
        );
        const submitted = yield* browser.use("Connect the account", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                /\/connections\/[^/]+\/submit$/.test(new URL(response.url()).pathname),
            ),
            connect.getByRole("button", { name: "Connect account", exact: true }).click(),
          ]).then(([response]) => response.status()),
        );
        yield* browser.use("Wait for the form's answer", (page) =>
          page.getByRole("alert").or(page.getByText("Executor is connected.")).first().waitFor(),
        );
        for (const scheme of ["light", "dark"] as const) {
          yield* browser.use(`Use ${scheme} mode`, (page) =>
            page.emulateMedia({ colorScheme: scheme }).then(() => settled(page)),
          );
          yield* browser.checkpoint(`connect-executor-key-name-${scheme}`);
        }
        expect(submitted).toBe(422);
        const alert = yield* browser.use("Read the form's refusal", (page) =>
          page.getByRole("alert").first().innerText(),
        );
        expect(alert).toContain(
          "Organization must be the organization's URL slug or ID, as in its dashboard address after /org/, not its name.",
        );
        expect(
          yield* browser.use("Nothing says the account is connected", (page) =>
            page.getByText("is connected.").count(),
          ),
        ).toBe(0);

        const submit = (fields: { token: string; organization: string }) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Schema.Struct({ id: Schema.String }),
              yield* api.request(
                actors.owner,
                "POST",
                connectionsPath(path, "user", "service"),
                {},
              ),
            );
            return yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${connection.id}/submit`,
              { method: "apiKey", label: `Replacement ${randomUUID().slice(0, 6)}`, fields },
            );
          });
        const refusal = (fields: { token: string; organization: string }) =>
          submit(fields).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(422)),
            ),
            Effect.flatMap((response) => Schema.decodeUnknownEffect(KeyRefused)(response.body)),
          );
        expect((yield* refusal({ token, organization: name })).reason).toBe("organization");
        // A well-formed slug that names no organization the token can reach.
        const unreachable = yield* refusal({
          token,
          organization: `no-such-organization-${randomUUID().slice(0, 8)}`,
        });
        expect(unreachable.reason).toBe("unreachable");
        expect(unreachable.message).toContain("cannot reach the organization entered");
        const revoked = yield* refusal({
          token: `exp_${randomUUID().replaceAll("-", "")}`,
          organization: organization.slug,
        });
        expect(revoked.reason).toBe("token");
        // Nothing refused was saved: the managed key is still the only API key account.
        expect(yield* apiKeyAccounts(actors.owner, organization.id)).toEqual([account]);

        const call = api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "context.get",
          kind: "query",
          input: {},
        });
        for (const reference of [organization.slug, organization.id]) {
          const saved = yield* submit({ token, organization: reference });
          expect(saved.status, JSON.stringify(saved.body)).toBe(200);
          const answered = yield* call;
          expect(answered.status, JSON.stringify(answered.body)).toBe(200);
          expect(yield* body(Identity, answered)).toEqual({
            organization: organization.id,
            role: "owner",
          });
        }
      }),
    ),
  );

  it.effect(scenarios.executorManagedKeyOtherApp.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const { app, account } = yield* managementApp(actors.owner);
        const path = `${prefix}/apps/${app.id}`;
        const [original] = yield* managedKeys(actors.owner, organization);
        if (original === undefined) return yield* Effect.die("The managed key is missing");
        // The owner deploys another app with the Executor app's provider and links the managed
        // account to it as well, which any member may do with an account of their own.
        const source = yield* body(
          Source,
          yield* api.request(actors.owner, "GET", `${path}/source`),
        );
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Synthetic refusing app ${randomUUID().slice(0, 6)}`,
          files: source.files.map((file) =>
            file.path === "index.ts" ? { path: file.path, content: refusingApp } : file,
          ),
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const otherPath = `${prefix}/apps/${(yield* body(Deployed, deployed)).id}`;
        yield* linkAccount(actors.owner, otherPath, "service", account);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);
        const refuse = api.request(actors.owner, "POST", `${otherPath}/tools/call`, {
          tool: "refuse",
          input: {},
        });
        /** The other app's refusal stands as it reported it: nothing renewed, nothing minted. */
        const refusedAsReported = (attempt: string) =>
          Effect.gen(function* () {
            const refused = yield* refuse;
            expect(refused.status, `${attempt}: ${JSON.stringify(refused.body)}`).toBe(502);
            expect(refused.body).toMatchObject({
              _tag: "AppProviderFailed",
              reason: "unauthorized",
              account: { id: account },
            });
            expect(refused.body).not.toHaveProperty("credentialsRenewed");
            expect(JSON.stringify(refused.body)).not.toContain(restoredSentence);
          });

        // The key is revoked while the account is linked to both apps. The other app's refusal
        // mints nothing and is told nothing: only the Executor app's own calls renew its key.
        yield* revokeKey(actors.owner, original.id);
        yield* refusedAsReported("The other app reports the revoked key refused");
        expect(yield* managedKeys(actors.owner, organization)).toEqual([]);

        // A hundred of the Executor app's own reads arrive together with the revoked key: each
        // uses the one key the first renewal saved, and a later read answers.
        const answers = yield* Effect.forEach(
          Array.from({ length: 100 }, (_, index) => index),
          () => contextRead(actors.owner, path),
          { concurrency: 100 },
        );
        const restored: string[] = [];
        for (const answered of answers) yield* answeredOrRestored(answered, organization, restored);
        const later = yield* contextRead(actors.owner, path);
        expect(later.status, JSON.stringify(later.body)).toBe(200);
        const renewed = yield* managedKeys(actors.owner, organization);
        expect(renewed).toHaveLength(1);
        expect(renewed[0]?.id).not.toBe(original.id);
        expect(yield* apiKeyAccounts(actors.owner, organization)).toEqual([account]);
        // With a key that exists, a refusal the other app reports changes nothing.
        yield* refusedAsReported("The other app reports the renewed key refused");
        expect((yield* managedKeys(actors.owner, organization)).map((key) => key.id)).toEqual([
          renewed[0]?.id,
        ]);

        // The owner unlinks the account from the Executor app and revokes its key; the account
        // stays linked to the other app, whose refusal again mints nothing.
        yield* unlinkAccount(actors.owner, path, "service", account);
        yield* revokeKey(actors.owner, renewed[0]!.id);
        yield* refusedAsReported("The other app reports the key refused after the unlink");
        expect(yield* managedKeys(actors.owner, organization)).toEqual([]);
        const unlinked = yield* contextRead(actors.owner, path);
        expect(unlinked.status, JSON.stringify(unlinked.body)).not.toBe(200);
        expect(yield* managedKeys(actors.owner, organization)).toEqual([]);
        yield* saidRestored(restored);
      }),
    ),
  );

  it.effect(scenarios.executorManagedKeyAccountDeleted.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organization = actors.organization.id;
        const { app, account } = yield* managementApp(actors.owner);
        const path = `/api/organizations/${organization}/apps/${app.id}`;
        // The cut-off the revoke dialog names: delete the account under Apps, Executor, Accounts.
        const deleted = yield* api.request(
          actors.owner,
          "DELETE",
          `/api/organizations/${organization}/accounts/${account}`,
        );
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        // Its key, if deleting the account left it, is revoked too, so a new key would show.
        for (const key of yield* managedKeys(actors.owner, organization))
          yield* revokeKey(actors.owner, key.id);
        for (const round of ["first", "second"]) {
          const calls = yield* Effect.forEach(
            Array.from({ length: 10 }, (_, index) => index),
            () => contextRead(actors.owner, path),
            { concurrency: 10 },
          );
          for (const called of calls)
            expect(called.status, `${round}: ${JSON.stringify(called.body)}`).not.toBe(200);
          // Reading the inventory runs member setup, which never recreates a deleted account.
          expect(yield* apiKeyAccounts(actors.owner, organization)).toEqual([]);
          expect(yield* managedKeys(actors.owner, organization)).toEqual([]);
          expect(yield* linkedAccountIds(actors.owner, path)).toEqual([]);
        }
      }),
    ),
  );

  it.effect(scenarios.executorManagedKeyTwoOrganizations.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const first = actors.organization.id;
        const created = yield* api.request(actors.owner, "POST", "/api/auth/organization/create", {
          name: "Synthetic second organization",
          slug: `managed-key-second-${randomUUID().slice(0, 8)}`,
          keepCurrentActiveOrganization: true,
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const second = (yield* body(OrganizationCreated, created)).id;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `/api/organizations/${second}`).pipe(Effect.orDie),
        );
        const firstApp = yield* managementApp(actors.owner, first);
        const secondApp = yield* managementApp(actors.owner, second);
        const firstPath = `/api/organizations/${first}/apps/${firstApp.app.id}`;
        const secondPath = `/api/organizations/${second}/apps/${secondApp.app.id}`;
        const [firstKey] = yield* managedKeys(actors.owner, first);
        const [secondKey] = yield* managedKeys(actors.owner, second);
        if (firstKey === undefined || secondKey === undefined)
          return yield* Effect.die("A managed key is missing");
        yield* revokeKey(actors.owner, firstKey.id);
        // The other organization's app answers with its own key, and mints nothing for the first.
        const elsewhere = yield* contextRead(actors.owner, secondPath);
        expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(200);
        expect(yield* body(Identity, elsewhere)).toEqual({ organization: second, role: "owner" });
        expect(yield* managedKeys(actors.owner, first)).toEqual([]);
        expect((yield* managedKeys(actors.owner, second)).map((key) => key.id)).toEqual([
          secondKey.id,
        ]);
        // The first organization's app recreates its own key, pinned to the first organization.
        const restored: string[] = [];
        yield* answeredOrRestored(yield* contextRead(actors.owner, firstPath), first, restored);
        const later = yield* contextRead(actors.owner, firstPath);
        expect(later.status, JSON.stringify(later.body)).toBe(200);
        expect(yield* body(Identity, later)).toEqual({ organization: first, role: "owner" });
        const recreated = yield* managedKeys(actors.owner, first);
        expect(recreated).toHaveLength(1);
        expect(recreated[0]?.id).not.toBe(firstKey.id);
        expect((yield* managedKeys(actors.owner, second)).map((key) => key.id)).toEqual([
          secondKey.id,
        ]);
        expect(yield* apiKeyAccounts(actors.owner, first)).toEqual([firstApp.account]);
        expect(yield* apiKeyAccounts(actors.owner, second)).toEqual([secondApp.account]);
        yield* saidRestored(restored);
      }),
    ),
  );
});
