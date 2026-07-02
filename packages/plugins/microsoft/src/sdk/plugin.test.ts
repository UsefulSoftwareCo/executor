import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  createExecutor,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { microsoftPlugin, type MicrosoftPluginOptions } from "./plugin";
import {
  MICROSOFT_AUTH_TEMPLATE_SLUG,
  MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
  MICROSOFT_GRAPH_ALL_PRESET_IDS,
  MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES,
  MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES,
  MICROSOFT_GRAPH_DEFAULT_PRESET_IDS,
  MICROSOFT_GRAPH_OPENAPI_URL,
  MICROSOFT_GRAPH_PERMISSIONS_REFERENCE_URL,
} from "./presets";

const graphFixture = `
openapi: 3.0.4
info:
  title: Microsoft Graph Fixture
  version: v1.0
servers:
  - url: https://graph.microsoft.com/v1.0
paths:
  /me:
    get:
      operationId: me.GetUser
      summary: Get the signed-in user profile
      security:
        - azureAdDelegated:
            - User.Read
      responses:
        "200":
          description: OK
  /me/messages:
    get:
      operationId: me.messages.ListMessages
      security:
        - azureAdDelegated:
            - Mail.ReadWrite
      responses:
        "200":
          description: OK
  /me/events:
    get:
      operationId: me.events.ListEvents
      security:
        - azureAdDelegated:
            - Calendars.ReadWrite
      responses:
        "200":
          description: OK
  /me/onenote/pages:
    get:
      operationId: me.onenote.pages.ListPages
      security:
        - azureAdDelegated:
            - Notes.ReadWrite
      responses:
        "200":
          description: OK
  /sites:
    get:
      operationId: sites.ListSites
      responses:
        "200":
          description: OK
components:
  schemas:
    user:
      type: object
`;

const permissionsReferenceFixture = `
### User.Read

| Category | Application | Delegated |
|--|--|--|
| Identifier | - | e1fe6dd8-ba31-4d61-89e7-88639da4683d |

---

### Mail.ReadWrite

| Category | Application | Delegated |
|--|--|--|
| Identifier | e2a3a72e-5f79-4c64-b1b1-878b674786c9 | 024d486e-b451-40bb-833d-3e66d98c5c73 |

---

### Calendars.ReadWrite

| Category | Application | Delegated |
|--|--|--|
| Identifier | ef54d2bf-783f-4e0f-bca1-3210c0444d99 | 1ec239c2-d7c9-4623-a91a-a9775856bb36 |

---

### Notes.ReadWrite

| Category | Application | Delegated |
|--|--|--|
| Identifier | 085ca537-6565-41c2-aca7-db852babc212 | 615e82d5-1f7f-4f99-a456-0a0484a820d5 |

---

### AppCatalog.Read.All

| Category | Application | Delegated |
|--|--|--|
| Identifier | e12dae10-5a57-4817-b79d-dfbec5348930 | - |
`;

const EMULATOR_SPEC_URL = "https://microsoft.emulators.dev/_emulate/openapi";
const EMULATOR_BASE_URL = "https://microsoft.emulators.dev";
const LOCAL_EMULATOR_SPEC_URL = "http://localhost:4123/_emulate/openapi";
const LOCAL_EMULATOR_BASE_URL = "http://localhost:4123";
const emulatorGraphFixture = `
openapi: 3.0.3
info:
  title: Microsoft Graph Emulator
  version: 1.0.0
servers:
  - url: ${EMULATOR_BASE_URL}
paths:
  /v1.0/users:
    get:
      operationId: graphUser_List
      responses:
        "200":
          description: OK
  /v1.0/me:
    get:
      operationId: graphUser_GetMyProfile
      responses:
        "200":
          description: OK
components:
  securitySchemes:
    azureAdDelegated:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: ${EMULATOR_BASE_URL}/oauth2/v2.0/authorize
          tokenUrl: ${EMULATOR_BASE_URL}/oauth2/v2.0/token
          scopes:
            User.Read: User.Read
            User.Read.All: User.Read.All
        clientCredentials:
          tokenUrl: ${EMULATOR_BASE_URL}/oauth2/v2.0/token
          scopes:
            https://graph.microsoft.com/.default: https://graph.microsoft.com/.default
`;

const localEmulatorGraphFixture = `
openapi: 3.0.3
info:
  title: Microsoft Graph Local Emulator
  version: 1.0.0
servers:
  - url: ${LOCAL_EMULATOR_BASE_URL}
paths:
  /v1.0/users:
    get:
      operationId: graphUser_List
      responses:
        "200":
          description: OK
components:
  securitySchemes:
    azureAdDelegated:
      type: oauth2
      flows:
        clientCredentials:
          tokenUrl: ${LOCAL_EMULATOR_BASE_URL}/oauth2/v2.0/token
          scopes:
            https://graph.microsoft.com/.default: https://graph.microsoft.com/.default
`;

const graphHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          request.url === MICROSOFT_GRAPH_OPENAPI_URL
            ? graphFixture
            : request.url === MICROSOFT_GRAPH_PERMISSIONS_REFERENCE_URL
              ? permissionsReferenceFixture
              : request.url === EMULATOR_SPEC_URL
                ? emulatorGraphFixture
                : request.url === LOCAL_EMULATOR_SPEC_URL
                  ? localEmulatorGraphFixture
                  : "not found",
          {
            status:
              request.url === MICROSOFT_GRAPH_OPENAPI_URL ||
              request.url === MICROSOFT_GRAPH_PERMISSIONS_REFERENCE_URL ||
              request.url === EMULATOR_SPEC_URL ||
              request.url === LOCAL_EMULATOR_SPEC_URL
                ? 200
                : 404,
            headers: {
              "content-type":
                request.url === MICROSOFT_GRAPH_PERMISSIONS_REFERENCE_URL
                  ? "text/markdown"
                  : "application/yaml",
            },
          },
        ),
      ),
    ),
  ),
);

const graphPlugins = (options?: Omit<MicrosoftPluginOptions, "httpClientLayer">) =>
  [
    microsoftPlugin({ httpClientLayer: graphHttpClientLayer, ...options }),
    memoryCredentialsPlugin(),
  ] as const;

describe("Microsoft Graph provider", () => {
  it.effect("rejects non-Microsoft URL overrides before fetching the Graph spec", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let requests = 0;
        const blockedHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
          HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
            Effect.sync(() => {
              requests += 1;
              return HttpClientResponse.fromWeb(
                request,
                new Response("unexpected request", { status: 500 }),
              );
            }),
          ),
        );
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              microsoftPlugin({ httpClientLayer: blockedHttpClientLayer }),
              memoryCredentialsPlugin(),
            ],
          }),
        );

        const exit = yield* executor.microsoft
          .addGraph({
            slug: "bad_graph",
            baseUrl: "https://attacker.example/v1.0",
            specUrl: "https://attacker.example/openapi.yaml",
            authorizationUrl: "https://attacker.example/oauth2/v2.0/authorize",
            tokenUrl: "https://attacker.example/oauth2/v2.0/token",
            clientCredentialsTokenUrl: "https://attacker.example/oauth2/v2.0/token",
          })
          .pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(requests).toBe(0);
      }),
    ),
  );

  it.effect("adds a selected Graph workload source with one OAuth template", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: graphPlugins() }));

        const result = yield* executor.microsoft.addGraph({
          presetIds: ["profile", "mail"],
          slug: "microsoft_graph",
          description: "Microsoft Graph",
        });

        expect(String(result.slug)).toBe("microsoft_graph");

        const config = yield* executor.microsoft.getConfig("microsoft_graph");
        expect(config?.microsoftGraphPresetIds).toEqual(["profile", "mail"]);
        expect(config?.microsoftGraphCoversFullGraph).toBe(false);
        expect(config?.microsoftGraphScopes).toEqual([
          "offline_access",
          "User.Read",
          "Mail.ReadWrite",
          "Mail.Send",
          "MailboxSettings.ReadWrite",
        ]);

        const oauthTemplates = config?.authenticationTemplate?.filter(
          (entry) => entry.kind === "oauth2",
        );
        const delegated = oauthTemplates?.find(
          (entry) => String(entry.slug) === MICROSOFT_AUTH_TEMPLATE_SLUG,
        );
        const clientCredentials = oauthTemplates?.find(
          (entry) => String(entry.slug) === MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
        );
        expect(delegated?.kind === "oauth2" ? delegated.slug : undefined).toBe(
          AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
        );
        expect(delegated?.kind === "oauth2" ? delegated.scopes : undefined).toEqual([
          "offline_access",
          "User.Read",
          "Mail.ReadWrite",
          "Mail.Send",
          "MailboxSettings.ReadWrite",
        ]);
        expect(clientCredentials?.kind === "oauth2" ? clientCredentials.slug : undefined).toBe(
          AuthTemplateSlug.make(MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG),
        );
        expect(clientCredentials?.kind === "oauth2" ? clientCredentials.scopes : undefined).toEqual(
          [...MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES],
        );

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("main"),
          integration: IntegrationSlug.make("microsoft_graph"),
          template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
          value: "token-xyz",
        });

        const toolNames = (yield* executor.tools.list()).map((tool) => String(tool.name));
        expect(toolNames).toContain("me.getUser");
        expect(toolNames).toContain("me.messagesListMessages");
        expect(toolNames).not.toContain("sites.listSites");
      }),
    ),
  );

  it.effect("adds common Microsoft Graph workloads by default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: graphPlugins() }));

        yield* executor.microsoft.addGraph({
          slug: "microsoft_graph_all",
          description: "Microsoft Graph",
        });

        const config = yield* executor.microsoft.getConfig("microsoft_graph_all");
        expect(config?.microsoftGraphPresetIds).toEqual(MICROSOFT_GRAPH_DEFAULT_PRESET_IDS);
        expect(config?.microsoftGraphCoversFullGraph).toBe(false);
        expect(config?.microsoftGraphScopes).toEqual([
          "offline_access",
          "User.Read",
          "Mail.ReadWrite",
          "Mail.Send",
          "MailboxSettings.ReadWrite",
          "Calendars.ReadWrite",
          "Contacts.ReadWrite",
          "People.Read.All",
          "Tasks.ReadWrite",
          "Files.ReadWrite.All",
          "Sites.ReadWrite.All",
          "Notes.ReadWrite",
          "Chat.ReadWrite",
          "Team.ReadBasic.All",
          "Channel.ReadBasic.All",
          "ChannelMessage.Read.All",
          "ChannelMessage.Send",
          "OnlineMeetings.ReadWrite",
        ]);

        const delegated = config?.authenticationTemplate?.find(
          (entry) => String(entry.slug) === MICROSOFT_AUTH_TEMPLATE_SLUG,
        );
        expect(delegated?.kind === "oauth2" ? delegated.scopes : undefined).toEqual(
          config?.microsoftGraphScopes,
        );

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("all"),
          integration: IntegrationSlug.make("microsoft_graph_all"),
          template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
          value: "token-xyz",
        });

        const toolNames = (yield* executor.tools.list()).map((tool) => String(tool.name));
        expect(toolNames).toContain("me.getUser");
        expect(toolNames).toContain("me.messagesListMessages");
        expect(toolNames).toContain("me.eventsListEvents");
        expect(toolNames).toContain("me.onenotePagesListPages");
        expect(toolNames).toContain("sites.listSites");
      }),
    ),
  );

  it.effect("uses the app registration default scope when every Graph workload is selected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: graphPlugins() }));

        yield* executor.microsoft.addGraph({
          presetIds: [...MICROSOFT_GRAPH_ALL_PRESET_IDS],
          slug: "microsoft_graph_full",
          description: "Microsoft Graph",
        });

        const config = yield* executor.microsoft.getConfig("microsoft_graph_full");
        expect(config?.microsoftGraphPresetIds).toEqual(MICROSOFT_GRAPH_ALL_PRESET_IDS);
        expect(config?.microsoftGraphCoversFullGraph).toBe(true);
        expect(config?.microsoftGraphScopes).toEqual(MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES);

        const delegated = config?.authenticationTemplate?.find(
          (entry) => String(entry.slug) === MICROSOFT_AUTH_TEMPLATE_SLUG,
        );
        expect(delegated?.kind === "oauth2" ? delegated.scopes : undefined).toEqual([
          ...MICROSOFT_GRAPH_DELEGATED_DEFAULT_SCOPES,
        ]);

        // Full-graph add routes through the streaming compile (the path the
        // real 37MB spec takes): the source text is structurally split and each
        // op's binding plus a `description` is persisted, alongside the
        // content-addressed defs blob, never materializing the whole-document
        // tree. Read the operations back through the live serve path to prove
        // they landed in storage AND that the serve fast path rebuilds tools
        // from the persisted bindings (no spec parse).
        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("full"),
          integration: IntegrationSlug.make("microsoft_graph_full"),
          template: AuthTemplateSlug.make(MICROSOFT_AUTH_TEMPLATE_SLUG),
          value: "token-xyz",
        });

        const tools = yield* executor.tools.list();
        const toolNames = tools.map((tool) => String(tool.name));
        expect(toolNames).toContain("me.getUser");
        expect(toolNames).toContain("me.messagesListMessages");
        expect(toolNames).toContain("sites.listSites");

        // The serve fast path must rebuild every tool's description from the
        // persisted operation, not drop it. Each graph tool carries a non-empty
        // description.
        for (const tool of tools) {
          expect(tool.description.length).toBeGreaterThan(0);
        }

        // `me.getUser`'s spec summary survives the add -> persist -> serve
        // round-trip. The bare `${METHOD} ${path}` fallback inside the serve
        // path would be "GET /me", so matching the summary proves the persisted
        // `description` field is what's served.
        const getUser = tools.find((tool) => String(tool.name) === "me.getUser");
        expect(getUser?.description).toBe("Get the signed-in user profile");

        // An op without a spec summary falls back to `${METHOD} ${path}`, also
        // sourced from the persisted binding on the serve fast path.
        const listSites = tools.find((tool) => String(tool.name) === "sites.listSites");
        expect(listSites?.description).toBe("GET /sites");
      }),
    ),
  );

  it.effect("uses explicit full Graph scopes when custom dynamic scopes are added", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: graphPlugins() }));

        yield* executor.microsoft.addGraph({
          slug: "microsoft_graph_all_custom",
          presetIds: [...MICROSOFT_GRAPH_ALL_PRESET_IDS],
          customScopes: ["Custom.Scope"],
        });

        const config = yield* executor.microsoft.getConfig("microsoft_graph_all_custom");
        expect(config?.microsoftGraphCoversFullGraph).toBe(true);
        expect(config?.microsoftGraphScopes).toEqual([
          "offline_access",
          "User.Read",
          "Mail.ReadWrite",
          "Calendars.ReadWrite",
          "Notes.ReadWrite",
          "Custom.Scope",
        ]);
      }),
    ),
  );

  it.effect("adds Microsoft Graph from the emulator spec with app-only OAuth endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: graphPlugins({ allowUnsafeUrlOverrides: true }) }),
        );

        yield* executor.microsoft.addGraph({
          presetIds: ["users"],
          slug: "microsoft_graph_emulated",
          baseUrl: EMULATOR_BASE_URL,
          specUrl: EMULATOR_SPEC_URL,
        });

        const config = yield* executor.microsoft.getConfig("microsoft_graph_emulated");
        expect(config?.sourceUrl).toBe(EMULATOR_SPEC_URL);
        expect(config?.baseUrl).toBe(EMULATOR_BASE_URL);
        expect(config?.microsoftGraphAuthorizationUrl).toBe(
          `${EMULATOR_BASE_URL}/oauth2/v2.0/authorize`,
        );
        expect(config?.microsoftGraphTokenUrl).toBe(`${EMULATOR_BASE_URL}/oauth2/v2.0/token`);
        expect(config?.microsoftGraphClientCredentialsTokenUrl).toBe(
          `${EMULATOR_BASE_URL}/oauth2/v2.0/token`,
        );

        const delegated = config?.authenticationTemplate?.find(
          (entry) => entry.kind === "oauth2" && String(entry.slug) === MICROSOFT_AUTH_TEMPLATE_SLUG,
        );
        const clientCredentials = config?.authenticationTemplate?.find(
          (entry) =>
            entry.kind === "oauth2" &&
            String(entry.slug) === MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG,
        );
        expect(delegated?.kind === "oauth2" ? delegated.tokenUrl : undefined).toBe(
          `${EMULATOR_BASE_URL}/oauth2/v2.0/token`,
        );
        expect(clientCredentials?.kind === "oauth2" ? clientCredentials.scopes : undefined).toEqual(
          [...MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES],
        );

        yield* executor.connections.create({
          owner: "org",
          name: ConnectionName.make("machine"),
          integration: IntegrationSlug.make("microsoft_graph_emulated"),
          template: AuthTemplateSlug.make(MICROSOFT_CLIENT_CREDENTIALS_AUTH_TEMPLATE_SLUG),
          value: "token-xyz",
        });

        const toolNames = (yield* executor.tools.list()).map((tool) => String(tool.name));
        expect(toolNames).toContain("users.graphUserList");
      }),
    ),
  );

  it.effect("accepts a loopback http emulator spec only when the override is enabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: graphPlugins({ allowUnsafeUrlOverrides: true }) }),
        );

        yield* executor.microsoft.addGraph({
          presetIds: ["users"],
          slug: "microsoft_graph_local_emulated",
          baseUrl: LOCAL_EMULATOR_BASE_URL,
          specUrl: LOCAL_EMULATOR_SPEC_URL,
        });

        const config = yield* executor.microsoft.getConfig("microsoft_graph_local_emulated");
        expect(config?.sourceUrl).toBe(LOCAL_EMULATOR_SPEC_URL);
        expect(config?.baseUrl).toBe(LOCAL_EMULATOR_BASE_URL);
      }),
    ),
  );

  it.effect("rejects a loopback http spec URL when the override is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* createExecutor(makeTestConfig({ plugins: graphPlugins() }));

        const exit = yield* executor.microsoft
          .addGraph({
            slug: "microsoft_graph_local_disabled",
            baseUrl: LOCAL_EMULATOR_BASE_URL,
            specUrl: LOCAL_EMULATOR_SPEC_URL,
          })
          .pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ),
  );

  it.effect("rejects a non-loopback http override even with allowUnsafeUrlOverrides", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let requests = 0;
        const blockedHttpClientLayer = Layer.succeed(HttpClient.HttpClient)(
          HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
            Effect.sync(() => {
              requests += 1;
              return HttpClientResponse.fromWeb(
                request,
                new Response("unexpected request", { status: 500 }),
              );
            }),
          ),
        );
        const executor = yield* createExecutor(
          makeTestConfig({
            plugins: [
              microsoftPlugin({
                httpClientLayer: blockedHttpClientLayer,
                allowUnsafeUrlOverrides: true,
              }),
              memoryCredentialsPlugin(),
            ],
          }),
        );

        const exit = yield* executor.microsoft
          .addGraph({
            slug: "microsoft_graph_http_example",
            baseUrl: "http://example.com/v1.0",
            specUrl: "http://example.com/openapi.yaml",
          })
          .pipe(Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(requests).toBe(0);
      }),
    ),
  );
});
