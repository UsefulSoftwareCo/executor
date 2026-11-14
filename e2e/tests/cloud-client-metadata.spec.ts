/**
 * A deployed stage names the OAuth client metadata document on its edge (standing in for
 * `executor.sh`) as its client ID, and that document lists the edge's callback, on its own
 * origin. The deployment origin (`v2.executor.sh`) and `app.` keep serving the document they
 * published before the move, unchanged: grants issued to it renew with its URL as their client ID,
 * and an authorization server may fetch it again.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const Document = Schema.fromJsonString(
  Schema.Struct({
    client_id: Schema.String,
    client_uri: Schema.String,
    logo_uri: Schema.String,
    redirect_uris: Schema.Array(Schema.String),
    token_endpoint_auth_method: Schema.String,
    application_type: Schema.String,
  }),
);
const path = "/oauth/client-metadata.json";

/**
 * The document at `origin`, which must name itself and list `origin`'s callback. Its logo must
 * be an image on `origin`: authorization servers show it on their consent page, and the edge
 * answers paths it does not serve with something else.
 */
const documentAt = (at: string, origin: string) =>
  Effect.gen(function* () {
    const response = yield* rawRequest(`${at}${path}`);
    expect(response.status, `${at}${path}`).toBe(200);
    expect(response.contentType, `${at}${path}`).toContain("application/json");
    const document = yield* Schema.decodeUnknownEffect(Document)(response.text);
    expect(document, `${at}${path}`).toEqual({
      client_id: `${origin}${path}`,
      client_uri: origin,
      logo_uri: `${origin}/favicon.png`,
      redirect_uris: [`${origin}/api/oauth/callback`],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
    const logo = yield* rawRequest(document.logo_uri);
    expect(logo.status, document.logo_uri).toBe(200);
    expect(logo.contentType, document.logo_uri).toBe("image/png");
  });

layer(HostedLive, { excludeTestServices: true })("Cloud client metadata document", (it) => {
  it.effect(scenarios.cloudClientMetadataEdge.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        expect(hosts.edge).not.toBe(hosts.deployment);
        // The document sign-ins start with: on the edge, listing the edge's callback.
        yield* documentAt(hosts.edge, hosts.edge);
        // The document earlier grants were issued to, on the deployment origin and `app.`.
        yield* documentAt(hosts.deployment, hosts.deployment);
        yield* documentAt(hosts.browser, hosts.deployment);
      }),
    ),
  );
});
