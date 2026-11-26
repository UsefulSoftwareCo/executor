import { expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
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
import { reveal } from "./failure-text.ts";

export const localAgent = Effect.gen(function* () {
  const api = yield* Api,
    target = yield* Target,
    session = yield* api.session();
  const headers = { authorization: `Bearer ${reveal(target.apiKey)}` };
  const agent: Session = {
    ...session,
    send: (method, path, data, extra = {}) => {
      const { origin: _origin, ...rest } = extra;
      return session.send(method, path, data, { ...rest, ...headers });
    },
  };
  return { api, target, session, agent, headers };
});

export const localAppPath = (app: string) => `/dashboard/api/apps/${encodeURIComponent(app)}`;

export const linkLocal = (
  agent: Session,
  app: string,
  requirement: string,
  account: string,
  scope: LinkScope = "user",
) => linkAccount(agent, localAppPath(app), requirement, account, scope);

export const unlinkLocal = (
  agent: Session,
  app: string,
  requirement: string,
  account: string,
  scope: LinkScope = "user",
) => unlinkAccount(agent, localAppPath(app), requirement, account, scope);

export const localLinks = (agent: Session, app: string, scope: LinkScope = "user") =>
  linkedAccountIds(agent, localAppPath(app), scope);

export const localAccountLinks = (agent: Session, app: string, scope: LinkScope = "user") =>
  accountLinks(agent, localAppPath(app), scope);

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
