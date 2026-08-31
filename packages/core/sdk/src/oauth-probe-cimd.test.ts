import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeTestWorkspaceHarness, memoryCredentialsPlugin } from "./test-config";
import { serveOAuthTestServer } from "./testing/oauth-test-server";

// `oauth.probe` reports Client ID Metadata Document support as discovered, but a
// host can suppress it (`oauthDisableClientIdMetadataDocuments`): a CIMD
// `client_id` is a URL on the deployment itself that the provider's
// authorization server must fetch, which a host on a private network can never
// serve. With the flag set the probe reports CIMD unsupported while still
// surfacing the registration endpoint, so automatic connect flows take the DCR
// arm instead of starting a CIMD authorization the provider rejects as
// `invalid_client`.

const plugins = [memoryCredentialsPlugin()] as const;

describe("oauth.probe CIMD suppression", () => {
  it.effect("reports discovered CIMD support by default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["read"],
          clientIdMetadataDocumentSupported: true,
        });
        const { executor } = yield* makeTestWorkspaceHarness({ plugins });

        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });
        expect(probe.clientIdMetadataDocumentSupported).toBe(true);
        expect(probe.registrationEndpoint).toBe(server.registrationEndpoint);
      }),
    ),
  );

  it.effect("oauthDisableClientIdMetadataDocuments suppresses CIMD, keeps DCR discoverable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveOAuthTestServer({
          scopes: ["read"],
          clientIdMetadataDocumentSupported: true,
        });
        const { executor } = yield* makeTestWorkspaceHarness({
          plugins,
          oauthDisableClientIdMetadataDocuments: true,
        });

        const probe = yield* executor.oauth.probe({ url: server.mcpResourceUrl });
        expect(probe.clientIdMetadataDocumentSupported).toBe(false);
        // The registration endpoint still surfaces, so the automatic connect
        // flow falls through to dynamic client registration.
        expect(probe.registrationEndpoint).toBe(server.registrationEndpoint);
      }),
    ),
  );
});
