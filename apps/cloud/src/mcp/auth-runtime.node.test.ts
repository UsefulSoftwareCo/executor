import { beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import { ApiKeyService, resetApiKeyValidationCacheForTest } from "../auth/api-keys";
import { WorkOSClient, type WorkOSClientService } from "../auth/workos";
import {
  makeBindingKeyedRuntime,
  mcpAuthBindingsFingerprint,
  type McpAuthBindings,
} from "./auth-runtime";

const stubWorkOS = (overrides: Partial<WorkOSClientService>) =>
  Layer.succeed(
    WorkOSClient,
    new Proxy({} as WorkOSClientService, {
      get: (_target, prop) => {
        if (prop in overrides) return overrides[prop as keyof WorkOSClientService];
        return () => Effect.die(`unexpected WorkOSClient.${String(prop)} call`);
      },
    }),
  );

// The same shape the memoized MCP auth runtime holds in production: the real
// `ApiKeyService.WorkOS` layer (validation cache included) over a counting
// upstream, one fresh build per `build()` call.
const makeCountingAuthRuntime = () => {
  const counters = { upstreamCalls: 0, builds: 0 };
  const layer = ApiKeyService.WorkOS.pipe(
    Layer.provide(
      stubWorkOS({
        validateApiKey: () =>
          Effect.sync(() => {
            counters.upstreamCalls += 1;
            return {
              apiKey: {
                id: "api_key_123",
                owner: { type: "user", id: "user_123", organizationId: "org_123" },
              },
            };
          }),
      }),
    ),
  );
  const runtimeFor = makeBindingKeyedRuntime(() => {
    counters.builds += 1;
    return ManagedRuntime.make(layer);
  });
  // One "request": resolve ApiKeyService from the memoized runtime the
  // fingerprint selects and validate the same key, as `runTraced` would.
  const request = (fingerprint: string) =>
    Effect.promise(() =>
      runtimeFor(fingerprint).runPromise(
        Effect.flatMap(ApiKeyService.asEffect(), (apiKeys) => apiKeys.validate("sk_test_abc")),
      ),
    );
  return { counters, runtimeFor, request };
};

const bindings = (overrides?: Partial<McpAuthBindings>): McpAuthBindings => ({
  WORKOS_API_KEY: "sk_workos_1",
  WORKOS_CLIENT_ID: "client_1",
  WORKOS_COOKIE_PASSWORD: "cookie_password_at_least_32_chars!!",
  ...overrides,
});

describe("makeBindingKeyedRuntime", () => {
  // The validation cache is module-scope in api-keys.ts, so it outlives both
  // a test case and (deliberately) a runtime swap; reset it per case so each
  // test observes only its own upstream calls.
  beforeEach(() => resetApiKeyValidationCacheForTest());

  it.effect("reuses the runtime — and its validation cache — while bindings are unchanged", () =>
    Effect.gen(function* () {
      const { counters, runtimeFor, request } = makeCountingAuthRuntime();

      const first = yield* request("fingerprint_a");
      const second = yield* request("fingerprint_a");

      expect(counters.builds).toBe(1);
      // The second request hit the cached validation, not the upstream.
      expect(counters.upstreamCalls).toBe(1);
      expect(first?.keyId).toBe("api_key_123");
      expect(second).toEqual(first);
      expect(runtimeFor("fingerprint_a")).toBe(runtimeFor("fingerprint_a"));
    }),
  );

  it.effect("rebuilds a fresh runtime on a binding change; cached validations survive", () =>
    Effect.gen(function* () {
      const { counters, runtimeFor, request } = makeCountingAuthRuntime();

      const before = runtimeFor("fingerprint_a");
      yield* request("fingerprint_a");
      expect(counters.upstreamCalls).toBe(1);

      // Rotated bindings: a fresh runtime and auth stack — but NOT a fresh
      // validation cache. The cache map is module-scope (shared with the
      // /api/* plane so revocation can invalidate it everywhere; see
      // agent-handler.ts), so an already-validated key keeps hitting it and
      // its entries age out within the TTL rather than dropping with the
      // runtime.
      yield* request("fingerprint_b");
      expect(counters.builds).toBe(2);
      expect(counters.upstreamCalls).toBe(1);
      expect(runtimeFor("fingerprint_b")).not.toBe(before);
    }),
  );

  it.effect("holds only the latest runtime, so flapping back also rebuilds", () =>
    Effect.gen(function* () {
      const { counters, request } = makeCountingAuthRuntime();

      yield* request("fingerprint_a");
      yield* request("fingerprint_b");
      yield* request("fingerprint_a");

      // Three runtime builds (the memo holds one entry), one upstream call:
      // the module-scope validation cache serves the repeat validations
      // across every swap.
      expect(counters.builds).toBe(3);
      expect(counters.upstreamCalls).toBe(1);
    }),
  );
});

describe("mcpAuthBindingsFingerprint", () => {
  it("is stable for identical bindings", () => {
    expect(mcpAuthBindingsFingerprint(bindings())).toBe(mcpAuthBindingsFingerprint(bindings()));
  });

  it("changes when any captured binding changes", () => {
    const base = mcpAuthBindingsFingerprint(bindings());
    expect(mcpAuthBindingsFingerprint(bindings({ WORKOS_API_KEY: "sk_workos_2" }))).not.toBe(base);
    expect(mcpAuthBindingsFingerprint(bindings({ WORKOS_CLIENT_ID: "client_2" }))).not.toBe(base);
    expect(
      mcpAuthBindingsFingerprint(
        bindings({ WORKOS_COOKIE_PASSWORD: "another_cookie_password_32_chars!!!" }),
      ),
    ).not.toBe(base);
    expect(
      mcpAuthBindingsFingerprint(bindings({ WORKOS_API_URL: "http://127.0.0.1:8788" })),
    ).not.toBe(base);
  });

  it("treats an unset WORKOS_API_URL the same as the client does (no override)", () => {
    // `workosApiUrlOptions` resolves both to "no override", so they may share
    // a fingerprint — a rebuild between them would change nothing.
    expect(mcpAuthBindingsFingerprint(bindings({ WORKOS_API_URL: "" }))).toBe(
      mcpAuthBindingsFingerprint(bindings()),
    );
  });

  it("never collides when a delimiter-like byte sits inside a value", () => {
    // Bindings may contain any byte (workerd Text permits embedded NUL). A
    // raw joined fingerprint would let a NUL inside one value shift the field
    // boundary so two DIFFERENT binding sets collide — suppressing the
    // rebuild a rotation requires. JSON encoding escapes every byte, so these
    // two sets, which collide under a NUL join, must fingerprint differently.
    const a = mcpAuthBindingsFingerprint(
      bindings({
        WORKOS_COOKIE_PASSWORD: "cookie\u0000https://old.example/path",
        WORKOS_API_URL: "https://new.example",
      }),
    );
    const b = mcpAuthBindingsFingerprint(
      bindings({
        WORKOS_COOKIE_PASSWORD: "cookie",
        WORKOS_API_URL: "https://old.example/path\u0000https://new.example",
      }),
    );
    expect(a).not.toBe(b);
  });
});
