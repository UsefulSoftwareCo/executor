// Selfhost-only: the local issuance path is deliberately opt-in. This scenario
// drives the real account API and browser page when the test instance enables
// EXECUTOR_DELEGATED_CREDENTIAL_ISSUANCE=true. The one-time value is read only
// in a sensitive browser session, which produces no trace, screenshots, or
// video; subsequent recordings exercise the masked list and revocation state.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { expect } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { AccountHttpApi } from "@executor-js/api";
import { createEmulator, type Emulator } from "@executor-js/emulate";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
  microsoftCatalog,
  microsoftGraphAdapter,
} from "@executor-js/plugin-openapi/providers/microsoft";
import { toolkitsPlugin } from "@executor-js/plugin-toolkits/server";
import { HttpClientError } from "effect/unstable/http";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  OAuthClientSlug,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { createInvitedIdentity } from "../targets/selfhost";
import { Api, Browser, Target } from "../src/services";
import type { Identity } from "../src/target";
import { revisit, visit } from "../src/surfaces/browser";

const issuanceEnabled = process.env.EXECUTOR_DELEGATED_CREDENTIAL_ISSUANCE === "true";
const delegatedApi = composePluginApi([
  openApiHttpPlugin({ presets: microsoftCatalog, specFormats: [microsoftGraphAdapter] }),
  toolkitsPlugin(),
] as const);

const availablePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

const microsoftEmulator = Effect.acquireRelease(
  Effect.gen(function* () {
    const port = yield* availablePort;
    return yield* Effect.promise(() => createEmulator({ service: "microsoft", port }));
  }),
  (emulator: Emulator) => Effect.promise(() => emulator.close()).pipe(Effect.ignore),
);

const withOrigin = (identity: Identity, baseUrl: string): Identity => ({
  ...identity,
  headers: { ...identity.headers, origin: new URL(baseUrl).origin },
});

const redactIdentity = (redact: (secret: string) => void, identity: Identity): void => {
  for (const [name, value] of Object.entries(identity.headers ?? {})) {
    if (/authorization|cookie|token|api[-_]?key/i.test(name)) redact(value);
  }
  for (const cookie of identity.cookies ?? []) redact(cookie.value);
  if (identity.credentials?.password) redact(identity.credentials.password);
};

const containsSecret = (value: unknown, secret: string): boolean =>
  secret.length > 0 && JSON.stringify(value).includes(secret);

const apiFailureLabel = (operation: string, error: unknown): string => {
  const status = HttpClientError.isHttpClientError(error) ? error.response?.status : undefined;
  return status === undefined ? `${operation} failed` : `${operation} failed with HTTP ${status}`;
};

const toolExpression = (address: string): string =>
  address
    .replace(/^tools\./, "")
    .split(".")
    .map((segment) => `[${JSON.stringify(segment)}]`)
    .join("");

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const executeErrorKinds = new Set([
  "syntax_error",
  "type_error",
  "reference_error",
  "range_error",
  "tool_error",
  "timeout",
  "resource_limit",
  "serialization_error",
  "thrown",
]);

const sdkErrorTags = new Set([
  "ConnectionNotFoundError",
  "DelegationDeniedError",
  "ExecutionToolError",
  "NoHandlerError",
  "PluginNotLoadedError",
  "StorageError",
  "ToolBlockedError",
  "ToolInvocationError",
  "ToolNotFoundError",
]);

const executionFailureLabel = (structured: unknown): string => {
  if (!isRecord(structured)) return "approved emulator call returned an unclassified error";
  const errorKind = structured.errorKind;
  if (typeof errorKind === "string" && executeErrorKinds.has(errorKind)) {
    return `approved emulator call returned execution error kind ${errorKind}`;
  }
  const error = structured.error;
  if (isRecord(error)) {
    const tag = error._tag;
    if (typeof tag === "string" && sdkErrorTags.has(tag)) {
      return `approved emulator call returned SDK error ${tag}`;
    }
    const status = error.status;
    if (typeof status === "number" && Number.isInteger(status)) {
      return `approved emulator call returned HTTP status ${status}`;
    }
  }
  if (typeof error === "string") {
    for (const tag of sdkErrorTags) {
      if (error.includes(tag)) return `approved emulator call returned SDK error ${tag}`;
    }
    const status = /(?:HTTP|status)\s*[:=]?\s*(\d{3})/i.exec(error)?.[1];
    if (status !== undefined) return `approved emulator call returned HTTP status ${status}`;
  }
  return "approved emulator call returned an unclassified error";
};

const requiredString = (value: string | undefined | null, label: string): string => {
  if (!value) throw new Error(`local emulator returned no ${label}`);
  return value;
};

const mcpRequest = async (input: {
  readonly url: string;
  readonly bearer: string;
  readonly sessionId?: string;
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}): Promise<Response> => {
  const headers = new Headers({
    authorization: `Bearer ${input.bearer}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (input.sessionId) {
    headers.set("mcp-session-id", input.sessionId);
    headers.set("mcp-protocol-version", "2025-03-26");
  }
  return fetch(input.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.id,
      method: input.method,
      ...(input.params === undefined ? {} : { params: input.params }),
    }),
  });
};

const initializeMcp = async (url: string, bearer: string): Promise<string> => {
  const response = await mcpRequest({
    url,
    bearer,
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "delegated-e2e", version: "1" },
    },
  });
  expect(response.status, "delegated MCP initialize succeeds").toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId !== null && sessionId.length > 0, "delegated MCP returns a session id").toBe(
    true,
  );
  return sessionId ?? "";
};

scenario(
  "Delegated credentials · selfhost keeps issuance disabled by default",
  {
    skip: issuanceEnabled ? "local issuance is explicitly enabled for this run" : undefined,
  },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(AccountHttpApi, {
      ...identity,
      headers: { ...identity.headers, origin: new URL(target.baseUrl).origin },
    });

    const listed = yield* client.account.listDelegatedCredentials({ query: {} });
    expect(listed.capabilities.issuanceEnabled, "ordinary selfhost runs fail closed").toBe(false);
    const attempted = yield* Effect.exit(
      client.account.createDelegatedKey({
        payload: {
          label: "disabled delegated key",
          target: { kind: "self" },
          scope: { scopes: ["invoke"], toolkitIds: [] },
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      }),
    );
    expect(Exit.isFailure(attempted), "disabled issuance rejects before creating a key").toBe(true);
  }),
);

scenario(
  "Delegated credentials · selfhost issues, masks, and revokes a local key",
  {
    timeout: 180_000,
    skip: issuanceEnabled
      ? undefined
      : "local delegated-key issuance is disabled; set EXECUTOR_DELEGATED_CREDENTIAL_ISSUANCE=true",
  },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    const { client: makeApiClient } = yield* Api;
    const identity = yield* target.newIdentity();
    const client = yield* makeApiClient(AccountHttpApi, {
      ...identity,
      headers: { ...identity.headers, origin: new URL(target.baseUrl).origin },
    });
    const label = `delegated-e2e-${randomBytes(4).toString("hex")}`;
    let credentialId: string | undefined;
    let oneTimeValue = "";

    const cleanup = Effect.gen(function* () {
      const listed = yield* client.account
        .listDelegatedCredentials({ query: {} })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (listed) {
        yield* Effect.forEach(
          listed.credentials.filter((credential) => credential.label === label),
          (credential) =>
            client.account
              .revokeDelegatedCredential({ params: { credentialId: credential.id } })
              .pipe(Effect.ignore),
          { discard: true },
        );
      }
      if (credentialId) {
        yield* client.account
          .revokeDelegatedCredential({ params: { credentialId } })
          .pipe(Effect.ignore);
      }
    }).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      // The reveal is intentionally isolated from all browser artifacts. The
      // value remains in memory only long enough to prove that the UI received
      // a one-time secret; no assertion includes it in an error diff.
      yield* browser.session(
        identity,
        async ({ page, step, redact }) => {
          await step("Open delegated credentials", async () => {
            await visit(page, "/default/delegated-credentials");
            await page
              .getByRole("heading", { name: "Delegated credentials", exact: true })
              .waitFor();
          });

          await step("Issue a local key with an empty toolkit snapshot", async () => {
            await page.getByRole("button", { name: "Create local key" }).click();
            const dialog = page.getByRole("dialog");
            await dialog.getByLabel("Label").fill(label);
            // The dialog defaults to invoke with no toolkit IDs. Keep the
            // consent empty so this flow also covers the deny-by-default scope.
            await dialog.getByRole("button", { name: "Create key" }).click();
            await dialog.getByText("Copy this secret now. It will not be shown again.").waitFor();
            oneTimeValue = await dialog.locator("input[readonly]").inputValue();
            redact(oneTimeValue);
            expect(oneTimeValue.length > 0, "the UI receives a one-time value").toBe(true);
          });
        },
        { sensitive: true },
      );

      const listed = yield* client.account.listDelegatedCredentials({ query: {} });
      const created = listed.credentials.find((credential) => credential.label === label);
      expect(created !== undefined, "the created credential is listed").toBe(true);
      credentialId = created?.id;
      expect(credentialId !== undefined, "the created credential has an id").toBe(true);
      expect(
        JSON.stringify(listed).includes(oneTimeValue),
        "listing never returns the secret",
      ).toBe(false);

      yield* browser.session(identity, async ({ page, step, redact }) => {
        redactIdentity(redact, identity);
        await step("Review the masked credential row", async () => {
          await visit(page, "/default/delegated-credentials");
          await page.getByText(label, { exact: true }).waitFor();
          const body = (await page.locator("body").textContent()) ?? "";
          expect(
            body.includes(oneTimeValue),
            "the one-time value is absent from the listing UI",
          ).toBe(false);
          await page.getByText("active", { exact: true }).first().waitFor();
        });
      });

      if (credentialId === undefined) return;
      yield* client.account.revokeDelegatedCredential({ params: { credentialId } });

      yield* browser.session(identity, async ({ page, step }) => {
        await step("Review the revoked state", async () => {
          await visit(page, "/default/delegated-credentials");
          await page.getByText("No delegated credentials for this filter.").waitFor();
        });
        await step("The revoked credential stays absent after refresh", async () => {
          await revisit(page);
          const body = (await page.locator("body").textContent()) ?? "";
          expect(body.includes(label), "revocation removes the active row").toBe(false);
          expect(body.includes(oneTimeValue), "revocation UI never contains the secret").toBe(
            false,
          );
        });
      });
    }).pipe(Effect.ensuring(cleanup));
  }),
);

scenario(
  "Delegated credentials · a member key keeps an approved emulator connection scoped through MCP revocation",
  {
    timeout: 240_000,
    skip: issuanceEnabled
      ? undefined
      : "local delegated-key issuance is disabled; enable it for the member external-key flow",
  },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const browser = yield* Browser;
      const { client: makeApiClient } = yield* Api;
      const owner = yield* target.newIdentity();
      const member = yield* Effect.promise(() =>
        createInvitedIdentity(target.baseUrl, owner, {
          role: "member",
          emailPrefix: "delegated-member",
        }),
      );
      const ownerClient = yield* makeApiClient(delegatedApi, withOrigin(owner, target.baseUrl));
      const memberClient = yield* makeApiClient(delegatedApi, withOrigin(member, target.baseUrl));
      const memberAccount = yield* makeApiClient(
        AccountHttpApi,
        withOrigin(member, target.baseUrl),
      );
      const emulator = yield* microsoftEmulator;
      const integration = IntegrationSlug.make(`delegated-ms-${randomBytes(4).toString("hex")}`);
      const oauthClient = OAuthClientSlug.make(`delegated-oauth-${randomBytes(4).toString("hex")}`);
      const connection = ConnectionName.make("memberApproved");
      const toolkitName = `delegated-toolkit-${randomBytes(4).toString("hex")}`;
      let toolkitId: string | undefined;
      let machineKeyId: string | undefined;
      let credentialId: string | undefined;

      const cleanup = Effect.gen(function* () {
        if (credentialId) {
          yield* memberAccount.account
            .revokeDelegatedCredential({ params: { credentialId } })
            .pipe(Effect.ignore);
        }
        if (machineKeyId) {
          yield* memberAccount.account
            .revokeApiKey({ params: { apiKeyId: machineKeyId } })
            .pipe(Effect.ignore);
        }
        yield* ownerClient.connections
          .remove({
            params: { owner: "org", integration, name: connection },
          })
          .pipe(Effect.ignore);
        yield* ownerClient.oauth
          .removeClient({ params: { slug: oauthClient }, payload: { owner: "org" } })
          .pipe(Effect.ignore);
        yield* ownerClient.openapi
          .removeSpec({ params: { slug: integration } })
          .pipe(Effect.ignore);
        if (toolkitId) {
          yield* ownerClient.toolkits.remove({ params: { toolkitId } }).pipe(Effect.ignore);
        }
      }).pipe(Effect.ignore);

      yield* Effect.ensuring(
        Effect.gen(function* () {
          const emulatorCredential = yield* Effect.promise(() =>
            emulator.credentials.mint({
              type: "oauth-client-credentials",
              name: "delegated member emulator connection",
            }),
          );
          const authorizationUrl = requiredString(
            emulatorCredential.authorization_url,
            "authorization URL",
          );
          const tokenUrl = requiredString(emulatorCredential.token_url, "token URL");
          const clientId = requiredString(emulatorCredential.client_id, "client id");
          const clientSecret = requiredString(emulatorCredential.client_secret, "client secret");

          yield* ownerClient.openapi.addSpec({
            payload: {
              spec: { kind: "url", url: emulator.openapiUrl },
              slug: integration,
              name: "Delegated Microsoft emulator",
              baseUrl: emulator.url,
              family: "microsoft",
              authenticationTemplate: [
                {
                  slug: MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
                  kind: "oauth2",
                  authorizationUrl,
                  tokenUrl,
                  scopes: ["https://graph.microsoft.com/.default"],
                },
              ],
            },
          });
          yield* ownerClient.oauth.createClient({
            payload: {
              owner: "org",
              slug: oauthClient,
              authorizationUrl,
              tokenUrl,
              grant: "client_credentials",
              clientId,
              clientSecret,
            },
          });
          const started = yield* ownerClient.oauth.start({
            payload: {
              client: oauthClient,
              clientOwner: "org",
              owner: "org",
              name: connection,
              integration,
              template: AuthTemplateSlug.make(MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG),
              identityLabel: "Delegated member approved",
            },
          });
          expect(started.status, "the local emulator connection is established").toBe("connected");

          const listedConnections = yield* ownerClient.connections.list({ query: { integration } });
          const connectionLabel =
            listedConnections.find((item) => String(item.name) === String(connection))
              ?.identityLabel ?? "Delegated member approved";
          expect(
            listedConnections.some((item) => String(item.name) === String(connection)),
            `the emulator connection is listed (${listedConnections
              .map((item) => String(item.name))
              .join(",")})`,
          ).toBe(true);
          const availableTools = yield* ownerClient.tools.list({
            query: { integration, connection, includeBlocked: "true" },
          });
          const allowedTool = availableTools.find((tool) =>
            String(tool.name).includes("graphUserList"),
          );
          const excludedTool = availableTools.find((tool) =>
            String(tool.name).includes("messageSendMail"),
          );
          expect(
            allowedTool !== undefined,
            `the emulator exposes a read tool (${availableTools
              .map((tool) => String(tool.name))
              .join(",")})`,
          ).toBe(true);
          expect(
            excludedTool !== undefined,
            `the emulator exposes an excluded write tool (${availableTools
              .map((tool) => String(tool.name))
              .join(",")})`,
          ).toBe(true);
          if (!allowedTool || !excludedTool) return;

          const toolkit = yield* ownerClient.toolkits.create({
            payload: { owner: "org", name: toolkitName },
          });
          toolkitId = toolkit.id;
          const connectionPattern = `${integration}.org.${connection}.*`;
          const allowedPattern = String(allowedTool.address).replace(/^tools\./, "");
          const excludedPattern = String(excludedTool.address).replace(/^tools\./, "");
          yield* ownerClient.toolkits.createConnection({
            params: { toolkitId: toolkit.id },
            payload: { pattern: connectionPattern },
          });
          yield* ownerClient.toolkits.createPolicy({
            params: { toolkitId: toolkit.id },
            payload: { pattern: allowedPattern, action: "approve" },
          });
          yield* ownerClient.toolkits.createPolicy({
            params: { toolkitId: toolkit.id },
            payload: { pattern: excludedPattern, action: "block" },
          });
          const memberToolkits = yield* memberClient.toolkits.list();
          expect(
            memberToolkits.toolkits.some((item) => item.id === toolkit.id),
            `the member can see the approved org toolkit (${memberToolkits.toolkits
              .map((item) => String(item.id))
              .join(",")})`,
          ).toBe(true);

          const listedForSnapshot = yield* ownerClient.tools.list({
            query: { integration, connection, includeBlocked: "true" },
          });
          expect(
            listedForSnapshot.some((tool) => String(tool.address) === String(allowedTool.address)),
            "the approved tool remains in the catalog before consent",
          ).toBe(true);
          const memberToolsBeforeConsent = yield* memberClient.tools.list({
            query: { integration, connection, includeBlocked: "true" },
          });
          expect(
            memberToolsBeforeConsent.length > 0,
            `the member can see the approved org connection (${memberToolsBeforeConsent
              .map((tool) => String(tool.name))
              .join(",")})`,
          ).toBe(true);

          const createdMachineKey = yield* memberAccount.account.createApiKey({
            payload: { name: "delegated member machine" },
          });
          machineKeyId = createdMachineKey.id;
          const machineSecret = createdMachineKey.value;
          const machine = {
            label: "delegated member machine",
            headers: { authorization: `Bearer ${machineSecret}` },
          } satisfies Identity;
          const machineClient = yield* makeApiClient(delegatedApi, machine);
          const machineAccount = yield* makeApiClient(AccountHttpApi, machine);
          const machineLabel = "delegated member machine";
          let challengeId = "";
          let challengeNonce = "";
          let challengeProofType = "";
          yield* browser.session(
            member,
            async ({ page, step, redact }) => {
              redactIdentity(redact, member);
              await step("Choose the named toolkit and start the challenge", async () => {
                await visit(page, "/default/delegated-credentials");
                await page
                  .getByRole("heading", { name: "Delegated credentials", exact: true })
                  .waitFor();
                await page.getByRole("button", { name: "External challenge" }).click();
                const dialog = page.getByRole("dialog");
                await dialog.getByLabel("Adapter").selectOption("better-auth-api-key");
                await dialog.getByLabel("Label").fill(machineLabel);
                const toolkitCheckbox = dialog.getByRole("checkbox", {
                  name: new RegExp(toolkitName),
                });
                await toolkitCheckbox.waitFor();
                await toolkitCheckbox.check();
                const connectionAccess = dialog.getByLabel("Connection access");
                await connectionAccess.selectOption("selected");
                expect(
                  await connectionAccess.inputValue(),
                  "the consent form keeps selected connection mode open",
                ).toBe("selected");
                const connectionCheckbox = dialog.getByRole("checkbox", {
                  name: new RegExp(String(connectionLabel)),
                });
                await connectionCheckbox.waitFor();
                await connectionCheckbox.check();
                await dialog.getByRole("button", { name: "Start challenge" }).click();
                const proofNonce = dialog.getByLabel("Proof payload");
                await proofNonce.waitFor();
                const proofPayload = JSON.parse(await proofNonce.inputValue()) as {
                  readonly nonce?: unknown;
                  readonly proofType?: unknown;
                };
                challengeNonce = typeof proofPayload.nonce === "string" ? proofPayload.nonce : "";
                challengeProofType =
                  typeof proofPayload.proofType === "string" ? proofPayload.proofType : "";
                redact(challengeNonce);
                expect(
                  challengeNonce.length > 0,
                  "the challenge dialog exposes its proof nonce",
                ).toBe(true);
                expect(challengeProofType, "the visible proof type matches API-key proof").toBe(
                  "api-key",
                );
                const proofEndpoint = dialog.getByLabel("Proof endpoint");
                await proofEndpoint.waitFor();
                const challengeText = dialog.getByText(/^Challenge /);
                await challengeText.waitFor();
                const rendered = await challengeText.textContent();
                challengeId = rendered?.replace(/^Challenge\s+/, "").trim() ?? "";
                expect(challengeId.length > 0, "the UI displays the challenge reference").toBe(
                  true,
                );
                expect(
                  await proofEndpoint.inputValue(),
                  "the proof endpoint includes the challenge reference",
                ).toContain(`/challenges/${challengeId}/proof`);
              });

              await step("Prove possession of the machine API key", async () => {
                const dialog = page.getByRole("dialog");
                const proven = await Effect.runPromise(
                  machineAccount.account.completeDelegationProof({
                    params: { challengeId },
                    payload: { nonce: challengeNonce, proofType: challengeProofType },
                  }),
                );
                expect(proven.status, "the member machine proves API-key possession").toBe(
                  "proof-complete",
                );
                const replay = await Effect.runPromise(
                  Effect.exit(
                    machineAccount.account.completeDelegationProof({
                      params: { challengeId },
                      payload: { nonce: challengeNonce, proofType: challengeProofType },
                    }),
                  ),
                );
                expect(Exit.isFailure(replay), "proof replay is rejected").toBe(true);
                await dialog.getByText("Proof status: proof-complete", { exact: true }).waitFor();
              });

              await step("Give final consent for the named toolkit", async () => {
                const dialog = page.getByRole("dialog");
                const toolkitCheckbox = dialog.getByRole("checkbox", {
                  name: new RegExp(toolkitName),
                });
                await toolkitCheckbox.waitFor();
                expect(
                  await toolkitCheckbox.isChecked(),
                  "the named toolkit remains selected for consent",
                ).toBe(true);
                const connectionCheckbox = dialog.getByRole("checkbox", {
                  name: new RegExp(String(connectionLabel)),
                });
                expect(
                  await connectionCheckbox.isChecked(),
                  "the named connection remains selected for consent",
                ).toBe(true);
                await dialog.getByRole("button", { name: "Give final consent" }).click();
              });
            },
            { sensitive: true },
          );

          const granted = yield* memberAccount.account.listDelegatedCredentials({ query: {} });
          const created = granted.credentials.find(
            (credential) => credential.label === machineLabel,
          );
          credentialId = created?.id;
          expect(credentialId !== undefined, "human consent creates a durable grant").toBe(true);

          const machineToolsResult = yield* Effect.exit(
            machineClient.tools
              .list({ query: { integration, connection } })
              .pipe(Effect.mapError((error) => apiFailureLabel("delegated GET /api/tools", error))),
          );
          expect(
            Exit.isSuccess(machineToolsResult),
            Exit.isFailure(machineToolsResult)
              ? String(Cause.squash(machineToolsResult.cause))
              : "delegated GET /api/tools succeeds",
          ).toBe(true);
          if (Exit.isFailure(machineToolsResult)) return;
          const machineTools = machineToolsResult.value;
          expect(
            machineTools.some((tool) => String(tool.address) === String(allowedTool.address)),
            "delegated discovery includes the approved tool",
          ).toBe(true);
          expect(
            machineTools.some((tool) => String(tool.address) === String(excludedTool.address)),
            "delegated discovery excludes the blocked tool",
          ).toBe(false);

          const allowedExpression = toolExpression(String(allowedTool.address));
          const allowedExecution = yield* machineClient.executions.execute({
            payload: {
              code: `const result = await tools${allowedExpression}({}); return { ok: result.ok };`,
            },
          });
          expect(allowedExecution.status, "delegated execution reaches the emulator").toBe(
            "completed",
          );
          if (allowedExecution.status !== "completed") return;
          expect(
            allowedExecution.isError,
            allowedExecution.isError
              ? executionFailureLabel(allowedExecution.structured)
              : "the approved emulator call succeeds",
          ).toBe(false);

          const blockedExpression = toolExpression(String(excludedTool.address));
          const blockedExecution = yield* machineClient.executions.execute({
            payload: {
              code: `const result = await tools${blockedExpression}({}); return { ok: result.ok };`,
            },
          });
          expect(blockedExecution.status, "excluded direct execution returns a result").toBe(
            "completed",
          );
          if (blockedExecution.status !== "completed") return;
          expect(
            blockedExecution.isError,
            "excluded direct execution cannot bypass the grant",
          ).toBe(true);

          const blockedSchema = yield* Effect.exit(
            machineClient.tools.schema({ query: { address: excludedTool.address } }),
          );
          expect(Exit.isFailure(blockedSchema), "excluded schema access is denied").toBe(true);

          const sessionId = yield* Effect.promise(() =>
            initializeMcp(target.mcpUrl, machineSecret),
          );
          const listedMcp = yield* Effect.promise(() =>
            mcpRequest({
              url: target.mcpUrl,
              bearer: machineSecret,
              sessionId,
              id: 2,
              method: "tools/list",
            }),
          );
          expect(listedMcp.status, "the delegated MCP session lists tools").toBe(200);
          const calledMcp = yield* Effect.promise(() =>
            mcpRequest({
              url: target.mcpUrl,
              bearer: machineSecret,
              sessionId,
              id: 3,
              method: "tools/call",
              params: {
                name: "execute",
                arguments: {
                  code: `const result = await tools${allowedExpression}({}); return { ok: result.ok };`,
                },
              },
            }),
          );
          expect(calledMcp.status, "the delegated MCP invocation reaches the approved tool").toBe(
            200,
          );

          yield* browser.session(member, async ({ page, step, redact }) => {
            redactIdentity(redact, member);
            await step("Review and revoke the member grant in the browser", async () => {
              await visit(page, "/default/delegated-credentials");
              await page
                .getByRole("heading", { name: "Delegated credentials", exact: true })
                .waitFor();
              await page.getByRole("heading", { name: "Audit", exact: true }).waitFor();
              await page.getByText("grant.create", { exact: true }).waitFor();
              await page.getByText("proof.complete", { exact: true }).waitFor();
              await page.getByText(machineLabel, { exact: true }).waitFor();
              const confirmation = page.waitForEvent("dialog").then(async (nativeDialog) => {
                await nativeDialog.accept();
                return nativeDialog;
              });
              await page.getByRole("button", { name: "Revoke", exact: true }).click();
              const nativeDialog = await confirmation;
              expect(nativeDialog.type(), "the browser revoke control asks for confirmation").toBe(
                "confirm",
              );
              await page.getByText("No delegated credentials for this filter.").waitFor();
              await page.getByText("grant.revoke", { exact: true }).waitFor();
            });
          });

          const afterRevoke = yield* Effect.exit(
            machineClient.tools.list({ query: { integration, connection } }),
          );
          expect(Exit.isFailure(afterRevoke), "revocation blocks a new machine request").toBe(true);

          const afterMcpRevoke = yield* Effect.promise(() =>
            mcpRequest({
              url: target.mcpUrl,
              bearer: machineSecret,
              sessionId,
              id: 4,
              method: "tools/list",
            }),
          );
          // Self-host MCP authentication collapses revoked delegated bearers to
          // Unauthorized so the client receives its standard 401 challenge.
          expect(
            afterMcpRevoke.status,
            "revocation closes the existing MCP session on its next request",
          ).toBe(401);

          yield* browser.session(member, async ({ page, step, redact }) => {
            redactIdentity(redact, member);
            await step("Review the revoked audit outcome", async () => {
              await visit(page, "/default/delegated-credentials");
              await page.getByText("grant.revoke", { exact: true }).waitFor();
              await revisit(page);
              await page.getByText("No delegated credentials for this filter.").waitFor();
            });
          });

          const emulatorLedger = yield* Effect.promise(() => emulator.ledger.list());
          const ledgerText = JSON.stringify(emulatorLedger);
          expect(
            containsSecret(ledgerText, machineSecret),
            "the emulator ledger does not retain the machine secret",
          ).toBe(false);
          expect(
            containsSecret(ledgerText, clientSecret),
            "the emulator ledger does not retain the emulator client secret",
          ).toBe(false);
          expect(
            containsSecret(ledgerText, challengeNonce),
            "the emulator ledger does not retain the proof nonce",
          ).toBe(false);
        }),
        cleanup,
      );
    }),
  ),
);
