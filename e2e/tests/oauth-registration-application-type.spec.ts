/**
 * MCP clients register under RFC 7591, which has no `application_type`. A registration that omits
 * it is a native client when a callback is an RFC 8252 loopback or private-use one, and every
 * callback it names is then held to the native rules. Any other registration is a web client.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";

const Registered = Schema.Struct({
  client_id: Schema.NonEmptyString,
  application_type: Schema.Literals(["web", "native"]),
  redirect_uris: Schema.Array(Schema.String),
});
const Refused = Schema.Struct({ error: Schema.String, error_description: Schema.String });

/** Register a public client anonymously, as an MCP client does. */
const register = (redirectUris: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const origin = target.metadata.origin;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const request = yield* HttpClientRequest.post(`${origin}/api/auth/oauth2/register`).pipe(
          HttpClientRequest.setHeaders({ origin }),
          HttpClientRequest.bodyJson({
            client_name: "Registration fixture",
            redirect_uris: redirectUris,
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          }),
        );
        const response = yield* http.execute(request);
        return { status: response.status, body: yield* response.json };
      }),
    );
  });

const registered = (redirectUris: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { status, body } = yield* register(redirectUris);
    expect(status).toBe(201);
    return yield* Schema.decodeUnknownEffect(Registered)(body);
  });

const refused = (redirectUris: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { status, body } = yield* register(redirectUris);
    expect(status).toBe(400);
    return yield* Schema.decodeUnknownEffect(Refused)(body);
  });

const web = "https://client.example.test/oauth/callback";
const loopback = "http://localhost:8787/callback";
const privateUse = "cursor://anysphere.cursor-mcp/oauth/callback";

layer(TestLive, { excludeTestServices: true })("OAuth registration application type", (it) => {
  it.effect(scenarios.oauthRegistrationApplicationType.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        // A web callback beside a loopback one, as Cursor registers, is one native client with both.
        const both = yield* registered([web, loopback]);
        expect(both.application_type).toBe("native");
        expect(both.redirect_uris).toEqual([web, loopback]);

        expect((yield* registered([privateUse])).application_type).toBe("native");
        expect((yield* registered(["http://127.0.0.1:43123/callback"])).application_type).toBe(
          "native",
        );
        expect((yield* registered([web])).application_type).toBe("web");

        // Plain HTTP off the loopback host is refused whatever the client's type, and the refusal
        // names the callback that broke the rule.
        const cleartext = "http://client.example.test/callback";
        const mixed = yield* refused([loopback, cleartext]);
        expect(mixed.error).toBe("invalid_redirect_uri");
        expect(mixed.error_description).toBe(
          `native clients may use http only on the exact loopback hosts localhost, 127.0.0.1, or [::1]: ${cleartext}`,
        );

        // Without a loopback or private-use callback the client is a web client, which may not
        // use a loopback host even over HTTPS.
        const httpsLoopback = "https://localhost:8443/callback";
        const plain = yield* refused([httpsLoopback]);
        expect(plain.error).toBe("invalid_redirect_uri");
        expect(plain.error_description).toBe(
          `web clients require https redirect URIs on non-loopback hosts: ${httpsLoopback}`,
        );
      }),
    ),
  );
});
