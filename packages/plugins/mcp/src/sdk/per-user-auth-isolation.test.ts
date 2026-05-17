import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Predicate } from "effect";

import {
  ConnectionId,
  CreateConnectionInput,
  OAUTH2_PROVIDER_KEY,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  TokenMaterial,
  createExecutor,
  type ToolInvocationError,
} from "@executor-js/sdk";
import { makeTestConfig, memorySecretsPlugin } from "@executor-js/sdk/testing";

import { mcpPlugin } from "./plugin";
import { makeEchoMcpServer, serveMcpServer } from "../testing";

const USER_A = ScopeId.make("user-a");
const USER_B = ScopeId.make("user-b");
const ORG = ScopeId.make("org");

const scope = (id: ScopeId, name: string): Scope => Scope.make({ id, name, createdAt: new Date() });

const failureError = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const isToolInvocationError = (error: unknown): error is ToolInvocationError =>
  Predicate.isTagged(error, "ToolInvocationError");

const createAuthRecordingMcpServer = () =>
  makeEchoMcpServer({
    name: "iso-test",
    toolName: "whoami",
    toolDescription: "Echoes a marker so the test can prove the invoke reached the server",
    inputName: "marker",
    text: (marker) => `ok:${marker}`,
  });

const serveAuthRecordingMcpServer = serveMcpServer(createAuthRecordingMcpServer);

const makeLayeredMcpExecutors = () =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const plugins = [mcpPlugin(), memorySecretsPlugin()] as const;
      const config = makeTestConfig({ plugins });
      const orgScope = scope(ORG, "org");
      const userAScope = scope(USER_A, "user-a");
      const userBScope = scope(USER_B, "user-b");

      const execUserA = yield* createExecutor({
        ...config,
        scopes: [userAScope, orgScope],
      });
      const execUserB = yield* createExecutor({
        ...config,
        scopes: [userBScope, orgScope],
      });

      return { execUserA, execUserB, testDb: config.testDb };
    }),
    ({ execUserA, execUserB, testDb }) =>
      Effect.all([execUserA.close(), execUserB.close(), Effect.promise(() => testDb.close())], {
        discard: true,
      }).pipe(Effect.ignore),
  );

describe("per-user MCP auth isolation", () => {
  it.effect(
    "oauth2 source: unauthenticated user B cannot invoke and never sees user A's token",
    () =>
      Effect.gen(function* () {
        const server = yield* serveAuthRecordingMcpServer;
        const { execUserA, execUserB } = yield* makeLayeredMcpExecutors();
        const sharedConnId = "mcp-oauth2-iso-test";

        yield* execUserA.connections.create(
          CreateConnectionInput.make({
            id: ConnectionId.make(sharedConnId),
            scope: USER_A,
            provider: OAUTH2_PROVIDER_KEY,
            identityLabel: "userA",
            accessToken: TokenMaterial.make({
              secretId: SecretId.make(`${sharedConnId}.access_token`),
              name: "MCP OAuth Access Token",
              value: "token-user-a",
            }),
            refreshToken: null,
            expiresAt: null,
            oauthScope: null,
            providerState: null,
          }),
        );

        yield* execUserA.mcp.addSource({
          transport: "remote",
          scope: ORG,
          credentialTargetScope: USER_A,
          name: "Shared MCP",
          endpoint: server.url,
          namespace: "iso_test",
          auth: { kind: "oauth2", connectionId: sharedConnId },
        });

        const userATools = yield* execUserA.tools.list();
        const whoamiForA = userATools.find((tool) => tool.name === "whoami");
        expect(whoamiForA).toBeDefined();

        const recordedBeforeUserA = (yield* server.requests).length;
        const userAResult = yield* execUserA.tools.invoke(
          whoamiForA!.id,
          { marker: "from-user-a" },
          { onElicitation: "accept-all" },
        );
        expect(userAResult).toMatchObject({
          ok: true,
          data: { content: [{ type: "text", text: "ok:from-user-a" }] },
        });
        expect(
          (yield* server.requests)
            .slice(recordedBeforeUserA)
            .some((request) => request.authorization === "Bearer token-user-a"),
        ).toBe(true);

        const recordedBeforeUserB = (yield* server.requests).length;
        const userBTools = yield* execUserB.tools.list();
        const whoamiForB = userBTools.find((tool) => tool.name === "whoami");
        expect(whoamiForB).toBeDefined();

        const userBResult = yield* Effect.exit(
          execUserB.tools.invoke(
            whoamiForB!.id,
            { marker: "from-user-b" },
            { onElicitation: "accept-all" },
          ),
        );

        expect(Exit.isFailure(userBResult)).toBe(true);
        const outer = failureError(userBResult);
        expect(isToolInvocationError(outer)).toBe(true);
        const inner = isToolInvocationError(outer) ? outer.cause : undefined;
        expect(Predicate.isTagged(inner, "McpConnectionError")).toBe(true);

        for (const request of (yield* server.requests).slice(recordedBeforeUserB)) {
          expect(request.authorization).not.toBe("Bearer token-user-a");
        }
      }),
  );

  it.effect("header source: unauthenticated user B cannot invoke via a per-user secret", () =>
    Effect.gen(function* () {
      const server = yield* serveAuthRecordingMcpServer;
      const { execUserA, execUserB } = yield* makeLayeredMcpExecutors();
      const secret = SecretId.make("shared-mcp-token");

      yield* execUserA.secrets.set(
        SetSecretInput.make({
          id: secret,
          scope: USER_A,
          name: "User A MCP token",
          value: "token-user-a-header",
        }),
      );

      yield* execUserA.mcp.addSource({
        transport: "remote",
        scope: ORG,
        credentialTargetScope: USER_A,
        name: "Shared MCP (header)",
        endpoint: server.url,
        namespace: "iso_header",
        auth: {
          kind: "header",
          headerName: "Authorization",
          secretId: secret,
          prefix: "Bearer ",
        },
      });

      const userATools = yield* execUserA.tools.list();
      const whoamiForA = userATools.find((tool) => tool.name === "whoami")!;
      const recordedBeforeUserA = (yield* server.requests).length;
      const userAResult = yield* execUserA.tools.invoke(
        whoamiForA.id,
        { marker: "user-a-header" },
        { onElicitation: "accept-all" },
      );
      expect(userAResult).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "ok:user-a-header" }] },
      });
      expect(
        (yield* server.requests)
          .slice(recordedBeforeUserA)
          .some((request) => request.authorization === "Bearer token-user-a-header"),
      ).toBe(true);

      const recordedBeforeUserB = (yield* server.requests).length;
      const userBTools = yield* execUserB.tools.list();
      const whoamiForB = userBTools.find((tool) => tool.name === "whoami")!;
      const userBResult = yield* Effect.exit(
        execUserB.tools.invoke(
          whoamiForB.id,
          { marker: "user-b-header" },
          { onElicitation: "accept-all" },
        ),
      );

      expect(Exit.isFailure(userBResult)).toBe(true);
      const outer = failureError(userBResult);
      expect(isToolInvocationError(outer)).toBe(true);
      const inner = isToolInvocationError(outer) ? outer.cause : undefined;
      expect(Predicate.isTagged(inner, "McpConnectionError")).toBe(true);

      for (const request of (yield* server.requests).slice(recordedBeforeUserB)) {
        expect(request.authorization).not.toBe("Bearer token-user-a-header");
      }
    }),
  );

  it.effect("org header binding resolves the org secret when a user has the same secret id", () =>
    Effect.gen(function* () {
      const server = yield* serveAuthRecordingMcpServer;
      const { execUserA } = yield* makeLayeredMcpExecutors();
      const secretId = SecretId.make("shared-mcp-token");

      yield* execUserA.secrets.set(
        SetSecretInput.make({
          id: secretId,
          scope: ORG,
          name: "Org MCP token",
          value: "token-org-header",
        }),
      );

      yield* execUserA.mcp.addSource({
        transport: "remote",
        scope: ORG,
        credentialTargetScope: ORG,
        name: "Shared MCP org header",
        endpoint: server.url,
        namespace: "org_header",
        auth: {
          kind: "header",
          headerName: "Authorization",
          secretId,
          prefix: "Bearer ",
        },
      });

      yield* execUserA.secrets.set(
        SetSecretInput.make({
          id: secretId,
          scope: USER_A,
          name: "User colliding MCP token",
          value: "token-user-header",
        }),
      );

      const tools = yield* execUserA.tools.list();
      const whoami = tools.find((tool) => tool.name === "whoami")!;
      const beforeInvoke = (yield* server.requests).length;
      const result = yield* execUserA.tools.invoke(
        whoami.id,
        { marker: "org-header" },
        { onElicitation: "accept-all" },
      );

      expect(result).toMatchObject({
        ok: true,
        data: { content: [{ type: "text", text: "ok:org-header" }] },
      });
      const invokeRequests = (yield* server.requests).slice(beforeInvoke);
      expect(
        invokeRequests.some((request) => request.authorization === "Bearer token-org-header"),
      ).toBe(true);
      expect(
        invokeRequests.some((request) => request.authorization === "Bearer token-user-header"),
      ).toBe(false);
    }),
  );
});
