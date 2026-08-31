import { beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
// oxlint-disable-next-line executor/no-vitest-import -- boundary: vi.mock/vi.hoisted must come from vitest itself for mock hoisting to resolve
import { vi } from "vitest";

import { OnePasswordError } from "./errors";
import type { OpCliInvocation, OpCliResult } from "./op-cli";
import { makeOnePasswordService } from "./service";

const opMocks = vi.hoisted(() => ({
  opCliExec: vi.fn<(invocation: OpCliInvocation) => Promise<OpCliResult>>(),
}));

const sdkMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  DesktopAuth: vi.fn((accountName: string) => ({ accountName })),
  exports: {} as {
    createClient?: unknown;
    DesktopAuth?: unknown;
  },
}));

vi.mock("./op-cli", () => ({
  opCliExec: opMocks.opCliExec,
}));

vi.mock("@1password/sdk", () => sdkMocks.exports);

/** A failed spawn: op-cli always resolves, reporting failure as plain data. */
const cliFailure = (message: string, timedOut = false): OpCliResult => ({
  ok: false,
  timedOut,
  message,
});

const cliAnswers = (answer: (invocation: OpCliInvocation) => string) => {
  opMocks.opCliExec.mockImplementation((invocation) =>
    Promise.resolve({ ok: true, stdout: answer(invocation) }),
  );
};

describe("makeOnePasswordService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliAnswers((invocation) => {
      if (invocation.args[0] === "read") return "secret\n";
      return "[]";
    });
    sdkMocks.exports.createClient = sdkMocks.createClient;
    sdkMocks.exports.DesktopAuth = sdkMocks.DesktopAuth;
    sdkMocks.createClient.mockResolvedValue({
      secrets: { resolve: vi.fn(async () => "secret") },
      vaults: { list: vi.fn(async () => []) },
      items: { list: vi.fn(async () => []) },
    });
  });

  it.effect("resolves a secret via the CLI and strips the trailing newline", () =>
    Effect.gen(function* () {
      const service = yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      );
      const secret = yield* service.resolveSecret("op://vault/item/field");

      expect(secret).toBe("secret");
      const invocation = opMocks.opCliExec.mock.calls[0]?.[0];
      expect(invocation?.args).toEqual(["read", "op://vault/item/field"]);
      expect(invocation?.timeoutMs).toBe(1_000);
    }),
  );

  it.effect("passes the service-account token through the child environment only", () =>
    Effect.gen(function* () {
      const service = yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      );
      yield* service.resolveSecret("op://vault/item/field");

      const invocation = opMocks.opCliExec.mock.calls[0]?.[0];
      expect(invocation?.env["OP_SERVICE_ACCOUNT_TOKEN"]).toBe("ops_test_token");
      expect(invocation?.args.some((arg) => arg.includes("ops_test_token"))).toBe(false);
      expect(invocation?.args.some((arg) => arg.startsWith("--account"))).toBe(false);
    }),
  );

  it.effect("routes desktop-app auth through --account with no inherited token", () =>
    Effect.gen(function* () {
      process.env["OP_SERVICE_ACCOUNT_TOKEN"] = "ops_inherited_token";
      const service = yield* makeOnePasswordService(
        { kind: "desktop-app", accountName: "my.1password.com" },
        { timeoutMs: 1_000 },
      );
      yield* service.resolveSecret("op://vault/item/field");
      delete process.env["OP_SERVICE_ACCOUNT_TOKEN"];

      const invocation = opMocks.opCliExec.mock.calls[0]?.[0];
      expect(invocation?.args).toContain("--account=my.1password.com");
      // An inherited token would override --account and silently reroute the
      // call to the parent process's service account.
      expect(invocation?.env["OP_SERVICE_ACCOUNT_TOKEN"]).toBeUndefined();
    }),
  );

  it.effect("lists vaults through the CLI's JSON output", () =>
    Effect.gen(function* () {
      cliAnswers(() => JSON.stringify([{ id: "vault-1", name: "Personal", extra: "ignored" }]));

      const service = yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      );
      const vaults = yield* service.listVaults();

      expect(vaults).toEqual([{ id: "vault-1", title: "Personal" }]);
      const invocation = opMocks.opCliExec.mock.calls[0]?.[0];
      expect(invocation?.args).toEqual(["vault", "list", "--format=json"]);
    }),
  );

  it.effect("maps a killed-by-timeout spawn onto the troubleshooting message", () =>
    Effect.gen(function* () {
      opMocks.opCliExec.mockResolvedValue(cliFailure("", true));
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

      const error = yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      ).pipe(
        Effect.flatMap((service) => service.resolveSecret("op://vault/item/field")),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(OnePasswordError);
      // oxlint-disable executor/no-unknown-error-message -- boundary: OnePasswordError carries a typed message; asserting its contents
      expect(error.message).toContain("timed out after 1s");
      expect(error.message).toContain("1Password desktop app is open and unlocked");
      // oxlint-enable executor/no-unknown-error-message
    }),
  );

  it.effect("redacts a service-account token leaked into CLI stderr", () =>
    Effect.gen(function* () {
      opMocks.opCliExec.mockResolvedValue(cliFailure("[ERROR] token ops_test_token was rejected"));
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

      const error = yield* makeOnePasswordService(
        { kind: "service-account", token: "ops_test_token" },
        { timeoutMs: 1_000 },
      ).pipe(
        Effect.flatMap((service) => service.resolveSecret("op://vault/item/field")),
        Effect.flip,
      );

      // oxlint-disable executor/no-unknown-error-message -- boundary: OnePasswordError carries a typed message; asserting its contents
      expect(error.message).not.toContain("ops_test_token");
      expect(error.message).toContain("[redacted 1Password token]");
      // oxlint-enable executor/no-unknown-error-message
    }),
  );

  it.effect("falls back to the SDK when the CLI is not installed", () =>
    Effect.gen(function* () {
      const sdkVaultsList = vi.fn(async () => [{ id: "sdk-vault", title: "SDK Vault" }]);
      opMocks.opCliExec.mockResolvedValue(cliFailure("spawn op ENOENT"));
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
      opMocks.opCliExec.mockResolvedValue(cliFailure("spawn op ENOENT"));
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
      opMocks.opCliExec.mockResolvedValue(cliFailure("spawn op ENOENT"));
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
});
