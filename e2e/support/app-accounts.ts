/** App account links through the hosted API, or the local dashboard API given a local app path. */
import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "./api.ts";
import { appsManifest } from "./apps-release.ts";

/** Whose accounts a link fills: the app's own requirements (`app`) or the caller's (`user`). */
export type LinkScope = "app" | "user";

/** One link, as an app's `/accounts/app` and `/accounts/user` lists return it. */
export const AccountLink = Schema.Struct({
  requirement: Schema.String,
  account: Schema.Struct({ id: Schema.String, provider: Schema.String, label: Schema.String }),
});

/** The path of one requirement's links of the app at `appPath`. */
export const requirementPath = (appPath: string, scope: LinkScope, requirement: string) =>
  `${appPath}/accounts/${scope}/${encodeURIComponent(requirement)}`;

/**
 * Where a connection for one requirement of the app at `appPath` starts; completing it links the
 * new account to that requirement in that scope. Hosted only: POST `{ destination?, account? }`.
 */
export const connectionsPath = (appPath: string, scope: LinkScope, requirement: string) =>
  `${requirementPath(appPath, scope, requirement)}/connections`;

/** Link an account to a requirement of the app at `appPath` without requiring success. */
export const linkAccountResponse = (
  actor: Session,
  appPath: string,
  requirement: string,
  account: string,
  scope: LinkScope = "user",
) =>
  Effect.flatMap(Api, (api) =>
    api.request(
      actor,
      "PUT",
      `${requirementPath(appPath, scope, requirement)}/${encodeURIComponent(account)}`,
    ),
  );

/**
 * Link one of the actor's accounts to a requirement of the app at `appPath` and require success.
 * A plain requirement's earlier link in the same scope is replaced; many() adds one.
 */
export const linkAccount = (
  actor: Session,
  appPath: string,
  requirement: string,
  account: string,
  scope: LinkScope = "user",
) =>
  Effect.gen(function* () {
    const response = yield* linkAccountResponse(actor, appPath, requirement, account, scope);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

/** Unlink an account from a requirement of the app at `appPath` without requiring success. */
export const unlinkAccountResponse = (
  actor: Session,
  appPath: string,
  requirement: string,
  account: string,
  scope: LinkScope = "user",
) =>
  Effect.flatMap(Api, (api) =>
    api.request(
      actor,
      "DELETE",
      `${requirementPath(appPath, scope, requirement)}/${encodeURIComponent(account)}`,
    ),
  );

/** Unlink an account from a requirement of the app at `appPath`; the account itself stays. */
export const unlinkAccount = (
  actor: Session,
  appPath: string,
  requirement: string,
  account: string,
  scope: LinkScope = "user",
) =>
  Effect.gen(function* () {
    const response = yield* unlinkAccountResponse(actor, appPath, requirement, account, scope);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

/** The app's links in one scope as `[requirement, account]` pairs, in the order listed. */
export const accountLinks = (actor: Session, appPath: string, scope: LinkScope = "user") =>
  Effect.gen(function* () {
    const api = yield* Api;
    const response = yield* api.request(actor, "GET", `${appPath}/accounts/${scope}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (yield* body(Schema.Array(AccountLink), response)).map(
      (link) => [link.requirement, link.account.id] as const,
    );
  });

/**
 * The account IDs linked to the app at `appPath` in one scope, each once, in the order listed:
 * by requirement, then oldest link first.
 */
export const linkedAccountIds = (actor: Session, appPath: string, scope: LinkScope = "user") =>
  Effect.map(accountLinks(actor, appPath, scope), (links) => [
    ...new Set(links.map(([, account]) => account)),
  ]);

/** A saved account, as the connection that saved it returns. */
export const ConnectedAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
});
const ConnectionLink = Schema.Struct({ connection: Schema.String, url: Schema.String });

/**
 * Save a secrets-method account the only way the product allows: through a local connection
 * request for an app's requirement. Connecting from the app links the account to it, replacing
 * the earlier link when only plain requirements use the provider. With `account`, the request
 * replaces that account's credentials instead. The agent issues the link with its bearer key; the form's submission
 * carries only the link's grant.
 */
export const connectLocalAccount = (
  actor: Session,
  input: {
    readonly app: string;
    readonly requirement: string;
    readonly method: string;
    readonly fields: Record<string, unknown>;
    readonly label?: string;
    readonly account?: string;
  },
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    // Local saves the account under `local`; the request names no owner.
    const issued = yield* api.request(
      actor,
      "POST",
      "/account-connect/api/requests",
      {
        target: { app: input.app, requirement: input.requirement },
        ...(input.account === undefined ? {} : { account: input.account }),
      },
      headers,
    );
    if (issued.status !== 200)
      return yield* Effect.die(`Connection request failed: ${JSON.stringify(issued.body)}`);
    const link = yield* body(ConnectionLink, issued);
    const submitted = yield* api.request(
      actor,
      "POST",
      "/account-connect/api/submit",
      {
        connection: link.connection,
        token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
        method: input.method,
        ...(input.label === undefined ? {} : { label: input.label }),
        fields: input.fields,
      },
      headers,
    );
    if (submitted.status !== 200)
      return yield* Effect.die(`Connection submission failed: ${JSON.stringify(submitted.body)}`);
    return yield* body(ConnectedAccount, submitted);
  });

/**
 * Save accounts before the scenario's own app exists. Accounts are connected only for an app, so
 * they are connected for a throwaway app that requires the same provider definition, which
 * resolves to the same provider, and that app is removed again. The accounts stay saved and are
 * linked to no app: the scenario links them to its own app before that app uses them.
 */
export const connectAccountsThroughOtherApp = (
  actor: Session,
  input: {
    /** Source of the scenario app's `defineProvider(...)` call, imported names included. */
    readonly provider: string;
    readonly method: string;
    readonly accounts: ReadonlyArray<{
      readonly label: string;
      readonly fields: Record<string, unknown>;
    }>;
  },
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const owner = "local";
    const deployed = yield* api.request(
      actor,
      "POST",
      "/v1/apps/deploy",
      {
        owner,
        name: `Account fixture ${randomUUID().slice(0, 8)}`,
        files: [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = ${input.provider};
export default defineApp({ user: { accounts: { service: service.many() } } }, async () => ({ tools: router({}) }));`,
          },
          appsManifest,
        ],
      },
      headers,
    );
    if (deployed.status !== 200)
      return yield* Effect.die(`Fixture app deploy failed: ${JSON.stringify(deployed.body)}`);
    const { app } = yield* body(
      Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
      deployed,
    );
    const accounts = yield* Effect.forEach(input.accounts, (account) =>
      connectLocalAccount(
        actor,
        {
          app: app.id,
          requirement: "service",
          method: input.method,
          label: account.label,
          fields: account.fields,
        },
        headers,
      ),
    );
    const removed = yield* api.request(actor, "DELETE", `/v1/apps/${app.id}`, undefined, headers);
    if (removed.status !== 200)
      return yield* Effect.die(`Fixture app removal failed: ${JSON.stringify(removed.body)}`);
    return accounts;
  });
