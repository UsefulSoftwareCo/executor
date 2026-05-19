#!/usr/bin/env bun
/**
 * End-to-end smoke for agent-driven Executor configuration.
 *
 * This intentionally drives the public dev CLI for agent actions, while using
 * the local HTTP browser/API boundary for sensitive values and OAuth callback
 * completion. Fake test credentials are used, but the shape matches the real
 * flow: agents get handoff URLs, users/browsers enter secrets and complete
 * OAuth outside the context window, then agents verify and bind the resulting
 * ids.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { serveOAuthTestServer, type OAuthTestServerShape } from "../packages/core/sdk/src/testing";
import {
  type GraphqlTestServerShape,
  makeGreetingGraphqlSchema,
  serveGraphqlTestServer,
} from "../packages/plugins/graphql/src/testing/index";
import { Effect } from "effect";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntrypoint = join(repoRoot, "apps/cli/src/main.ts");

type CliContext = {
  readonly dataDir: string;
  readonly scopeDir: string;
  readonly baseUrl: string;
};

type CliResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly text: string;
  readonly exitCode: number;
};

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};

const runCli = async (
  ctx: CliContext,
  args: readonly string[],
  options: { readonly allowFailure?: boolean } = {},
): Promise<CliResult> => {
  const proc = Bun.spawn([process.execPath, "run", cliEntrypoint, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      EXECUTOR_DEV: "1",
      EXECUTOR_DATA_DIR: ctx.dataDir,
      EXECUTOR_SCOPE_DIR: ctx.scopeDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result = { stdout, stderr, text: `${stdout}${stderr}`, exitCode };

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`CLI failed (${exitCode}) for ${args.join(" ")}\n${result.text}`);
  }

  return result;
};

const parseJsonOutput = <T>(result: CliResult): T => {
  const start = result.stdout.indexOf("{");
  const end = result.stdout.lastIndexOf("}");
  assert(start >= 0 && end > start, `CLI output did not contain JSON:\n${result.text}`);
  return JSON.parse(result.stdout.slice(start, end + 1)) as T;
};

const toolData = <T>(value: unknown): T => {
  const result = value as { readonly ok?: boolean; readonly data?: T; readonly error?: unknown };
  assert(result.ok === true, `Tool returned failure: ${JSON.stringify(value)}`);
  return result.data as T;
};

const extractExecutionId = (text: string): string => {
  const match = /executionId:\s*(exec_[A-Za-z0-9_]+)/.exec(text);
  assert(match?.[1], `CLI output did not contain an execution id:\n${text}`);
  return match[1];
};

const callTool = (ctx: CliContext, path: readonly string[], args: unknown = {}) =>
  runCli(ctx, [
    "call",
    ...path,
    JSON.stringify(args),
    "--base-url",
    ctx.baseUrl,
    "--scope",
    ctx.scopeDir,
  ]);

const approvePausedCall = async (ctx: CliContext, paused: CliResult): Promise<CliResult> => {
  const executionId = extractExecutionId(paused.text);
  return await runCli(ctx, [
    "resume",
    "--execution-id",
    executionId,
    "--base-url",
    ctx.baseUrl,
    "--scope",
    ctx.scopeDir,
  ]);
};

const postJson = async (url: string, payload: unknown): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${url} failed with HTTP ${response.status}: ${bodyText}`);
  }
  return bodyText.length > 0 ? JSON.parse(bodyText) : null;
};

const firstScope = (value: unknown): { readonly id: string; readonly name: string } => {
  const data = toolData<{
    readonly scopes: readonly { readonly id: string; readonly name: string }[];
  }>(value);
  const scopes = data.scopes;
  const scope = scopes?.[0];
  assert(scope, `scopes.list returned no scopes: ${JSON.stringify(value)}`);
  return scope;
};

const createSecretPlaceholder = async (
  ctx: CliContext,
  scope: string,
  expectedHandoffScope: string,
  name: string,
) => {
  const result = toolData<{ readonly id: string; readonly url: string }>(
    parseJsonOutput(
      await callTool(ctx, ["executor", "coreTools", "secrets", "create"], { name, scope }),
    ),
  );
  const handoff = new URL(result.url);
  assert(handoff.pathname === "/secrets", `Expected /secrets handoff URL, got ${result.url}`);
  assert(
    handoff.searchParams.get("scope") === expectedHandoffScope,
    `Secret handoff omitted scope: ${result.url}`,
  );
  return result;
};

const setSecretViaBrowserBoundary = async (
  ctx: CliContext,
  browserBaseUrl: string,
  scopeId: string,
  input: { readonly id: string; readonly name: string; readonly value: string },
) => {
  await postJson(`${browserBaseUrl}/api/scopes/${encodeURIComponent(scopeId)}/secrets`, input);
  const status = toolData<{ readonly status: "resolved" | "missing" }>(
    parseJsonOutput(
      await callTool(ctx, ["executor", "coreTools", "secrets", "status"], { id: input.id }),
    ),
  );
  assert(status.status === "resolved", `Secret ${input.id} was not resolved`);
};

const runSmoke = async (oauth: OAuthTestServerShape, graph: GraphqlTestServerShape) => {
  const root = await mkdtemp(join(tmpdir(), "executor-agent-config-smoke-"));
  const ctx: CliContext = {
    dataDir: join(root, "data"),
    scopeDir: join(root, "scope"),
    baseUrl: `http://127.0.0.1:${64180 + Math.floor(Math.random() * 1000)}`,
  };
  await mkdir(ctx.dataDir, { recursive: true });
  await mkdir(ctx.scopeDir, { recursive: true });

  try {
    console.log("[agent-config-smoke] start dev CLI daemon");
    const port = new URL(ctx.baseUrl).port;
    await runCli(ctx, ["daemon", "run", "--port", port, "--scope", ctx.scopeDir]);

    console.log("[agent-config-smoke] discover scope");
    const scope = firstScope(
      parseJsonOutput(await callTool(ctx, ["executor", "coreTools", "scopes", "list"])),
    );

    console.log("[agent-config-smoke] create browser secret handoffs");
    const clientId = await createSecretPlaceholder(ctx, ctx.scopeDir, scope.id, "OAuth client id");
    const clientSecret = await createSecretPlaceholder(
      ctx,
      ctx.scopeDir,
      scope.id,
      "OAuth client secret",
    );
    const browserBaseUrl = new URL(clientId.url).origin;
    await setSecretViaBrowserBoundary(ctx, browserBaseUrl, scope.id, {
      id: clientId.id,
      name: "OAuth client id",
      value: "test-client",
    });
    await setSecretViaBrowserBoundary(ctx, browserBaseUrl, scope.id, {
      id: clientSecret.id,
      name: "OAuth client secret",
      value: "test-secret",
    });

    console.log("[agent-config-smoke] start OAuth handoff through core tool");
    const oauthStart = toolData<{
      readonly sessionId: string;
      readonly authorizationUrl: string | null;
    }>(
      parseJsonOutput(
        await callTool(ctx, ["executor", "coreTools", "oauth", "start"], {
          scope: ctx.scopeDir,
          endpoint: oauth.resourceUrl,
          connectionId: "agent-smoke-oauth",
          pluginId: "graphql",
          identityLabel: "Agent Smoke OAuth",
          strategy: {
            kind: "authorization-code",
            authorizationEndpoint: oauth.authorizationEndpoint,
            tokenEndpoint: oauth.tokenEndpoint,
            clientIdSecretId: clientId.id,
            clientSecretSecretId: clientSecret.id,
            scopes: ["read"],
          },
        }),
      ),
    );
    assert(oauthStart.authorizationUrl, "OAuth start did not return an authorization URL");

    console.log("[agent-config-smoke] complete OAuth callback through browser URL");
    const callback = await Effect.runPromise(
      oauth.completeAuthorizationCodeFlow({
        authorizationUrl: oauthStart.authorizationUrl,
      }),
    );
    const callbackResponse = await fetch(callback.callbackUrl);
    const callbackHtml = await callbackResponse.text();
    assert(callbackResponse.ok, `OAuth callback failed: ${callbackHtml}`);
    assert(
      callbackHtml.includes("Authentication complete"),
      "OAuth callback did not render success",
    );

    const callbackBaseUrl = new URL(callback.callbackUrl).origin;
    const pollResponse = await fetch(
      `${callbackBaseUrl}/api/oauth/await/${encodeURIComponent(callback.state)}`,
    );
    const pollResult = (await pollResponse.json()) as { readonly ok?: boolean };
    assert(pollResult.ok === true, `OAuth await result was not ok: ${JSON.stringify(pollResult)}`);

    const connections = toolData<{
      readonly connections: readonly { readonly id: string }[];
    }>(parseJsonOutput(await callTool(ctx, ["executor", "coreTools", "connections", "list"])));
    assert(
      connections.connections.some((connection) => connection.id === "agent-smoke-oauth"),
      `OAuth connection was not listed: ${JSON.stringify(connections)}`,
    );

    console.log("[agent-config-smoke] add OAuth-backed GraphQL source through approval flow");
    const addSource = await approvePausedCall(
      ctx,
      await callTool(ctx, ["executor", "graphql", "addSource"], {
        scope: ctx.scopeDir,
        endpoint: graph.endpoint,
        name: "Agent Smoke GraphQL",
        namespace: "agent_smoke_graphql",
        oauth2: {
          kind: "oauth2",
          securitySchemeName: "OAuth2",
          flow: "authorizationCode",
          tokenUrl: oauth.tokenEndpoint,
          authorizationUrl: oauth.authorizationEndpoint,
          clientIdSlot: "auth:oauth2:client-id",
          clientSecretSlot: null,
          connectionSlot: "auth:oauth2:connection",
          scopes: ["read"],
        },
        credentials: {
          scope: scope.id,
          auth: {
            oauth2: {
              connection: { kind: "connection", connectionId: "agent-smoke-oauth" },
            },
          },
        },
      }),
    );
    const added = parseJsonOutput<{ readonly ok: boolean }>(addSource);
    assert(added.ok === true, `GraphQL addSource failed: ${addSource.text}`);

    console.log("[agent-config-smoke] invoke configured OAuth-backed tool");
    const invoked = parseJsonOutput<{ readonly ok: boolean; readonly data?: unknown }>(
      await callTool(ctx, ["agent_smoke_graphql", "query", "hello"], { name: "Ada" }),
    );
    assert(
      invoked.ok === true &&
        JSON.stringify(invoked.data) === JSON.stringify({ hello: "Hello Ada" }),
      `GraphQL invocation failed: ${JSON.stringify(invoked)}`,
    );

    console.log("[agent-config-smoke] passed");
  } finally {
    await runCli(ctx, ["daemon", "stop", "--base-url", ctx.baseUrl], {
      allowFailure: true,
    });
    await rm(root, { recursive: true, force: true });
  }
};

const main = async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const oauth = yield* serveOAuthTestServer();
        const graph = yield* serveGraphqlTestServer({
          schema: makeGreetingGraphqlSchema(),
          auth: {
            validateAuthorization: oauth.acceptsAuthorizationHeader,
            wwwAuthenticate: `Bearer resource_metadata="${oauth.protectedResourceMetadataUrl}/graphql"`,
          },
        });
        yield* Effect.promise(() => runSmoke(oauth, graph));
      }),
    ),
  );
};

await main();
