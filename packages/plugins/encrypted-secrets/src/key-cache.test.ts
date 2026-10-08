import { Effect, Exit } from "effect";
import { afterEach, describe, expect, test } from "@effect/vitest";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: Vitest hoists vi.mock only with a direct vitest import
import { vi } from "vitest";
import { scryptSync } from "node:crypto";
import { ProviderItemId, type CredentialProvider, type PluginCtx } from "@executor-js/sdk";

import { decryptSecret, deriveKey, encryptSecret, encryptedSecretsPlugin } from "./index";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, scryptSync: vi.fn(actual.scryptSync) };
});

afterEach(() => vi.mocked(scryptSync).mockClear());

const providerFor = (key: string, ctx: PluginCtx<unknown>): CredentialProvider => {
  const plugin = encryptedSecretsPlugin({ key });
  const providers = plugin.credentialProviders as (
    ctx: PluginCtx<unknown>,
  ) => readonly CredentialProvider[];
  return providers(ctx)[0]!;
};

describe("session key derivation", () => {
  test("derives once for repeated plugin builds and invalidates on every key change", () => {
    encryptedSecretsPlugin({ key: "cache-a" });
    encryptedSecretsPlugin({ key: "cache-a" });
    expect(scryptSync).toHaveBeenCalledTimes(1);
    encryptedSecretsPlugin({ key: "cache-b" });
    encryptedSecretsPlugin({ key: "cache-b" });
    expect(scryptSync).toHaveBeenCalledTimes(2);
    encryptedSecretsPlugin({ key: "cache-a" });
    expect(scryptSync).toHaveBeenCalledTimes(3);
    expect(() => encryptedSecretsPlugin({ key: "" })).toThrow(/non-empty/);
    expect(scryptSync).toHaveBeenCalledTimes(3);
  });

  test("cached keys keep provider storage and ownership separate", async () => {
    const getA = vi.fn(() => Effect.succeed(null));
    const getB = vi.fn(() => Effect.succeed(null));
    const putA = vi.fn(() => Effect.succeed(undefined));
    const putB = vi.fn(() => Effect.succeed(undefined));
    // oxlint-disable-next-line executor/no-double-cast -- boundary: only get and put are used by this provider test
    const ctxA = {
      owner: { tenant: "a", subject: "alice" },
      pluginStorage: { get: getA, put: putA },
    } as unknown as PluginCtx<unknown>;
    // oxlint-disable-next-line executor/no-double-cast -- boundary: only get and put are used by this provider test
    const ctxB = {
      owner: { tenant: "b", subject: "bob" },
      pluginStorage: { get: getB, put: putB },
    } as unknown as PluginCtx<unknown>;
    const a = providerFor("isolation-key", ctxA);
    const b = providerFor("isolation-key", ctxB);
    expect(scryptSync).toHaveBeenCalledTimes(1);
    expect(a).not.toBe(b);
    const id = ProviderItemId.make("test");
    await Effect.runPromise(a.set!(id, "alice-value"));
    await Effect.runPromise(b.set!(id, "bob-value"));
    expect(putA).toHaveBeenCalledWith(expect.objectContaining({ owner: "user", key: "test" }));
    expect(putB).toHaveBeenCalledWith(expect.objectContaining({ owner: "user", key: "test" }));
    await Effect.runPromise(a.get(id));
    expect(getA).toHaveBeenCalledTimes(1);
    expect(getB).not.toHaveBeenCalled();
    await Effect.runPromise(b.get(id));
    expect(getB).toHaveBeenCalledTimes(1);
  });

  test("rotation preserves old providers and uses the new key for new providers", async () => {
    let payload = "";
    // oxlint-disable-next-line executor/no-double-cast -- boundary: this test uses only provider storage get and put
    const ctx = {
      owner: { tenant: "rotation", subject: "alice" },
      pluginStorage: {
        get: () => Effect.succeed({ data: payload }),
        put: ({ data }: { data: string }) =>
          Effect.sync(() => {
            payload = data;
          }),
      },
    } as unknown as PluginCtx<unknown>;
    const old = providerFor("rotation-old", ctx);
    const next = providerFor("rotation-new", ctx);
    const id = ProviderItemId.make("test");
    await Effect.runPromise(old.set!(id, "old-value"));
    expect(await Effect.runPromise(old.get(id))).toBe("old-value");
    expect(Exit.isFailure(await Effect.runPromiseExit(next.get(id)))).toBe(true);
    await Effect.runPromise(next.set!(id, "new-value"));
    expect(await Effect.runPromise(next.get(id))).toBe("new-value");
    expect(Exit.isFailure(await Effect.runPromiseExit(old.get(id)))).toBe(true);
    expect(await Effect.runPromise(decryptSecret(deriveKey("rotation-new"), payload))).toBe(
      "new-value",
    );
    const legacy = await Effect.runPromise(encryptSecret(deriveKey("rotation-old"), "legacy"));
    payload = legacy;
    expect(await Effect.runPromise(old.get(id))).toBe("legacy");
  });
});
