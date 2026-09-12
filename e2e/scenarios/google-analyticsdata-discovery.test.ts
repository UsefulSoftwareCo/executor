import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

scenario(
  "Google Analytics Data · public Discovery import exposes report tools",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const apiClient = yield* client(api, identity);
    const slug = IntegrationSlug.make(`analytics_${randomBytes(4).toString("hex")}`);
    // Fetch Google's public document through the real server import path.
    // No Analytics account or authenticated report request is needed.
    const added = yield* apiClient.openapi.addSpec({
      payload: {
        slug,
        spec: {
          kind: "url",
          url: "https://www.googleapis.com/discovery/v1/apis/analyticsdata/v1beta/rest",
        },
      },
    });
    yield* Effect.gen(function* () {
      expect(added.toolCount).toBeGreaterThan(0);
      const providers = yield* apiClient.providers.list();
      const provider = providers[0];
      if (provider === undefined) return yield* Effect.die("No credential provider available");
      yield* apiClient.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make("main"),
          integration: slug,
          template: AuthTemplateSlug.make("googleOAuth2"),
          from: { provider, id: ProviderItemId.make(randomUUID()) },
        },
      });
      const tools = yield* apiClient.tools.list({ query: { integration: slug } });
      expect(tools.some((tool) => tool.name.endsWith("runReport"))).toBe(true);
      expect(tools.some((tool) => tool.name.endsWith("runRealtimeReport"))).toBe(true);
    }).pipe(Effect.ensuring(apiClient.openapi.removeSpec({ params: { slug } }).pipe(Effect.orDie)));
  }),
);
