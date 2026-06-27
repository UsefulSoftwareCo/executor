import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  readCloudflareAccessHealth,
  verifyCloudflareAccessEmulator,
} from "../src/cloudflare-access-emulator";
import { claimPorts } from "../src/ports";
import { bootProcesses, targetBootMode, waitForHttp } from "../setup/boot";
import { requiredCloudflareAccessAttachUrl } from "../setup/cloudflare.globalsetup";

const accessEmulator = fileURLToPath(
  new URL("../scripts/cloudflare-access-emulator.ts", import.meta.url),
);
const e2eDir = fileURLToPath(new URL("..", import.meta.url));
const bun = process.versions.bun ? process.execPath : (process.env.E2E_BUN_BIN ?? "bun");

const occupiedPort = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly port: number; readonly server: ReturnType<typeof createServer> }>(
        (resolve) => {
          const server = createServer();
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") return;
            resolve({ port: address.port, server });
          });
        },
      ),
  ),
  ({ server }) =>
    Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

describe("e2e boot mode and readiness", () => {
  it("selects attach mode only from an explicit validated URL", () => {
    expect(targetBootMode("E2E_FIXTURE_URL", {})).toEqual({ kind: "spawn" });
    expect(
      targetBootMode("E2E_FIXTURE_URL", {
        E2E_FIXTURE_URL: "https://executor.example.test/",
        E2E_FIXTURE_PORT: "49999",
      }),
    ).toEqual({ kind: "attach", url: "https://executor.example.test" });
    expect(() => targetBootMode("E2E_FIXTURE_URL", { E2E_FIXTURE_URL: "localhost:49999" })).toThrow(
      /http\(s\)/,
    );
  });

  it("requires a full Access issuer URL for Cloudflare attach mode", () => {
    expect(() =>
      requiredCloudflareAccessAttachUrl({ E2E_CLOUDFLARE_ACCESS_TOKEN: "static-only" }),
    ).toThrow(/requires E2E_CLOUDFLARE_ACCESS_URL/);
    expect(
      requiredCloudflareAccessAttachUrl({
        E2E_CLOUDFLARE_ACCESS_URL: "https://access.example.test/",
      }),
    ).toBe("https://access.example.test");
  });

  it.effect("rejects an occupied explicitly pinned spawn port", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const occupied = yield* occupiedPort;
        const envVar = `E2E_HARNESS_PINNED_${randomUUID().replaceAll("-", "")}`;
        process.env[envVar] = String(occupied.port);

        const result = yield* Effect.tryPromise({
          try: () => claimPorts([{ envVar, offset: 8, label: "occupied harness port" }]),
          catch: (cause) => cause,
        }).pipe(
          Effect.matchEffect({
            onFailure: (error) => Effect.succeed(String(error)),
            onSuccess: (claim) =>
              Effect.promise(() => claim.release()).pipe(Effect.as("unexpected success")),
          }),
          Effect.ensuring(Effect.sync(() => delete process.env[envVar])),
        );

        expect(result).toContain("is already listening");
        expect(result).toContain("use E2E_<TARGET>_URL for attach mode");
      }),
    ),
  );

  it.effect("fails readiness as soon as a spawned child exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const procs = yield* Effect.acquireRelease(
          Effect.sync(() =>
            bootProcesses(
              [
                {
                  cmd: process.execPath,
                  args: ["--eval", "setTimeout(() => process.exit(23), 20)"],
                  cwd: e2eDir,
                },
              ],
              { label: "early-exit-test" },
            ),
          ),
          (booted) => Effect.promise(() => booted.teardown()),
        );
        const neverReady = new Promise<void>(() => undefined);
        const error = yield* Effect.tryPromise({
          try: () => procs.waitUntilReady(neverReady),
          catch: (cause) => cause,
        }).pipe(Effect.flip);
        expect(String(error)).toContain("stopped before readiness");
        expect(String(error)).toContain("exit 23");
      }),
    ),
  );

  it.effect("identifies the exact Access emulator boot and proves its ledger", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const envVar = `E2E_HARNESS_ACCESS_${randomUUID().replaceAll("-", "")}`;
        const claim = yield* Effect.acquireRelease(
          Effect.promise(() =>
            claimPorts([{ envVar, offset: 8, label: "Access emulator contract test" }]),
          ),
          (claimed) => Effect.promise(() => claimed.release()),
        );
        const port = claim.ports[envVar]!;
        const nonce = randomUUID();
        const procs = yield* Effect.acquireRelease(
          Effect.sync(() =>
            bootProcesses(
              [
                {
                  cmd: bun,
                  args: [accessEmulator, "--port", String(port), "--boot-nonce", nonce],
                  cwd: e2eDir,
                },
              ],
              { label: "access-emulator-test" },
            ),
          ),
          (booted) => Effect.promise(() => booted.teardown()),
        );
        const baseUrl = `http://127.0.0.1:${port}`;
        yield* Effect.promise(() =>
          procs.waitUntilReady(waitForHttp(`${baseUrl}/health`, { expectedStatus: 200 })),
        );

        const health = yield* Effect.promise(() => readCloudflareAccessHealth(baseUrl));
        expect(health.bootNonce).toBe(nonce);
        const verified = yield* Effect.promise(() =>
          verifyCloudflareAccessEmulator(baseUrl, { expectedBootNonce: nonce }),
        );
        expect(verified.bootNonce).toBe(nonce);
        expect(verified.token.split(".")).toHaveLength(3);
      }),
    ),
  );
});
