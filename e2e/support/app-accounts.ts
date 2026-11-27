import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "./api.ts";
import { appsManifest } from "./apps-release.ts";

export type LinkScope = "app" | "user";

export const AccountLink = Schema.Struct({
  requirement: Schema.String,
  account: Schema.Struct({ id: Schema.String, provider: Schema.String, label: Schema.String }),
});

export const requirementPath = (appPath: string, scope: LinkScope, requirement: string) =>
  `${appPath}/accounts/${scope}/${encodeURIComponent(requirement)}`;

export const connectionsPath = (appPath: string, scope: LinkScope, requirement: string) =>
  `${requirementPath(appPath, scope, requirement)}/connections`;

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

export const accountLinks = (actor: Session, appPath: string, scope: LinkScope = "user") =>
  Effect.gen(function* () {
    const api = yield* Api;
    const response = yield* api.request(actor, "GET", `${appPath}/accounts/${scope}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (yield* body(Schema.Array(AccountLink), response)).map(
      (link) => [link.requirement, link.account.id] as const,
    );
  });

export const linkedAccountIds = (actor: Session, appPath: string, scope: LinkScope = "user") =>
  Effect.map(accountLinks(actor, appPath, scope), (links) => [
    ...new Set(links.map(([, account]) => account)),
  ]);

export const ConnectedAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
});
const ConnectionLink = Schema.Struct({ connection: Schema.String, url: Schema.String });

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

export const connectAccountsThroughOtherApp = (
  actor: Session,
  input: {
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
