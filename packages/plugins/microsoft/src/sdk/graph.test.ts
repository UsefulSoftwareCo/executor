import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as YAML from "yaml";

import { MICROSOFT_AUTH_TEMPLATE_SLUG, MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES } from "./presets";
import {
  buildFilteredMicrosoftGraphOpenApiSpec,
  filterMicrosoftGraphOpenApiSpec,
  parseMicrosoftGraphDelegatedScopes,
} from "./graph";

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
      tags:
        - me.user
      responses:
        "200":
          description: OK
  /me/messages:
    get:
      operationId: me.messages.ListMessages
      tags:
        - me.message
      security:
        - azureAdDelegated:
            - Mail.ReadWrite
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/messageCollection"
  /me/onenote/pages:
    get:
      operationId: me.onenote.pages.ListPages
      tags:
        - me.onenote
      security:
        - azureAdDelegated:
            - Notes.ReadWrite
      responses:
        "200":
          description: OK
  /teams/{team-id}/channels/{channel-id}/messages:
    post:
      operationId: teams.channels.messages.CreateMessage
      tags:
        - teams.channel
      x-ms-permissions:
        delegated:
          - ChannelMessage.Send
      responses:
        "200":
          description: OK
  /sites:
    get:
      operationId: sites.ListSites
      tags:
        - sites.site
      responses:
        "200":
          description: OK
components:
  schemas:
    user:
      type: object
    messageCollection:
      type: object
      properties:
        value:
          type: array
          items:
            $ref: "#/components/schemas/message"
    message:
      type: object
      properties:
        id:
          type: string
    unusedDirectoryObject:
      type: object
`;

describe("Microsoft Graph OpenAPI filtering", () => {
  it("parses delegated scopes from the generated Microsoft permissions reference", () => {
    expect(
      parseMicrosoftGraphDelegatedScopes(`
### User.Read

| Category | Application | Delegated |
|--|--|--|
| Identifier | - | e1fe6dd8-ba31-4d61-89e7-88639da4683d |

---

### AppCatalog.Read.All

| Category | Application | Delegated |
|--|--|--|
| Identifier | e12dae10-5a57-4817-b79d-dfbec5348930 | - |

---

### Calendars.ReadWrite

| Category | Application | Delegated |
|--|--|--|
| Identifier | ef54d2bf-783f-4e0f-bca1-3210c0444d99 | 1ec239c2-d7c9-4623-a91a-a9775856bb36 |
`),
    ).toEqual(["User.Read", "Calendars.ReadWrite"]);
  });

  it.effect("keeps selected paths and injects delegated OAuth", () =>
    Effect.gen(function* () {
      const filtered = yield* filterMicrosoftGraphOpenApiSpec(graphFixture, {
        scopes: ["offline_access", "User.Read", "Mail.ReadWrite"],
        exactPaths: ["/me"],
        pathPrefixes: ["/me/messages"],
        tagPrefixes: [],
      });
      const doc = YAML.parse(filtered) as {
        readonly paths: Record<string, unknown>;
        readonly components: {
          readonly securitySchemes: Record<string, unknown>;
        };
        readonly security: readonly Record<string, readonly string[]>[];
      };

      expect(Object.keys(doc.paths).sort()).toEqual(["/me", "/me/messages"]);
      expect(doc.components.securitySchemes[MICROSOFT_AUTH_TEMPLATE_SLUG]).toBeDefined();
      expect(doc.security[0]?.[MICROSOFT_AUTH_TEMPLATE_SLUG]).toEqual([
        "offline_access",
        "User.Read",
        "Mail.ReadWrite",
      ]);
    }),
  );

  it.effect("prunes unreferenced components from filtered specs", () =>
    Effect.gen(function* () {
      const filtered = yield* filterMicrosoftGraphOpenApiSpec(graphFixture, {
        scopes: ["offline_access", "Mail.ReadWrite"],
        exactPaths: [],
        pathPrefixes: ["/me/messages"],
        tagPrefixes: [],
      });
      const doc = YAML.parse(filtered) as {
        readonly components: {
          readonly schemas?: Record<string, unknown>;
          readonly securitySchemes: Record<string, unknown>;
        };
      };

      expect(Object.keys(doc.components.schemas ?? {}).sort()).toEqual([
        "message",
        "messageCollection",
      ]);
      expect(doc.components.schemas?.unusedDirectoryObject).toBeUndefined();
      expect(doc.components.securitySchemes[MICROSOFT_AUTH_TEMPLATE_SLUG]).toBeDefined();
    }),
  );

  it.effect("keeps operations matched by selected Graph scopes", () =>
    Effect.gen(function* () {
      const filtered = yield* filterMicrosoftGraphOpenApiSpec(graphFixture, {
        scopes: ["offline_access", "Notes.ReadWrite", "ChannelMessage.Send"],
        exactPaths: [],
        pathPrefixes: [],
        tagPrefixes: [],
      });
      const doc = YAML.parse(filtered) as {
        readonly paths: Record<string, unknown>;
      };

      expect(Object.keys(doc.paths).sort()).toEqual([
        "/me/onenote/pages",
        "/teams/{team-id}/channels/{channel-id}/messages",
      ]);
    }),
  );

  it.effect("keeps operations matched by selected Graph tags", () =>
    Effect.gen(function* () {
      const filtered = yield* filterMicrosoftGraphOpenApiSpec(graphFixture, {
        scopes: ["offline_access"],
        exactPaths: [],
        pathPrefixes: [],
        tagPrefixes: ["teams."],
      });
      const doc = YAML.parse(filtered) as {
        readonly paths: Record<string, unknown>;
      };

      expect(Object.keys(doc.paths)).toEqual(["/teams/{team-id}/channels/{channel-id}/messages"]);
    }),
  );

  it.effect("keeps categorized Graph selections and derives delegated scopes from the spec", () =>
    Effect.gen(function* () {
      const filtered = yield* buildFilteredMicrosoftGraphOpenApiSpec(graphFixture, {
        scopes: ["offline_access"],
        exactPaths: [],
        pathPrefixes: ["/me", "/sites", "/teams"],
        tagPrefixes: [],
        fullGraphScopes: ["User.Read", "Mail.ReadWrite", "Notes.ReadWrite"],
      });
      const doc = YAML.parse(filtered.specText) as {
        readonly paths: Record<string, unknown>;
        readonly security: readonly Record<string, readonly string[]>[];
      };

      expect(Object.keys(doc.paths).sort()).toEqual([
        "/me",
        "/me/messages",
        "/me/onenote/pages",
        "/sites",
        "/teams/{team-id}/channels/{channel-id}/messages",
      ]);
      expect(filtered.scopes).toEqual([
        "offline_access",
        "User.Read",
        "Mail.ReadWrite",
        "Notes.ReadWrite",
        "ChannelMessage.Send",
      ]);
      expect(doc.security[0]?.[MICROSOFT_AUTH_TEMPLATE_SLUG]).toEqual(filtered.scopes);
    }),
  );

  it.effect("keeps emulator versioned paths and preserves emulator OAuth endpoints", () =>
    Effect.gen(function* () {
      const filtered = yield* filterMicrosoftGraphOpenApiSpec(
        `
openapi: 3.0.3
info:
  title: Microsoft Graph Emulator
  version: 1.0.0
servers:
  - url: https://microsoft.emulators.dev
paths:
  /v1.0/me:
    get:
      operationId: graphUser_GetMyProfile
      responses:
        "200":
          description: OK
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
        authorizationCode:
          authorizationUrl: https://microsoft.emulators.dev/oauth2/v2.0/authorize
          tokenUrl: https://microsoft.emulators.dev/oauth2/v2.0/token
          scopes:
            User.Read: User.Read
        clientCredentials:
          tokenUrl: https://microsoft.emulators.dev/oauth2/v2.0/token
          scopes:
            https://graph.microsoft.com/.default: https://graph.microsoft.com/.default
`,
        {
          scopes: ["offline_access", "User.Read", "User.Read.All"],
          exactPaths: ["/me"],
          pathPrefixes: ["/users"],
          tagPrefixes: [],
        },
      );
      const doc = YAML.parse(filtered) as {
        readonly servers: readonly { readonly url: string }[];
        readonly paths: Record<string, unknown>;
        readonly components: {
          readonly securitySchemes: Record<
            string,
            {
              readonly flows: {
                readonly authorizationCode: {
                  readonly authorizationUrl: string;
                  readonly tokenUrl: string;
                };
                readonly clientCredentials: {
                  readonly tokenUrl: string;
                  readonly scopes: Record<string, string>;
                };
              };
            }
          >;
        };
      };

      expect(doc.servers[0]?.url).toBe("https://microsoft.emulators.dev");
      expect(Object.keys(doc.paths).sort()).toEqual(["/v1.0/me", "/v1.0/users"]);
      const flows = doc.components.securitySchemes[MICROSOFT_AUTH_TEMPLATE_SLUG]?.flows;
      expect(flows?.authorizationCode.authorizationUrl).toBe(
        "https://microsoft.emulators.dev/oauth2/v2.0/authorize",
      );
      expect(flows?.authorizationCode.tokenUrl).toBe(
        "https://microsoft.emulators.dev/oauth2/v2.0/token",
      );
      expect(flows?.clientCredentials.tokenUrl).toBe(
        "https://microsoft.emulators.dev/oauth2/v2.0/token",
      );
      expect(Object.keys(flows?.clientCredentials.scopes ?? {})).toEqual([
        ...MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES,
      ]);
    }),
  );
});
