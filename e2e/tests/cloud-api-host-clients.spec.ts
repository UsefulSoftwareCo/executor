/**
 * Released clients default to Cloud's API host (`api.executor.sh`): the SDK reads the public app
 * registry there, and the CLI finds sign-in from it by RFC 9728 and RFC 8414 discovery, because
 * the authorization endpoints are on the browser origin and the issuer on the edge. Git remotes
 * are on the edge (`executor.sh/git/...`), not the API host, so the CLI prints the edge's remote,
 * and its credential helper answers for the edge and the deployment origin with the session
 * signed in at the API host. `app-git-remotes.spec.ts` clones and pushes through them.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsCli } from "../support/apps-cli.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { McpConsent } from "../support/mcp-consent.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const Resource = Schema.fromJsonString(
  Schema.Struct({ resource: Schema.String, authorization_servers: Schema.Array(Schema.String) }),
);
const Metadata = Schema.fromJsonString(
  Schema.Struct({
    issuer: Schema.String,
    authorization_endpoint: Schema.String,
    token_endpoint: Schema.String,
    registration_endpoint: Schema.String,
  }),
);
const Context = Schema.fromJsonString(
  Schema.Struct({ organization: Schema.String, gitOrigins: Schema.Array(Schema.String) }),
);

layer(HostedLive, { excludeTestServices: true })("Cloud API host clients", (it) => {
  it.effect(scenarios.cloudApiHostClients.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const api = yield* Api,
          actors = yield* Actors;
        // The SDK's default registry.
        const registry = yield* rawRequest(`${hosts.api}/api/registry/apps`);
        expect(registry.status).toBe(200);
        expect(Array.isArray(JSON.parse(registry.text))).toBe(true);
        // The CLI's discovery, from the API host to the endpoints it signs in with.
        const resource = yield* Schema.decodeUnknownEffect(Resource)(
          (yield* rawRequest(`${hosts.api}/.well-known/oauth-protected-resource/api`)).text,
        );
        expect(resource.resource).toBe(`${hosts.api}/api`);
        const issuer = new URL(resource.authorization_servers[0] ?? "");
        expect(issuer.href).toBe(`${hosts.edge}/api/auth`);
        const metadata = yield* Schema.decodeUnknownEffect(Metadata)(
          (yield* rawRequest(
            `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`,
          )).text,
        );
        expect(metadata).toEqual({
          issuer: issuer.href,
          authorization_endpoint: `${hosts.browser}/api/auth/oauth2/authorize`,
          token_endpoint: `${hosts.browser}/api/auth/oauth2/token`,
          registration_endpoint: `${hosts.browser}/api/auth/oauth2/register`,
        });

        // The CLI signs in at the API host, which names the edge and then the deployment origin
        // as where its Git remotes live.
        const tools = yield* appsCli;
        const login = yield* tools.login(hosts.api);
        expect(login.url.origin + login.url.pathname).toBe(metadata.authorization_endpoint);
        expect(login.finished.code, login.finished.stderr).toBe(0);
        expect(login.finished.stdout).toContain(`Connected to ${hosts.api} as @`);

        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const created = yield* api.request(actors.owner, "POST", prefix, {
          name: `Git remote ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: 'export default "remote";' }],
        });
        expect(created.status).toBe(200);
        const app = yield* body(Schema.Struct({ id: Schema.String, slug: Schema.String }), created);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const path = `/git/${actors.organization.id}/${app.slug}.git`;

        // The API and the CLI name the edge's remote, though the CLI called the API host.
        expect(
          yield* body(
            Schema.Struct({ path: Schema.String, url: Schema.String }),
            yield* api.request(actors.owner, "GET", `${prefix}/${app.id}/git`),
          ),
        ).toEqual({ path, url: `${hosts.edge}${path}` });
        const printed = yield* tools.cli(["git", "--host", hosts.api, "--app", app.id]);
        expect(printed.code, printed.stderr).toBe(0);
        expect(printed.stdout.trim()).toBe(`${hosts.edge}${path}`);

        // Git asks the helper for each remote's origin. The session signed in at the API host
        // answers for the edge and the deployment origin, and never for another origin.
        const credential = (origin: string) =>
          tools
            .git(
              ["credential", "fill"],
              `protocol=${new URL(origin).protocol.slice(0, -1)}\nhost=${new URL(origin).host}\npath=${path.slice(1)}\n\n`,
            )
            .pipe(
              Effect.map(({ code, stdout }) =>
                code === 0
                  ? stdout
                      .split("\n")
                      .find((line) => line.startsWith("password="))
                      ?.slice("password=".length)
                  : undefined,
              ),
            );
        for (const origin of [hosts.edge, hosts.deployment]) {
          const password = yield* credential(origin);
          expect(password, origin).toBeDefined();
          const signedIn = yield* rawRequest(`${hosts.api}/api/context`, {
            headers: { authorization: `Bearer ${password}` },
          });
          expect(signedIn.status, origin).toBe(200);
          const context = yield* Schema.decodeUnknownEffect(Context)(signedIn.text);
          expect(context).toEqual({
            organization: actors.organization.id,
            gitOrigins: [hosts.edge, hosts.deployment],
          });
        }
        expect(yield* credential(hosts.browser)).toBeUndefined();
      }).pipe(Effect.provide(McpConsent.layer)),
    ),
  );
});
