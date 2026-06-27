// ---------------------------------------------------------------------------
// Google agent-facing setup tools (`listProducts`, `addBundle`, `setupStatus`).
//
// These mirror the web Add-Google flow so an agent configuring Google by
// conversation gets the same guided experience the product picker gives a
// human: list products by name, bundle the chosen ids in one call, and receive
// the exact OAuth next steps. They are static source tools, dispatched by their
// fqid through `executor.execute("executor.google.<tool>", input)` and returning
// the `{ ok, data }` / `{ ok, error }` ToolResult envelope.
//
// The stub Discovery host serves canonical `www.googleapis.com` Discovery
// documents. `normalizeGoogleDiscoveryUrl` rewrites every product URL (even
// Keep's `keep.googleapis.com/$discovery` form) to that canonical shape before
// fetching, so the stub is keyed on the normalized URLs the tools actually hit.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ToolAddress, createExecutor } from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { googlePlugin } from "./plugin";
import { GOOGLE_AUDIENCE_WARNING, googleOpenApiPresets } from "./presets";

// --- Canned Discovery documents -------------------------------------------
// One method each; enough for the bundle converter to register a tool. Calendar
// and Gmail are standard-user; Chat is workspace-admin and Keep is
// unsupported-user, so a bundle spanning them exercises both consent warnings.

const discoveryDoc = (input: {
  readonly name: string;
  readonly version: string;
  readonly title: string;
  readonly rootUrl: string;
  readonly servicePath: string;
  readonly scope: string;
  readonly methodId: string;
  readonly path: string;
}) => ({
  name: input.name,
  version: input.version,
  title: input.title,
  rootUrl: input.rootUrl,
  servicePath: input.servicePath,
  auth: { oauth2: { scopes: { [input.scope]: { description: input.title } } } },
  resources: {
    items: {
      methods: {
        list: {
          id: input.methodId,
          httpMethod: "GET",
          path: input.path,
          scopes: [input.scope],
          parameters: {},
        },
      },
    },
  },
  schemas: {
    Item: { id: "Item", type: "object", properties: { id: { type: "string" } } },
  },
});

// Every product URL normalizes to the canonical www.googleapis.com Discovery
// endpoint before fetch, so the stub is keyed on those normalized URLs.
const canonical = (service: string, version: string) =>
  `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`;

const DISCOVERY_BODIES: Readonly<Record<string, string>> = {
  [canonical("calendar", "v3")]: JSON.stringify(
    discoveryDoc({
      name: "calendar",
      version: "v3",
      title: "Calendar API",
      rootUrl: "https://www.googleapis.com/",
      servicePath: "calendar/v3/",
      scope: "https://www.googleapis.com/auth/calendar",
      methodId: "calendar.events.list",
      path: "calendars/{calendarId}/events",
    }),
  ),
  [canonical("gmail", "v1")]: JSON.stringify(
    discoveryDoc({
      name: "gmail",
      version: "v1",
      title: "Gmail API",
      rootUrl: "https://gmail.googleapis.com/",
      servicePath: "",
      scope: "https://mail.google.com/",
      methodId: "gmail.users.messages.list",
      path: "gmail/v1/users/{userId}/messages",
    }),
  ),
  [canonical("chat", "v1")]: JSON.stringify(
    discoveryDoc({
      name: "chat",
      version: "v1",
      title: "Google Chat API",
      rootUrl: "https://chat.googleapis.com/",
      servicePath: "",
      scope: "https://www.googleapis.com/auth/chat.spaces",
      methodId: "chat.spaces.list",
      path: "v1/spaces",
    }),
  ),
  [canonical("keep", "v1")]: JSON.stringify(
    discoveryDoc({
      name: "keep",
      version: "v1",
      title: "Google Keep API",
      rootUrl: "https://keep.googleapis.com/",
      servicePath: "",
      scope: "https://www.googleapis.com/auth/keep",
      methodId: "keep.notes.list",
      path: "v1/notes",
    }),
  ),
};

// A stub HTTP client that serves the canned Discovery document for whichever
// canonical URL the bundle converter fetches; `requests` counts every fetch so
// a test can prove a tool validated input BEFORE reaching the network.
const makeStub = () => {
  const counter = { requests: 0 };
  const layer = Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      counter.requests += 1;
      const url = new URL(request.url);
      const body = DISCOVERY_BODIES[`${url.origin}${url.pathname}`];
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          body === undefined
            ? new Response("not found", { status: 404 })
            : new Response(body, {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
        ),
      );
    }),
  );
  return { counter, layer };
};

const address = (tool: string) => ToolAddress.make(`executor.google.${tool}`);

// --- ToolResult envelope helpers ------------------------------------------

interface ToolOk<T> {
  readonly ok: true;
  readonly data: T;
}
interface ToolFail {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

const expectOk = <T>(raw: unknown): T => {
  expect((raw as { ok: boolean }).ok).toBe(true);
  return (raw as ToolOk<T>).data;
};

const expectFail = (raw: unknown): ToolFail["error"] => {
  expect((raw as { ok: boolean }).ok).toBe(false);
  return (raw as ToolFail).error;
};

interface ListProductsData {
  readonly products: readonly {
    readonly id: string;
    readonly name: string;
    readonly oauthAudience: string;
    readonly consentScopes: readonly string[];
    readonly recommended: boolean;
    readonly needsSpecialConsent: boolean;
  }[];
}

interface AddBundleData {
  readonly slug: string;
  readonly toolCount: number;
  readonly products: readonly string[];
  readonly audienceWarnings: readonly string[];
  readonly nextSteps: string;
}

interface SetupStatusData {
  readonly configured: boolean;
  readonly slug: string;
  readonly products: readonly string[];
  readonly discoveryUrls: readonly string[];
  readonly audienceWarnings: readonly string[];
  readonly nextSteps: string;
}

const plugins = (layer: Layer.Layer<HttpClient.HttpClient, never, never>) =>
  [googlePlugin({ httpClientLayer: layer }), memoryCredentialsPlugin()] as const;

describe("Google agent setup tools", () => {
  it.effect("listProducts mirrors the catalog with recommended and consent flags", () =>
    Effect.gen(function* () {
      const { layer, counter } = makeStub();
      const executor = yield* createExecutor(makeTestConfig({ plugins: plugins(layer) }));

      const data = expectOk<ListProductsData>(yield* executor.execute(address("listProducts"), {}));

      // One entry per catalog preset, and listing never touches the network.
      expect(data.products.length).toBe(googleOpenApiPresets.length);
      expect(counter.requests).toBe(0);

      const byId = new Map(data.products.map((product) => [product.id, product] as const));

      const gmail = byId.get("google-gmail");
      expect(gmail?.recommended).toBe(true);
      expect(gmail?.needsSpecialConsent).toBe(false);
      expect(gmail?.consentScopes).toContain("https://mail.google.com/");

      // workspace-admin and unsupported-user are the special-consent tiers.
      expect(byId.get("google-chat")?.needsSpecialConsent).toBe(true);
      expect(byId.get("google-keep")?.needsSpecialConsent).toBe(true);

      // advanced-user is NOT special consent, and is not a picker default.
      const youtube = byId.get("google-youtube-data");
      expect(youtube?.needsSpecialConsent).toBe(false);
      expect(youtube?.recommended).toBe(false);
    }),
  );

  it.effect("addBundle resolves product ids to one integration with OAuth next steps", () =>
    Effect.gen(function* () {
      const { layer } = makeStub();
      const executor = yield* createExecutor(makeTestConfig({ plugins: plugins(layer) }));

      const data = expectOk<AddBundleData>(
        yield* executor.execute(address("addBundle"), {
          productIds: ["google-calendar", "google-gmail"],
          slug: "google",
        }),
      );

      expect(data.slug).toBe("google");
      expect(data.toolCount).toBeGreaterThanOrEqual(2);
      expect([...data.products]).toEqual(["google-calendar", "google-gmail"]);
      expect([...data.audienceWarnings]).toEqual([]);
      // The connect step hands secret entry to the web UI, never to chat.
      expect(data.nextSteps).toContain("oauth.clients.createHandoff");
      expect(data.nextSteps).toContain("Never ask for the client secret in chat");

      // One integration was actually registered under the chosen slug.
      const integration = yield* executor.google.getIntegration("google");
      expect(integration?.slug).toBeDefined();
    }),
  );

  it.effect("addBundle rejects an unknown product id before any fetch", () =>
    Effect.gen(function* () {
      const { layer, counter } = makeStub();
      const executor = yield* createExecutor(makeTestConfig({ plugins: plugins(layer) }));

      const raw = yield* executor.execute(address("addBundle"), {
        productIds: ["google-calendar", "not-a-product"],
      });

      // Name the bad id back to the caller so the agent can correct itself.
      expect(raw).toMatchObject({
        ok: false,
        error: { code: "unknown_product", message: expect.stringContaining("not-a-product") },
      });
      // Validation happens before the network is touched, and nothing registers.
      expect(counter.requests).toBe(0);
      expect(yield* executor.google.getIntegration("google")).toBeNull();
    }),
  );

  it.effect("addBundle fails when no products and no custom urls are given", () =>
    Effect.gen(function* () {
      const { layer, counter } = makeStub();
      const executor = yield* createExecutor(makeTestConfig({ plugins: plugins(layer) }));

      const error = expectFail(yield* executor.execute(address("addBundle"), {}));

      expect(error.code).toBe("no_products_selected");
      expect(counter.requests).toBe(0);
    }),
  );

  it.effect("addBundle surfaces a consent warning per special-consent tier in the bundle", () =>
    Effect.gen(function* () {
      const { layer } = makeStub();
      const executor = yield* createExecutor(makeTestConfig({ plugins: plugins(layer) }));

      const data = expectOk<AddBundleData>(
        yield* executor.execute(address("addBundle"), {
          productIds: ["google-calendar", "google-chat", "google-keep"],
          slug: "ga",
        }),
      );

      const warnings = [...data.audienceWarnings];
      expect(warnings).toContain(GOOGLE_AUDIENCE_WARNING["workspace-admin"]);
      expect(warnings).toContain(GOOGLE_AUDIENCE_WARNING["unsupported-user"]);
      expect(warnings.length).toBe(2);
    }),
  );

  it.effect("setupStatus reports unconfigured before setup and configured after addBundle", () =>
    Effect.gen(function* () {
      const { layer } = makeStub();
      const executor = yield* createExecutor(makeTestConfig({ plugins: plugins(layer) }));

      const before = expectOk<SetupStatusData>(yield* executor.execute(address("setupStatus"), {}));
      expect(before.configured).toBe(false);
      expect(before.nextSteps).toContain("listProducts");

      yield* executor.execute(address("addBundle"), {
        productIds: ["google-calendar", "google-gmail"],
        slug: "google",
      });

      const after = expectOk<SetupStatusData>(yield* executor.execute(address("setupStatus"), {}));
      expect(after.configured).toBe(true);
      expect(after.slug).toBe("google");
      expect([...after.products].sort()).toEqual(["google-calendar", "google-gmail"]);
      expect([...after.audienceWarnings]).toEqual([]);
      expect(after.nextSteps).toContain("oauth.clients.createHandoff");
    }),
  );
});
