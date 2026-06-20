import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as YAML from "yaml";

import { MICROSOFT_AUTH_TEMPLATE_SLUG, MICROSOFT_GRAPH_CLIENT_CREDENTIALS_SCOPES } from "./presets";
import { filterMicrosoftGraphOpenApiSpec } from "./graph";

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
      responses:
        "200":
          description: OK
  /me/messages:
    get:
      operationId: me.messages.ListMessages
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

describe("Microsoft Graph OpenAPI filtering", () => {
  it.effect("keeps selected paths and injects delegated OAuth", () =>
    Effect.gen(function* () {
      const filtered = yield* filterMicrosoftGraphOpenApiSpec(graphFixture, {
        scopes: ["offline_access", "User.Read", "Mail.ReadWrite"],
        exactPaths: ["/me"],
        pathPrefixes: ["/me/messages"],
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
