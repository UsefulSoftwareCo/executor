import { beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
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
}));

vi.mock("@1password/op-js", () => ({
  setGlobalFlags: opMocks.setGlobalFlags,
  setServiceAccount: opMocks.setServiceAccount,
  vault: { list: opMocks.vaultList },
  item: { list: opMocks.itemList },
  read: { parse: opMocks.readParse },
}));

vi.mock("@1password/sdk", () => ({
  createClient: sdkMocks.createClient,
  DesktopAuth: sdkMocks.DesktopAuth,
}));

describe("makeOnePasswordService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    opMocks.vaultList.mockReturnValue([]);
    opMocks.itemList.mockReturnValue([]);
    opMocks.readParse.mockReturnValue("secret");
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
        throw new Error("spawn op ENOENT");
      });
      sdkMocks.createClient.mockResolvedValue({
        secrets: { resolve: vi.fn(async () => "secret") },
        vaults: {
          list: vi.fn(async () => {
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
      expect(error.message).toContain("1Password SDK vault listing failed:");
      expect(error.message).toContain("desktop approval refused for account");
      expect(error.message).not.toBe("1Password CLI vault listing failed");
    }),
  );
});
