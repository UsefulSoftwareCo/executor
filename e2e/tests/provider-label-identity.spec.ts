/**
 * A secrets method's label is display text, not part of its provider's identity. Rewording it keeps
 * the provider and every account saved for it, and each app's connect form shows its own wording.
 * Changing what the credential is, such as a field or the set of methods, still makes a new
 * provider. Accounts saved before labels left the ID keep filling their app's requirement.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { connectionsPath, linkAccount } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

const Deployed = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({
      service: Schema.Struct({
        provider: Schema.String,
        definition: Schema.Record(Schema.String, Schema.Json),
      }),
    }),
  }),
});
const Redeployed = Schema.Struct({ app: Deployed });
const Token = Schema.Struct({ account: Schema.String, token: Schema.String });

/**
 * One app whose `service` requirement has a key method labelled `label`. `hint` gives its field a
 * title and description, display text like the label. `field` names the key's field and `backup`
 * adds a second method; both change what the credential is. The check makes the connect form name
 * the method on its validate button.
 */
const source = ({
  label,
  hint,
  field = "token",
  backup = true,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly field?: string;
  readonly backup?: boolean;
}) => `import { defineApp, defineProvider, jsonSchema, object, query, router, secrets, string, type QueryContext } from "apps";
const declared = object({ ${field}: string() });
// The same fields as a JSON Schema document, whose field has a title and description.
const fields = ${hint === undefined ? "declared" : `jsonSchema(${JSON.stringify(hinted(field, hint))}) as unknown as typeof declared`};
const service = defineProvider({
  name: "Wording fixture",
  auth: {
    key: secrets({ label: ${JSON.stringify(label)}, fields }),
    ${backup ? `backup: secrets({ label: "Backup key", fields: object({ token: string() }) }),` : ""}
  },
  async health() {},
});
const requirements = { user: { accounts: { service } } };
const token = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => {
  const account = ctx.user.accounts.service;
  return { account: account.id, token: Object.values(account.fields)[0] };
});
export default defineApp(requirements, async () => ({ tools: router({ token }) }));
`;
/** The document `object({ [field]: string() })` declares, with a title and description on it. */
const hinted = (field: string, hint: string) => ({
  type: "object",
  properties: {
    [field]: { type: "string", title: hint, description: `${hint}, from your settings` },
  },
  required: [field],
  additionalProperties: true,
  $defs: {},
  $schema: "https://json-schema.org/draft/2020-12/schema",
});
const files = (options: Parameters<typeof source>[0]) => [
  { path: "index.ts", content: source(options) },
  appsManifest,
];

/** JSON with object keys sorted, as the host orders a definition before hashing it. */
const canonical = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** The ID earlier versions gave a definition: its hash without hosts, labels included. */
const labelledId = (definition: Readonly<Record<string, Schema.Json>>) => {
  const { hosts: _hosts, ...shared } = definition;
  return `prv_${createHash("sha256").update(canonical(shared)).digest("hex")}`;
};

/** Deploy, connect, link and call apps of one organization through the hosted API. */
const organizationApps = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors;
  const prefix = `/api/organizations/${actors.organization.id}`;
  const apps: string[] = [];
  const accounts: string[] = [];
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const app of apps) yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app}`);
      for (const account of accounts)
        yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
    }).pipe(Effect.orDie),
  );
  const deploy = (options: Parameters<typeof source>[0]) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: `Wording ${randomUUID().slice(0, 8)}`,
        files: files(options),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const app = yield* body(Deployed, response);
      apps.push(app.id);
      return app;
    });
  const redeploy = (app: string, options: Parameters<typeof source>[0]) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/${app}/deploy`, {
        files: files(options),
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return (yield* body(Redeployed, response)).app;
    });
  /** Connect a key account from the app, which links it to the app's `service` requirement. */
  const connect = (app: string, token: string) =>
    Effect.gen(function* () {
      const requested = yield* api.request(
        actors.owner,
        "POST",
        connectionsPath(`${prefix}/apps/${app}`, "user", "service"),
        {},
      );
      expect(requested.status, JSON.stringify(requested.body)).toBe(200);
      const connection = yield* body(Resource, requested);
      const saved = yield* api.request(
        actors.owner,
        "POST",
        `${prefix}/connections/${connection.id}/submit`,
        { method: "key", label: "Wording account", fields: { token } },
      );
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const account = yield* body(Resource, saved);
      accounts.push(account.id);
      return account.id;
    });
  const link = (app: string, account: string) =>
    linkAccount(actors.owner, `${prefix}/apps/${app}`, "service", account);
  const call = (app: string) =>
    api.request(actors.owner, "POST", `${prefix}/apps/${app}/tools/call`, {
      tool: "token",
      kind: "query",
      input: {},
    });
  /** The tool runs with the linked account and reads its key. */
  const filled = (app: string) =>
    Effect.gen(function* () {
      const response = yield* call(app);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return yield* body(Token, response);
    });
  return { actors, prefix, deploy, redeploy, connect, link, call, filled };
});

/** The connect form of the app's `service` requirement names its key method's label. */
const formShows = (app: string, label: string) =>
  Effect.gen(function* () {
    const actors = yield* Actors,
      browser = yield* Browser;
    yield* browser.use(`Open the connect form of ${app}`, (page) =>
      page
        .goto(`/org/${actors.organization.slug}/apps/${app}?view=accounts`)
        .then(() =>
          page.getByRole("button", { name: "Connect new account", exact: true }).first().click(),
        ),
    );
    return yield* browser.use(`The form names "${label}"`, (page) => {
      const dialog = page.getByRole("dialog", { name: "Connect Wording fixture", exact: true });
      return dialog
        .getByRole("button", { name: `Validate ${label}`, exact: true })
        .waitFor({ state: "visible" })
        .then(() => dialog.textContent())
        .then((text) => page.keyboard.press("Escape").then(() => text ?? ""));
    });
  });

layer(HostedLive, { excludeTestServices: true })("Provider label identity", (it) => {
  it.effect(scenarios.providerLabelIdentity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const { actors, deploy, redeploy, connect, link, call, filled } = yield* organizationApps;
        const first = yield* deploy({ label: "First wording" });
        const provider = first.requirements.accounts.service.provider;
        const account = yield* connect(first.id, "synthetic-wording-token");
        expect(yield* filled(first.id)).toEqual({ account, token: "synthetic-wording-token" });

        // Rewording the method keeps the provider, so the linked account still fills the slot.
        const reworded = yield* redeploy(first.id, { label: "Second wording" });
        expect(reworded.requirements.accounts.service.provider).toBe(provider);
        expect(yield* filled(first.id)).toEqual({ account, token: "synthetic-wording-token" });

        // So does giving its field a title and description, which forms show.
        const hinted = yield* redeploy(first.id, { label: "Second wording", hint: "Wording key" });
        expect(JSON.stringify(hinted.requirements.accounts.service.definition)).toContain(
          "Wording key, from your settings",
        );
        expect(hinted.requirements.accounts.service.provider).toBe(provider);
        expect(yield* filled(first.id)).toEqual({ account, token: "synthetic-wording-token" });

        // Another app that words it differently shares the provider and the account. Deployed
        // last, its wording is the one the shared provider row holds.
        const other = yield* deploy({ label: "Third wording" });
        expect(other.requirements.accounts.service.provider).toBe(provider);
        yield* link(other.id, account);
        expect(yield* filled(other.id)).toEqual({ account, token: "synthetic-wording-token" });

        // Each connect form shows its own app's wording, not the shared row's.
        yield* browser.login(actors.owner);
        const firstForm = yield* formShows(first.id, "Second wording");
        expect(firstForm).not.toContain("First wording");
        expect(firstForm).not.toContain("Third wording");
        const otherForm = yield* formShows(other.id, "Third wording");
        expect(otherForm).not.toContain("Second wording");

        // A different key field is a different credential: a new provider the account can't fill.
        const refielded = yield* redeploy(first.id, { label: "Second wording", field: "apiKey" });
        expect(refielded.requirements.accounts.service.provider).not.toBe(provider);
        expect((yield* call(first.id)).status).not.toBe(200);

        // So is removing a method.
        const narrowed = yield* redeploy(other.id, { label: "Third wording", backup: false });
        const narrowedProvider = narrowed.requirements.accounts.service.provider;
        expect(narrowedProvider).not.toBe(provider);
        expect(narrowedProvider).not.toBe(refielded.requirements.accounts.service.provider);
        expect((yield* call(other.id)).status).not.toBe(200);
      }),
    ),
  );

  it.effect(scenarios.providerLabelIdentityLegacy.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const { actors, deploy, redeploy, connect, link, filled } = yield* organizationApps;
        const app = yield* deploy({ label: "Old wording" });
        const current = app.requirements.accounts.service.provider;
        const account = yield* connect(app.id, "synthetic-legacy-token");

        // Store the provider as an earlier version did: under an ID its label is part of, with no
        // identity recorded, which the account, its connection and the app's version all name.
        const legacy = labelledId(app.requirements.accounts.service.definition);
        expect(legacy).not.toBe(current);
        yield* legacyStorage([
          {
            sql: `INSERT INTO executor_providers (id, definition)
              SELECT $1, definition FROM executor_providers WHERE id = $2`,
            params: [legacy, current],
          },
          {
            sql: "UPDATE executor_accounts SET provider = $1 WHERE id = $2",
            params: [legacy, account],
          },
          {
            sql: "UPDATE executor_account_connections SET provider = $1 WHERE provider = $2",
            params: [legacy, current],
          },
          {
            sql: `UPDATE executor_deployments SET requirements = replace(requirements::text, $2, $1)::json
              WHERE code = (SELECT code FROM executor_apps WHERE id = $3)`,
            params: [legacy, current, app.id],
          },
          { sql: "DELETE FROM executor_providers WHERE id = $1", params: [current] },
          // The fresh install ran the upgrade's data step over no providers; the upgrade runs it.
          ...["private_hosted_data_step_items", "private_hosted_data_steps"].map((journal) => ({
            sql: `DELETE FROM ${journal} WHERE name = $1`,
            params: ["11_provider_identities"],
          })),
        ]);
        // The upgrade's data step records the stored provider's identity.
        yield* serverControl("start");
        expect(yield* filled(app.id)).toEqual({ account, token: "synthetic-legacy-token" });

        // So a new app that words it differently again finds the stored ID and its account.
        const otherApp = yield* deploy({ label: "Other wording" });
        expect(otherApp.requirements.accounts.service.provider).toBe(legacy);
        yield* link(otherApp.id, account);
        expect(yield* filled(otherApp.id)).toEqual({ account, token: "synthetic-legacy-token" });

        // Rewording keeps the ID the app's account was saved under; nobody reconnects.
        const reworded = yield* redeploy(app.id, { label: "New wording" });
        expect(reworded.requirements.accounts.service.provider).toBe(legacy);
        expect(yield* filled(app.id)).toEqual({ account, token: "synthetic-legacy-token" });
        yield* browser.login(actors.owner);
        expect(yield* formShows(app.id, "New wording")).not.toContain("Old wording");

        // A new app with the app's current wording gets the same ID and account, though no ID was
        // ever hashed from that wording.
        const currentApp = yield* deploy({ label: "New wording" });
        expect(currentApp.requirements.accounts.service.provider).toBe(legacy);
        yield* link(currentApp.id, account);
        expect(yield* filled(currentApp.id)).toEqual({ account, token: "synthetic-legacy-token" });

        // So does one with the stored definition's exact wording.
        const copy = yield* deploy({ label: "Old wording" });
        expect(copy.requirements.accounts.service.provider).toBe(legacy);
        yield* link(copy.id, account);
        expect(yield* filled(copy.id)).toEqual({ account, token: "synthetic-legacy-token" });
      }),
    ),
  );
  it.effect(scenarios.providerLabelIdentityUnrecorded.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { deploy, redeploy, connect, link, filled } = yield* organizationApps;
        const app = yield* deploy({ label: "Old wording" });
        const current = app.requirements.accounts.service.provider;
        const account = yield* connect(app.id, "synthetic-unrecorded-token");
        const definition = app.requirements.accounts.service.definition;

        // Two providers stored as an earlier version did, one per wording, with no identity: the
        // upgrade's data step already ran over none, as before Cloud applies it or after a
        // rollback. The account and the app's version name the first.
        const legacy = labelledId(definition);
        const auth = definition.auth as Record<string, Record<string, Schema.Json>>;
        const older = labelledId({
          ...definition,
          auth: { ...auth, key: { ...auth.key, label: "Older wording" } },
        });
        yield* legacyStorage([
          {
            sql: `INSERT INTO executor_providers (id, definition)
              SELECT $1, definition FROM executor_providers WHERE id = $2`,
            params: [legacy, current],
          },
          {
            sql: `INSERT INTO executor_providers (id, definition)
              SELECT $1, jsonb_set(definition::jsonb, '{auth,key,label}', '"Older wording"')::json
              FROM executor_providers WHERE id = $2`,
            params: [older, current],
          },
          {
            sql: "UPDATE executor_accounts SET provider = $1 WHERE id = $2",
            params: [legacy, account],
          },
          {
            sql: "UPDATE executor_account_connections SET provider = $1 WHERE provider = $2",
            params: [legacy, current],
          },
          {
            sql: `UPDATE executor_deployments SET requirements = replace(requirements::text, $2, $1)::json
              WHERE code = (SELECT code FROM executor_apps WHERE id = $3)`,
            params: [legacy, current, app.id],
          },
          { sql: "DELETE FROM executor_providers WHERE id = $1", params: [current] },
        ]);
        yield* serverControl("start");
        expect(yield* filled(app.id)).toEqual({ account, token: "synthetic-unrecorded-token" });

        // A new wording records both rows' identity and takes the least stored ID, never a new one,
        // and every later new wording takes the same.
        const least = [legacy, older].toSorted()[0];
        const first = yield* deploy({ label: "New wording" });
        expect(first.requirements.accounts.service.provider).toBe(least);
        const second = yield* deploy({ label: "Newest wording" });
        expect(second.requirements.accounts.service.provider).toBe(least);

        // A stored row's exact wording keeps that row, as before labels left IDs.
        const exact = yield* deploy({ label: "Old wording" });
        expect(exact.requirements.accounts.service.provider).toBe(legacy);
        yield* link(exact.id, account);
        expect(yield* filled(exact.id)).toEqual({ account, token: "synthetic-unrecorded-token" });
        expect(
          (yield* deploy({ label: "Older wording" })).requirements.accounts.service.provider,
        ).toBe(older);

        // The app keeps its own ID through a reword.
        const reworded = yield* redeploy(app.id, { label: "Other wording" });
        expect(reworded.requirements.accounts.service.provider).toBe(legacy);
        expect(yield* filled(app.id)).toEqual({ account, token: "synthetic-unrecorded-token" });
      }),
    ),
  );
});
