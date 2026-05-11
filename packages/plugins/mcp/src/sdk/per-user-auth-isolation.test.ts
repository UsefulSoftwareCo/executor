// ---------------------------------------------------------------------------
// Per-user MCP auth isolation — covers the scenario where a remote MCP
// source has its auth pinned to an SDK Connection (`auth.kind = "oauth2"`
// or `auth.kind = "header"` with a per-user secret) and two users share
// a catalog-level source row:
//
//   - user A has signed in (connection row / secret at userA scope)
//   - user B has NOT signed in (no row in userB scope, only the shared
//     org-scope source visible via fall-through)
//
// Invariant: user B's `executor.tools.invoke` must never succeed and must
// never present user A's credentials to the upstream MCP server.
//
// We mount a real MCP HTTP server that asserts the `Authorization`
// header on every request, so "leaked a token" = "server saw user A's
// token on user B's request" = test assertion on the recorded header.
// ---------------------------------------------------------------------------

import * as http from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Predicate } from "effect";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  ConnectionId,
  CreateConnectionInput,
  OAUTH2_PROVIDER_KEY,
  Scope,
  ScopeId,
  SecretId,
  SetSecretInput,
  TokenMaterial,
  collectSchemas,
  createExecutor,
  definePlugin,
  makeInMemoryBlobStore,
  type SecretProvider,
  type ToolInvocationError,
} from "@executor-js/sdk";
import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

import { mcpPlugin } from "./plugin";

// ---------------------------------------------------------------------------
// Minimal test plugin contributing a scope-aware memory secret provider.
// `mcpPlugin` itself doesn't register a secret provider — it piggy-backs
// on whatever providers the host wires in (keychain, workos-vault, file-
// secrets, …). For an SDK-level test we mount a tiny scope-keyed Map
// provider so `secrets.set` / `secrets.get` resolve through the adapter's
// routing-table rows.
// ---------------------------------------------------------------------------

const scopedMemoryProvider = (): SecretProvider => {
  const store = new Map<string, string>();
  const key = (scope: string, id: string) => `${scope}\u0000${id}`;
  return {
    key: "scoped-memory",
    writable: true,
    get: (id, scope) => Effect.sync(() => store.get(key(scope, id)) ?? null),
    set: (id, value, scope) =>
      Effect.sync(() => {
        store.set(key(scope, id), value);
      }),
    delete: (id, scope) => Effect.sync(() => store.delete(key(scope, id))),
    list: () =>
      Effect.sync(() =>
        Array.from(store.keys()).map((k) => {
          const name = k.split("\u0000", 2)[1] ?? k;
          return { id: name, name };
        }),
      ),
  };
};

const secretsPlugin = definePlugin(() => ({
  id: "test-secrets" as const,
  storage: () => ({}),
  secretProviders: () => [scopedMemoryProvider()],
  extension: () => ({}),
}));

// ---------------------------------------------------------------------------
// Test MCP server — accepts every session but records the Authorization
// header it received. The test can then assert whose token showed up at
// the wire.
// ---------------------------------------------------------------------------

type RecordedRequest = {
  readonly authorization: string | undefined;
};

type TestServer = {
  readonly url: string;
  readonly httpServer: http.Server;
  readonly recorded: () => readonly RecordedRequest[];
};

const failureError = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const isToolInvocationError = (error: unknown): error is ToolInvocationError =>
  Predicate.isTagged(error, "ToolInvocationError");

const createAuthRecordingServer: Effect.Effect<TestServer, Error, never> = Effect.callback<
  TestServer,
  Error
>((resume) => {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const recorded: RecordedRequest[] = [];

  const httpServer = http.createServer(async (req, res) => {
    recorded.push({
      authorization: req.headers["authorization"] as string | undefined,
    });

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404);
        res.end("Session not found");
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    const mcpServer = new McpServer({ name: "iso-test", version: "1.0.0" }, { capabilities: {} });
    mcpServer.registerTool(
      "whoami",
      {
        description: "Echoes a marker — used to prove the invoke reached the server",
        inputSchema: { marker: z.string() },
      },
      async ({ marker }: { marker: string }) => ({
        content: [{ type: "text" as const, text: `ok:${marker}` }],
      }),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });

  httpServer.listen(0, () => {
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    resume(
      Effect.succeed({
        url: `http://127.0.0.1:${port}`,
        httpServer,
        recorded: () => recorded,
      }),
    );
  });
});

const serveMcpServer = Effect.acquireRelease(createAuthRecordingServer, ({ httpServer }) =>
  Effect.sync(() => {
    httpServer.close();
  }),
);

// ---------------------------------------------------------------------------
// Shared-adapter harness — two executors, different scope stacks, pointing
// at the same in-memory DB + blob store. Matches the real multi-tenant
// topology: one connection pool, per-request ScopeStack.
// ---------------------------------------------------------------------------

const USER_A = ScopeId.make("user-a");
const USER_B = ScopeId.make("user-b");
const ORG = ScopeId.make("org");

const scope = (id: ScopeId, name: string): Scope => new Scope({ id, name, createdAt: new Date() });

const makeLayeredMcpExecutors = () =>
  Effect.gen(function* () {
    const plugins = [mcpPlugin(), secretsPlugin()] as const;
    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();

    const orgScope = scope(ORG, "org");
    const userAScope = scope(USER_A, "user-a");
    const userBScope = scope(USER_B, "user-b");

    // User-A executor — scope stack = [userA, org]. Innermost per-user
    // + shared org tier, exactly what the cloud surface builds per
    // authenticated request. User A is the one who installs the shared
    // source at org scope (after their own OAuth), so discovery runs
    // with user A's credentials.
    const execUserA = yield* createExecutor({
      scopes: [userAScope, orgScope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });

    // User-B executor — scope stack = [userB, org]. User B has never
    // completed sign-in for the shared source.
    const execUserB = yield* createExecutor({
      scopes: [userBScope, orgScope],
      adapter,
      blobs,
      plugins,
      onElicitation: "accept-all",
    });

    return { execUserA, execUserB };
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("per-user MCP auth isolation", () => {
  // oauth2 auth pattern — source points at a per-user Connection row.
  // User A creates their connection; user B has none. User B's invoke
  // must fail and the upstream MCP server must never see user A's token.
  it.effect(
    "oauth2 source: unauthenticated user B cannot invoke and never sees user A's token",
    () =>
      Effect.gen(function* () {
        const server = yield* serveMcpServer;
        const { execUserA, execUserB } = yield* makeLayeredMcpExecutors();

        // User A completes OAuth FIRST — we model it by writing the
        // connection row at userA scope directly via the SDK surface.
        // `expiresAt: null` means "never refresh" so `accessToken(id)`
        // returns the stored value directly; no MCP AS network calls.
        const sharedConnId = "mcp-oauth2-iso-test";
        yield* execUserA.connections.create(
          new CreateConnectionInput({
            id: ConnectionId.make(sharedConnId),
            scope: USER_A,
            provider: OAUTH2_PROVIDER_KEY,
            identityLabel: "userA",
            accessToken: new TokenMaterial({
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

        // User A installs the shared source at org scope. Discovery
        // uses user A's token (resolved via their innermost connection
        // row); the source lands at org scope while the credential
        // binding lands at user A's scope. User B's stack [userB, org]
        // can see the source but not user A's binding.
        yield* execUserA.mcp.addSource({
          transport: "remote",
          scope: ORG,
          credentialTargetScope: USER_A,
          name: "Shared MCP",
          endpoint: server.url,
          namespace: "iso_test",
          auth: { kind: "oauth2", connectionId: sharedConnId },
        });

        // Sanity: user A can invoke and the server sees user A's token
        // on the wire. Without this the negative assertion below could
        // false-pass simply because the oauth2 auth path was never
        // actually exercised.
        const userATools = yield* execUserA.tools.list();
        const whoamiForA = userATools.find((t) => t.name === "whoami");
        expect(whoamiForA).toBeDefined();

        const recordedBeforeUserA = server.recorded().length;
        const userAResult = yield* execUserA.tools.invoke(
          whoamiForA!.id,
          { marker: "from-user-a" },
          { onElicitation: "accept-all" },
        );
        expect(userAResult).toMatchObject({
          content: [{ type: "text", text: "ok:from-user-a" }],
        });
        const userARequests = server.recorded().slice(recordedBeforeUserA);
        expect(userARequests.some((r) => r.authorization === "Bearer token-user-a")).toBe(true);

        // Snapshot the recorded-auth slice we'll check for the user-B
        // run — "token-user-a" must not appear in any request AFTER
        // this point.
        const recordedBeforeUserB = server.recorded().length;

        // User B has no connection row at their scope. `tools.invoke`
        // must fail before hitting the server. We run it through
        // `Effect.either` so the assertion is on the Left payload, not
        // a thrown test failure.
        const userBTools = yield* execUserB.tools.list();
        const whoamiForB = userBTools.find((t) => t.name === "whoami");
        expect(whoamiForB).toBeDefined();

        const userBResult = yield* Effect.exit(
          execUserB.tools.invoke(
            whoamiForB!.id,
            { marker: "from-user-b" },
            { onElicitation: "accept-all" },
          ),
        );

        expect(Exit.isFailure(userBResult)).toBe(true);
        // Pin the exact error tag so a future regression that swaps
        // the "connection not found" check for a silent `auth: { kind:
        // "none" }` fallback would fail here, not silently connect.
        // tools.invoke wraps plugin failures in ToolInvocationError
        // with the original error carried on `cause`. Pin the exact
        // inner tag — a regression that swapped the "no connection
        // found" check for a silent no-auth fallback would either
        // succeed outright (leaking) or surface a different tag here.
        const outer = failureError(userBResult);
        expect(isToolInvocationError(outer)).toBe(true);
        const inner = isToolInvocationError(outer) ? outer.cause : undefined;
        expect(Predicate.isTagged(inner, "McpConnectionError")).toBe(true);

        // CRITICAL: no outbound MCP request was made on user B's behalf
        // carrying user A's bearer token. Auth resolution must have
        // failed before the transport opened.
        const afterUserB = server.recorded().slice(recordedBeforeUserB);
        for (const req of afterUserB) {
          expect(req.authorization).not.toBe("Bearer token-user-a");
        }
      }),
  );

  // header auth pattern — source points at a per-user secret id. User A
  // has the secret at their scope; user B does not. User B's invoke
  // must fail rather than silently fall through to any other scope's
  // value. This also locks the contract that the MCP plugin doesn't
  // quietly downgrade a missing secret to "no auth" on the transport.
  it.effect("header source: unauthenticated user B cannot invoke via a per-user secret", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer;
      const { execUserA, execUserB } = yield* makeLayeredMcpExecutors();

      const SECRET = SecretId.make("shared-mcp-token");

      // User A plants their personal token at their per-user scope
      // FIRST — so the subsequent addSource's discovery call can
      // resolve it through user A's stack.
      yield* execUserA.secrets.set(
        new SetSecretInput({
          id: SECRET,
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
          secretId: SECRET,
          prefix: "Bearer ",
        },
      });

      // User A sanity invoke — server sees A's token. Asserting on
      // the recorded header here guards against false-positive for
      // the negative check below (e.g. if the plugin silently dropped
      // auth, both invocations would fail for unrelated reasons).
      const userATools = yield* execUserA.tools.list();
      const whoamiForA = userATools.find((t) => t.name === "whoami")!;

      const recordedBeforeUserA = server.recorded().length;
      const userAResult = yield* execUserA.tools.invoke(
        whoamiForA.id,
        { marker: "user-a-header" },
        { onElicitation: "accept-all" },
      );
      expect(userAResult).toMatchObject({
        content: [{ type: "text", text: "ok:user-a-header" }],
      });
      const userARequests = server.recorded().slice(recordedBeforeUserA);
      expect(userARequests.some((r) => r.authorization === "Bearer token-user-a-header")).toBe(
        true,
      );

      const recordedBeforeUserB = server.recorded().length;

      // User B has no personal token. The fall-through lookup walks
      // [userB, org] — neither scope has the secret row, so the
      // resolver must return null and the invoke must fail.
      const userBTools = yield* execUserB.tools.list();
      const whoamiForB = userBTools.find((t) => t.name === "whoami")!;

      const userBResult = yield* Effect.exit(
        execUserB.tools.invoke(
          whoamiForB.id,
          { marker: "user-b-header" },
          { onElicitation: "accept-all" },
        ),
      );

      expect(Exit.isFailure(userBResult)).toBe(true);
      // tools.invoke wraps plugin failures in ToolInvocationError
      // with the original error carried on `cause`. Pin the exact
      // inner tag — a regression that swapped the "no connection
      // found" check for a silent no-auth fallback would either
      // succeed outright (leaking) or surface a different tag here.
      const outer = failureError(userBResult);
      expect(isToolInvocationError(outer)).toBe(true);
      const inner = isToolInvocationError(outer) ? outer.cause : undefined;
      expect(Predicate.isTagged(inner, "McpConnectionError")).toBe(true);

      const afterUserB = server.recorded().slice(recordedBeforeUserB);
      for (const req of afterUserB) {
        expect(req.authorization).not.toBe("Bearer token-user-a-header");
      }
    }),
  );

  it.effect("org header binding resolves the org secret when a user has the same secret id", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer;
      const { execUserA } = yield* makeLayeredMcpExecutors();
      const secretId = SecretId.make("shared-mcp-token");

      yield* execUserA.secrets.set(
        new SetSecretInput({
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
        new SetSecretInput({
          id: secretId,
          scope: USER_A,
          name: "User colliding MCP token",
          value: "token-user-header",
        }),
      );

      const tools = yield* execUserA.tools.list();
      const whoami = tools.find((t) => t.name === "whoami")!;
      const beforeInvoke = server.recorded().length;
      const result = yield* execUserA.tools.invoke(
        whoami.id,
        { marker: "org-header" },
        { onElicitation: "accept-all" },
      );

      expect(result).toMatchObject({
        content: [{ type: "text", text: "ok:org-header" }],
      });
      const invokeRequests = server.recorded().slice(beforeInvoke);
      expect(invokeRequests.some((req) => req.authorization === "Bearer token-org-header")).toBe(
        true,
      );
      expect(invokeRequests.some((req) => req.authorization === "Bearer token-user-header")).toBe(
        false,
      );
    }),
  );
});
