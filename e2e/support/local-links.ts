/**
 * Local's agent API and its app account links. Local keeps a real link for each account an app
 * uses: connecting an account from the app links it, and an account saved elsewhere is linked
 * through the dashboard's link route before the app uses it.
 */
import { expect } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { Api, body, type Session } from "./api.ts";
import {
  accountLinks,
  linkAccount,
  linkedAccountIds,
  unlinkAccount,
  type LinkScope,
} from "./app-accounts.ts";
import { Browser } from "./browser.ts";
import { Target } from "./platform.ts";

/** The local agent: the API key and no browser origin, as an agent's own calls carry. */
export const localAgent = Effect.gen(function* () {
  const api = yield* Api,
    target = yield* Target,
    session = yield* api.session();
  const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
  const agent: Session = {
    ...session,
    send: (method, path, data, extra = {}) => {
      const { origin: _origin, ...rest } = extra;
      return session.send(method, path, data, { ...rest, ...headers });
    },
  };
  return { api, target, session, agent, headers };
});

/** The dashboard path of a local app, under which its links live. */
export const localAppPath = (app: string) => `/dashboard/api/apps/${encodeURIComponent(app)}`;

/** Link a saved account to a local app's requirement. A plain requirement's earlier link is replaced. */
export const linkLocal = (
  agent: Session,
  app: string,
  requirement: string,
  account: string,
  scope: LinkScope = "user",
) => linkAccount(agent, localAppPath(app), requirement, account, scope);

/** Unlink an account from a local app's requirement; the account stays saved. */
export const unlinkLocal = (
  agent: Session,
  app: string,
  requirement: string,
  account: string,
  scope: LinkScope = "user",
) => unlinkAccount(agent, localAppPath(app), requirement, account, scope);

/** The account IDs linked to a local app in one scope, each once. */
export const localLinks = (agent: Session, app: string, scope: LinkScope = "user") =>
  linkedAccountIds(agent, localAppPath(app), scope);

/** A local app's links in one scope as `[requirement, account]` pairs, in the order listed. */
export const localAccountLinks = (agent: Session, app: string, scope: LinkScope = "user") =>
  accountLinks(agent, localAppPath(app), scope);

/** Pair the case's browser with the local dashboard and wait for the apps page. */
export const pairLocalBrowser = (agent: Session) =>
  Effect.gen(function* () {
    const browser = yield* Browser,
      api = yield* Api;
    const { url } = yield* body(
      Schema.Struct({ url: Schema.String }),
      yield* api.request(agent, "POST", "/auth/pair"),
    );
    yield* browser.use("Pair the local dashboard", (page) => page.goto(url));
    yield* browser.use("Pairing finished", (page) =>
      page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
    );
  });

const Completed = Schema.Struct({ status: Schema.Literal("completed"), value: Schema.Json });

/** Call a local app's query through the SDK route with the app's linked accounts. */
export const callLocalQuery = (agent: Session, app: string, tool: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const called = yield* api.request(agent, "POST", "/v1/tools/call", {
      app,
      tool,
      kind: "query",
      input: {},
    });
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    return (yield* body(Completed, called)).value;
  });
