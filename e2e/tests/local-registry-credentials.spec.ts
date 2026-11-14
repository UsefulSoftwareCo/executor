/**
 * An operator's npm registry URL can carry credentials in its userinfo and a token in its query.
 * When a dependency fails to install, the deployer reads why, with the registry's host and path,
 * but the deployer is not always the operator: the failure never shows the userinfo or the query.
 * A token written into the URL's path is not removed and does reach the deployer: it cannot be told
 * from an ordinary path.
 */
import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { withApps } from "../support/apps-release.ts";
import { TestLive, withCase } from "../support/case.ts";
import { credentialedRegistry } from "../support/credentialed-registry.ts";
import { startLocalProduct } from "../support/local-workflow-engines.ts";
import { scenarios } from "../test-plan.ts";

const BuildFailed = Schema.Struct({
  _tag: Schema.Literal("VersionBuildFailed"),
  stage: Schema.String,
  message: Schema.String,
});

/** A package the suite's registry does not serve, so installing it fails with the registry's 404. */
const missingPackage = "@executor-fixture/missing-package";

layer(TestLive, { excludeTestServices: true })("Local registry credentials", (it) => {
  it.effect(
    scenarios.localRegistryCredentials.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const registry = yield* credentialedRegistry;
          const local = yield* startLocalProduct({ EXECUTOR_NPM_REGISTRY: registry.url });
          const deployed = yield* local.request("POST", "/v1/apps/deploy", {
            owner: "registry-credentials-e2e",
            name: `Registry credentials ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, query, object, router } from "apps";
import missing from "${missingPackage}";
export default defineApp({}, { tools: router({
  missing: query({ input: object({}) }, async () => String(missing)),
}) });`,
              },
              {
                path: "package.json",
                content: JSON.stringify({
                  type: "module",
                  dependencies: withApps({ [missingPackage]: "1.0.0" }),
                }),
              },
            ],
          });
          expect(deployed.status, deployed.text).toBe(422);
          const failed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BuildFailed))(
            deployed.text,
          );
          for (const secret of registry.secrets)
            expect(deployed.text, "the failure omits the registry's credentials").not.toContain(
              secret,
            );
          // The installer's failure reaches the deployer through the bundler's import resolution.
          expect(failed.stage).toBe("compile");
          // Still useful: it names the package and the registry's host and path.
          expect(failed.message).toContain(`Installing ${missingPackage}@1.0.0 failed`);
          expect(failed.message).toContain(registry.location);
        }),
      ),
    120_000,
  );
});
