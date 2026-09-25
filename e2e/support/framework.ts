/** Real OAuth and MCP setup shared by the two framework authoring journeys. */
import { Effect, Redacted, Schema } from "effect";
import { Actors } from "./actors.ts";
import { Browser } from "./browser.ts";
import { managementApp } from "./management-app.ts";
import { McpOAuth } from "./mcp-oauth.ts";
import { McpClient } from "./mcp-client.ts";

const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
});
/** Open a scoped client with the actor's real management profile and live tool execution. */
export const frameworkSession = Effect.gen(function* () {
  const actors = yield* Actors,
    browser = yield* Browser;
  const oauth = yield* McpOAuth,
    mcp = yield* McpClient;
  yield* browser.login(actors.owner);
  const { profile } = yield* managementApp(actors.owner);
  const grant = yield* oauth.authorize;
  yield* Effect.addFinalizer(() => oauth.revoke(grant).pipe(Effect.orDie));
  const client = yield* mcp.connect(
    Redacted.make(Redacted.value(grant.tokens).access_token),
    "framework-authoring",
  );
  const execute = (code: string) =>
    Effect.gen(function* () {
      const result = yield* client.use(
        "Read app and framework contracts through MCP",
        (client, signal) =>
          client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
      );
      return (yield* Schema.decodeUnknownEffect(Completed)(result.structuredContent)).execution
        .value;
    });
  const queries = `tools.executor.profiles[${JSON.stringify(profile.id)}].queries`;
  return { client, execute, queries, profile };
});
