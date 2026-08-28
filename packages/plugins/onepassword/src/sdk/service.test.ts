import { beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: vi.mock/vi.hoisted must come from vitest itself for mock hoisting to resolve
import { vi } from "vitest";

import { OnePasswordError } from "./errors";
import { makeOnePasswordService } from "./service";

const opMocks = vi.hoisted(() => ({
  setGlobalFlags: vi.fn(),
  setServiceAccount: vi.fn(),
  vaultList: vi.fn(),
  itemList: vi.fn(),
  readParse: vi.fn(),
}));

const sdkMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  DesktopAuth: vi.fn((accountName: string) => ({ accountName })),
  exports: {} as {
    createClient?: unknown;
    DesktopAuth?: unknown;
  },
}));

vi.mock("@1password/op-js", () => ({
  setGlobalFlags: opMocks.setGlobalFlags,
  setServiceAccount: opMocks.setServiceAccount,
  vault: { list: opMocks.vaultList },
  item: { list: opMocks.itemList },
  read: { parse: opMocks.readParse },
}));

vi.mock("@1password/sdk", () => sdkMocks.exports);

describe("makeOnePasswordService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    opMocks.vaultList.mockReturnValue([]);
    opMocks.itemList.mockReturnValue([]);
    opMocks.readParse.mockReturnValue("secret");
    sdkMocks.exports.createClient = sdkMocks.createClient;
    sdkMocks.exports.DesktopAuth = sdkMocks.DesktopAuth;
    sdkMocks.createClient.mockResolvedValue({
      secrets: { resolve: vi.fn(async () => "secret") },
      vaults: { list: vi.fn(async () => []) },
      items: { list: vi.fn(async () => []) },
    });
  });

  it.effect("falls back to the SDK when the CLI throws while listing vaults", () =>
    Effect.gen(function* () {
      const sdkVaultsList = vi.fn(async () => [{ id: "sdk-vault", title: "SDK Vault" }]);
      opMocks.vaultList.mockImplementation(() => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: simulates the untyped op-js CLI wrapper throwing
        throw new Error("spawn op ENOENT");
      });
      sdkMocks.createClient.mockResolvedValue({
        secrets: { resolve: vi.fn(async () => "secret") },
        vaults: { list: sdkVaultsList },
        items: { list: vi.fn(async () => []) },
      });

      const service = yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      );
      const vaults = yield* service.listVaults();

      expect(vaults).toEqual([{ id: "sdk-vault", title: "SDK Vault" }]);
      expect(sdkMocks.createClient).toHaveBeenCalledTimes(1);
      expect(sdkVaultsList).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("includes the backend cause when both vault listing backends fail", () =>
    Effect.gen(function* () {
      opMocks.vaultList.mockImplementation(() => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: simulates the untyped op-js CLI wrapper throwing
        throw new Error("spawn op ENOENT");
      });
      sdkMocks.createClient.mockResolvedValue({
        secrets: { resolve: vi.fn(async () => "secret") },
        vaults: {
          list: vi.fn(async () => {
            // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: simulates the untyped 1Password SDK rejecting
            throw new Error("desktop approval refused for account");
          }),
        },
        items: { list: vi.fn(async () => []) },
      });

      const error = yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      ).pipe(
        Effect.flatMap((service) => service.listVaults()),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(OnePasswordError);
      // oxlint-disable executor/no-unknown-error-message -- boundary: OnePasswordError carries a typed message; asserting its contents
      expect(error.message).toContain("1Password SDK vault listing failed:");
      expect(error.message).toContain("desktop approval refused for account");
      expect(error.message).not.toBe("1Password CLI vault listing failed");
      // oxlint-enable executor/no-unknown-error-message
    }),
  );

  it.effect("reports a clear SDK load error when the compiled namespace is empty", () =>
    Effect.gen(function* () {
      opMocks.vaultList.mockImplementation(() => {
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: simulates the untyped op-js CLI wrapper throwing
        throw new Error("spawn op ENOENT");
      });
      sdkMocks.exports.createClient = undefined;
      sdkMocks.exports.DesktopAuth = undefined;

      const error = yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      ).pipe(
        Effect.flatMap((service) => service.listVaults()),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(OnePasswordError);
      expect(error.operation).toBe("sdk module load");
      // oxlint-disable executor/no-unknown-error-message -- boundary: OnePasswordError carries a typed message; asserting its contents
      expect(error.message).toContain("did not expose createClient and DesktopAuth");
      expect(error.message).toContain("/opt/homebrew/bin");
      // oxlint-enable executor/no-unknown-error-message
    }),
  );

  // -------------------------------------------------------------------------
  // Service-account token lifetime.
  //
  // `op-js` parks the token on a process-global (`cli.serviceAccountToken`) and
  // reads it when spawning `op`. Nothing in the library clears it, so without
  // the `ensuring` in `makeCliService` a token set to serve one resolve stays
  // readable for the rest of the process's life.
  //
  // Both halves are pinned on purpose: clearing it is only correct if it is
  // still SET while the call runs. A change that cleared it too early would
  // pass a "no longer parked" assertion and silently break authentication.
  //
  // The "still set" half has to be observed from INSIDE the spawn: `op-js`
  // builds the child's env from the global at spawn time, and the mock's call
  // ledger cannot see the ordering between the token set and the spawn — a
  // clear hoisted before `fn()` leaves [token, "", ""], which keeps both
  // after-the-fact assertions green.
  // -------------------------------------------------------------------------

  it.effect("clears the service-account token from the op-js global after a CLI call", () =>
    Effect.gen(function* () {
      let tokenAtSpawn: unknown;
      opMocks.readParse.mockImplementation(() => {
        tokenAtSpawn = opMocks.setServiceAccount.mock.lastCall?.[0];
        return "resolved-secret";
      });

      const service = yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      );
      const secret = yield* service.resolveSecret("op://vault/item/field");

      expect(secret).toBe("resolved-secret");
      // Still set while the spawn ran — clearing any earlier would break auth...
      expect(tokenAtSpawn).toBe("ops_test_token");
      // ...and gone by the time the call is over.
      expect(opMocks.setServiceAccount).toHaveBeenLastCalledWith("");
    }),
  );

  it.effect("clears the token even when the CLI call fails", () =>
    Effect.gen(function* () {
      // The failure path is the one that matters most: an error unwinding past a
      // manual "clear it afterwards" line is exactly how a token gets stranded.
      let tokenAtSpawn: unknown;
      opMocks.readParse.mockImplementation(() => {
        tokenAtSpawn = opMocks.setServiceAccount.mock.lastCall?.[0];
        // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: simulates the untyped op-js CLI wrapper throwing
        throw new Error("spawn op ENOENT");
      });
      sdkMocks.createClient.mockResolvedValue({
        secrets: {
          resolve: vi.fn(async () => {
            // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: simulates the untyped 1Password SDK rejecting
            throw new Error("sdk unavailable");
          }),
        },
        vaults: { list: vi.fn(async () => []) },
        items: { list: vi.fn(async () => []) },
      });

      yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      ).pipe(
        Effect.flatMap((service) => service.resolveSecret("op://vault/item/field")),
        Effect.flip,
      );

      expect(tokenAtSpawn).toBe("ops_test_token");
      expect(opMocks.setServiceAccount).toHaveBeenLastCalledWith("");
    }),
  );
});
