import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "@effect/vitest";
import { Effect } from "effect";

import { serveOAuthTestServer } from "@executor-js/sdk/testing";

// Config reads the environment, so set the knob (and allow the loopback test
// AS through the hosted HTTP client) before importing the app graph.
process.env.EXECUTOR_DATA_DIR = mkdtempSync(join(tmpdir(), "eh-cimd-"));
process.env.EXECUTOR_OAUTH_CIMD_ENABLED = "false";
process.env.EXECUTOR_ALLOW_LOCAL_NETWORK = "true";

let handler!: (request: Request) => Promise<Response>;
let dispose: () => Promise<void> = async () => {};

beforeAll(async () => {
  const { makeSelfHostTestApp, singleAdminIdentityLayer } = await import("./testing/test-app");
  const app = await makeSelfHostTestApp({
    identity: singleAdminIdentityLayer({
      userId: "admin",
      organizationId: "default-org",
      organizationName: "Default",
    }),
  });
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(() => dispose());

test("POST /api/oauth/probe hides CIMD when the deployment cannot serve the document", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          clientIdMetadataDocumentSupported: true,
        });
        const res = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/api/oauth/probe", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url: server.mcpResourceUrl }),
            }),
          ),
        );
        expect(res.status).toBe(200);
        const body = yield* Effect.promise(() => res.json());
        expect(body).toEqual(
          expect.objectContaining({
            clientIdMetadataDocumentSupported: false,
            registrationEndpoint: server.registrationEndpoint,
          }),
        );
      }),
    ),
  );
});
