// Secrets endpoints — set / list / status / remove round-trip
// and error fidelity within a single org.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { ScopeId, SecretId } from "@executor-js/sdk";

import { asOrg, fetchForOrg, TEST_BASE_URL } from "./__test-harness__/api-harness";

describe("secrets api (HTTP)", () => {
  it.effect("set → list → status returns secret metadata", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const id = `sec_${crypto.randomUUID().slice(0, 8)}`;

      const secretValue = "sk-test-abc";
      const setRef = yield* asOrg(org, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(org) },
          payload: { id: SecretId.make(id), name: "My API Token", value: secretValue },
        }),
      );
      expect(setRef.id).toBe(id);
      expect(setRef.scopeId).toBe(org);
      expect(JSON.stringify(setRef)).not.toContain(secretValue);

      const list = yield* asOrg(org, (client) =>
        client.secrets.list({ params: { scopeId: ScopeId.make(org) } }),
      );
      expect(list.find((s) => s.id === id)?.name).toBe("My API Token");
      expect(JSON.stringify(list)).not.toContain(secretValue);

      const status = yield* asOrg(org, (client) =>
        client.secrets.status({
          params: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) },
        }),
      );
      expect(status.status).toBe("resolved");
    }),
  );

  it.effect("resolve is not available through the public API", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const id = `sec_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(org, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(org) },
          payload: { id: SecretId.make(id), name: "n", value: "v" },
        }),
      );

      const response = yield* Effect.promise(() =>
        fetchForOrg(org)(`${TEST_BASE_URL}/scopes/${org}/secrets/${id}/resolve`),
      );
      expect(response.status).toBe(404);
    }),
  );

  it.effect("status is resolved for an existing secret, missing for an unknown id", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const id = `sec_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(org, (client) =>
        client.secrets.set({
          params: { scopeId: ScopeId.make(org) },
          payload: { id: SecretId.make(id), name: "n", value: "v" },
        }),
      );

      const resolvedStatus = yield* asOrg(org, (client) =>
        client.secrets.status({
          params: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) },
        }),
      );
      expect(resolvedStatus.status).toBe("resolved");

      const missingStatus = yield* asOrg(org, (client) =>
        client.secrets.status({
          params: {
            scopeId: ScopeId.make(org),
            secretId: SecretId.make(`missing_${crypto.randomUUID().slice(0, 8)}`),
          },
        }),
      );
      expect(missingStatus.status).toBe("missing");
    }),
  );

  it.effect("remove deletes the secret; subsequent status is missing and list drops it", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const id = `sec_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            params: { scopeId: ScopeId.make(org) },
            payload: { id: SecretId.make(id), name: "n", value: "v" },
          });
          yield* client.secrets.remove({
            params: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) },
          });
        }),
      );

      const list = yield* asOrg(org, (client) =>
        client.secrets.list({ params: { scopeId: ScopeId.make(org) } }),
      );
      expect(list.map((s) => s.id)).not.toContain(id);

      const afterStatus = yield* asOrg(org, (client) =>
        client.secrets.status({
          params: { scopeId: ScopeId.make(org), secretId: SecretId.make(id) },
        }),
      );
      expect(afterStatus.status).toBe("missing");
    }),
  );

  it.effect("remove on an unknown id is a no-op (idempotent)", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const missing = `missing_${crypto.randomUUID().slice(0, 8)}`;

      const result = yield* asOrg(org, (client) =>
        client.secrets
          .remove({ params: { scopeId: ScopeId.make(org), secretId: SecretId.make(missing) } })
          .pipe(Effect.result),
      );
      expect(Result.isSuccess(result)).toBe(true);
    }),
  );

  it.effect("set with the same id twice updates the visible metadata", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const id = `sec_${crypto.randomUUID().slice(0, 8)}`;

      const first = yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            params: { scopeId: ScopeId.make(org) },
            payload: { id: SecretId.make(id), name: "first", value: "first-value" },
          });
          return yield* client.secrets.list({ params: { scopeId: ScopeId.make(org) } });
        }),
      );
      expect(first.find((s) => s.id === id)?.name).toBe("first");

      const second = yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            params: { scopeId: ScopeId.make(org) },
            payload: { id: SecretId.make(id), name: "updated", value: "second-value" },
          });
          return yield* client.secrets.list({ params: { scopeId: ScopeId.make(org) } });
        }),
      );
      expect(second.find((s) => s.id === id)?.name).toBe("updated");
    }),
  );
});
