/** Explicit owned lab composition; never imported by the production entrypoint. */
import { readFile } from "node:fs/promises";
import { ConfigProvider, Effect, Redacted } from "effect";
import type { PrivateInvocationVerifier } from "@executor-js/sdk/core";
import { nodePrivateInvocationIssuer } from "@executor-js/sdk/node";
import { SelfHostPrivateInvocation } from "../src/mcp.ts";
import { main } from "../src/main.ts";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { lockedNpmRegistry } from "../../../../e2e/support/npm-registry.ts";

const file = process.argv[2];
if (!file) throw new Error("Protected development composition file required");
const config: {
  namespace: string;
  redeemUrl: string;
  forwardUrl: string;
  allowedBindingsFile: string;
  certificate: string;
  privateKey: string;
  certificateAuthority: string;
} = JSON.parse(await readFile(file, "utf8"));
BunRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      type Registered = {
        recipientPrincipal: string;
        appId: string;
        buildId: string;
        toolPath: string;
        accountsDigest: string;
        bindingId: string;
      };
      // Fixed operator registry is loaded before any request. Catalog/model input cannot register trust.
      const registered = yield* Effect.promise(async (): Promise<Registered[]> =>
        JSON.parse(await readFile(config.allowedBindingsFile, "utf8")),
      );
      const tls = yield* Effect.promise(async () => ({
        certificate: Redacted.make(await readFile(config.certificate, "utf8")),
        privateKey: Redacted.make(await readFile(config.privateKey, "utf8")),
        certificateAuthority: Redacted.make(await readFile(config.certificateAuthority, "utf8")),
      }));
      const issuers = new Map<string, ReturnType<typeof nodePrivateInvocationIssuer>>();
      for (const entry of registered) {
        if (issuers.has(entry.bindingId)) continue;
        const issuer = yield* Effect.acquireRelease(
          Effect.sync(() =>
            nodePrivateInvocationIssuer(
              {
                namespace: config.namespace,
                redeemUrl: config.redeemUrl,
                forwardUrl: config.forwardUrl,
                bindingId: entry.bindingId,
              },
              tls,
            ),
          ),
          (owned) => Effect.sync(owned.close),
        );
        issuers.set(entry.bindingId, issuer);
      }
      const verifier: PrivateInvocationVerifier = {
        namespace: config.namespace,
        redeem: (reference, binding, signal) => {
          const entry = registered.find(
            (entry) =>
              entry.recipientPrincipal === binding.recipientPrincipal &&
              entry.appId === binding.appId &&
              entry.buildId === binding.buildId &&
              entry.toolPath === binding.toolPath &&
              entry.accountsDigest === binding.accountsDigest,
          );
          const issuer = entry === undefined ? undefined : issuers.get(entry.bindingId);
          if (!issuer) return Promise.reject(new Error("No fixed development recipient binding"));
          return issuer.verifier.redeem(reference, binding, signal);
        },
      };
      // Reuse the E2E package registry: real candidate archive + pinned transitive archives.
      // It supplies packages only; product authentication and effects remain real.
      const registry = yield* lockedNpmRegistry;
      const base = yield* ConfigProvider.ConfigProvider;
      return yield* main.pipe(
        Effect.provideService(SelfHostPrivateInvocation, verifier),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ EXECUTOR_NPM_REGISTRY: registry.url }).pipe(
            ConfigProvider.orElse(base),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
