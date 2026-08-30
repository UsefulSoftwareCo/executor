import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import { ApiKeyService } from "../auth/api-keys";
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

  it.effect("rebuilds a fresh runtime — resetting the validation cache — on a binding change", () =>
    Effect.gen(function* () {
      const { counters, runtimeFor, request } = makeCountingAuthRuntime();

      const before = runtimeFor("fingerprint_a");
      yield* request("fingerprint_a");
      expect(counters.upstreamCalls).toBe(1);

      // Rotated bindings: a fresh runtime (fresh ApiKeyService, empty cache),
      // so the same key must be re-validated upstream.
      yield* request("fingerprint_b");
      expect(counters.builds).toBe(2);
      expect(counters.upstreamCalls).toBe(2);
      expect(runtimeFor("fingerprint_b")).not.toBe(before);
    }),
  );

  it.effect("holds only the latest runtime, so flapping back also rebuilds", () =>
    Effect.gen(function* () {
      const { counters, request } = makeCountingAuthRuntime();

      yield* request("fingerprint_a");
      yield* request("fingerprint_b");
      yield* request("fingerprint_a");

      expect(counters.builds).toBe(3);
      expect(counters.upstreamCalls).toBe(3);
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
});
