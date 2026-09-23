/** Disposable external identity provider for the real Cloud SSO journeys. */
import { createServer } from "node:http";
import { generateKeyPairSync, createHash, randomUUID, sign } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import samlify from "samlify";
import { Config, Deferred, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

const Control = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+@[a-z0-9.-]+$/)),
  mode: Schema.Literals(["valid", "tamper", "wrong-audience"]),
});
const { IdentityProvider, ServiceProvider, SamlLib } = samlify;
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value);
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const command = Command.make("sso-idp", {
  directory: Flag.String("directory"),
  application: Flag.String("application"),
}).pipe(
  Command.withHandler(({ directory, application }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const address = yield* Deferred.make<string>();
        const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const certificateDirectory = yield* fs.makeTempDirectoryScoped();
        const keyFile = `${certificateDirectory}/key.pem`,
          certFile = `${certificateDirectory}/cert.pem`;
        const generated = yield* processes.exitCode(
          ChildProcess.make(
            "openssl",
            [
              "req",
              "-x509",
              "-newkey",
              "rsa:2048",
              "-nodes",
              "-keyout",
              keyFile,
              "-out",
              certFile,
              "-days",
              "1",
              "-subj",
              "/CN=Executor synthetic SAML fixture",
              "-sha256",
            ],
            { stdout: "ignore", stderr: "ignore" },
          ),
        );
        if (generated !== 0) return yield* Effect.die("Cannot create synthetic SAML certificate");
        const privateKey = Redacted.make(yield* fs.readFileString(keyFile));
        const certificate = yield* fs.readFileString(certFile);
        let control: typeof Control.Type = { email: "oidc-user@sso.example.test", mode: "valid" };
        let lastSaml: { response: string; relay: string; acs: string } | undefined;
        const codes = new Map<
          string,
          {
            redirect: string;
            nonce: string | undefined;
            challenge: string;
            identity: typeof Control.Type;
          }
        >();
        const idp = (origin: string) =>
          IdentityProvider({
            entityID: `${origin}/saml`,
            privateKey: Redacted.value(privateKey),
            signingCert: certificate,
            singleSignOnService: [
              {
                Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
                Location: `${origin}/saml/login`,
              },
            ],
            nameIDFormat: ["urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"],
          });
        const routes = Layer.mergeAll(
          HttpRouter.add(
            "POST",
            "/control",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              control = yield* request.json.pipe(Effect.flatMap((value) => decode(Control, value)));
              return yield* HttpServerResponse.json({ success: true });
            }),
          ),
          HttpRouter.add(
            "GET",
            "/.well-known/openid-configuration",
            Effect.gen(function* () {
              const origin = yield* Deferred.await(address);
              return yield* HttpServerResponse.json({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                jwks_uri: `${origin}/jwks`,
                response_types_supported: ["code"],
                subject_types_supported: ["public"],
                id_token_signing_alg_values_supported: ["RS256"],
                token_endpoint_auth_methods_supported: ["client_secret_basic"],
                code_challenge_methods_supported: ["S256"],
              });
            }),
          ),
          HttpRouter.add(
            "GET",
            "/jwks",
            HttpServerResponse.json({
              keys: [
                {
                  ...keys.publicKey.export({ format: "jwk" }),
                  kid: "synthetic",
                  use: "sig",
                  alg: "RS256",
                },
              ],
            }),
          ),
          HttpRouter.add(
            "GET",
            "/authorize",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const url = new URL(request.url, yield* Deferred.await(address));
              const query = yield* decode(
                Schema.Struct({
                  redirect_uri: Schema.String,
                  state: Schema.String,
                  nonce: Schema.optionalKey(Schema.String),
                  code_challenge: Schema.String,
                  code_challenge_method: Schema.Literal("S256"),
                  client_id: Schema.Literal("synthetic-sso-client"),
                }),
                Object.fromEntries(url.searchParams),
              );
              const redirect = new URL(query.redirect_uri);
              if (redirect.origin !== application) return HttpServerResponse.empty({ status: 400 });
              const code = randomUUID();
              codes.set(code, {
                redirect: query.redirect_uri,
                nonce: query.nonce,
                challenge: query.code_challenge,
                identity: control,
              });
              redirect.searchParams.set("code", code);
              redirect.searchParams.set("state", query.state);
              return HttpServerResponse.redirect(redirect.toString());
            }),
          ),
          HttpRouter.add(
            "POST",
            "/token",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const form = new URLSearchParams(yield* request.text);
              const input = yield* decode(
                Schema.Struct({
                  code: Schema.String,
                  code_verifier: Schema.String,
                  redirect_uri: Schema.String,
                }),
                Object.fromEntries(form),
              );
              const code = codes.get(input.code);
              codes.delete(input.code);
              if (
                !code ||
                code.redirect !== input.redirect_uri ||
                code.challenge !==
                  createHash("sha256").update(input.code_verifier).digest("base64url") ||
                request.headers.authorization !==
                  `Basic ${Buffer.from("synthetic-sso-client:synthetic-sso-secret").toString("base64")}`
              )
                return HttpServerResponse.empty({ status: 401 });
              const origin = yield* Deferred.await(address);
              const now = Math.floor(Date.now() / 1000);
              const header = Buffer.from(
                JSON.stringify({ alg: "RS256", kid: "synthetic", typ: "JWT" }),
              ).toString("base64url");
              const payload = Buffer.from(
                JSON.stringify({
                  iss: origin,
                  aud:
                    code.identity.mode === "wrong-audience"
                      ? "another-client"
                      : "synthetic-sso-client",
                  sub: code.identity.email,
                  email: code.identity.email,
                  email_verified: true,
                  name: "Synthetic SSO Member",
                  nonce: code.nonce,
                  iat: now,
                  exp: now + 300,
                }),
              ).toString("base64url");
              const signed = `${header}.${payload}`;
              const signature = sign("RSA-SHA256", Buffer.from(signed), keys.privateKey).toString(
                "base64url",
              );
              return yield* HttpServerResponse.json({
                access_token: "synthetic-access-token",
                token_type: "Bearer",
                expires_in: 300,
                id_token: `${signed}.${code.identity.mode === "tamper" ? signature.slice(1) : signature}`,
              });
            }),
          ),
          HttpRouter.add(
            "GET",
            "/saml/metadata",
            Effect.gen(function* () {
              return HttpServerResponse.text(idp(yield* Deferred.await(address)).getMetadata(), {
                contentType: "application/xml",
              });
            }),
          ),
          HttpRouter.add(
            "GET",
            "/saml/login",
            Effect.gen(function* () {
              const origin = yield* Deferred.await(address);
              const request = yield* HttpServerRequest.HttpServerRequest;
              const query = yield* decode(
                Schema.Struct({ SAMLRequest: Schema.String, RelayState: Schema.String }),
                Object.fromEntries(new URL(request.url, origin).searchParams),
              );
              const xml = inflateRawSync(Buffer.from(query.SAMLRequest, "base64")).toString();
              const id = yield* decode(Schema.NonEmptyString, /\bID="([^"]+)"/.exec(xml)?.[1]);
              const acs = yield* decode(
                Schema.NonEmptyString,
                /AssertionConsumerServiceURL="([^"]+)"/.exec(xml)?.[1],
              );
              const entity = yield* decode(
                Schema.NonEmptyString,
                /<(?:\w+:)?Issuer[^>]*>([^<]+)</.exec(xml)?.[1]?.replaceAll("&amp;", "&"),
              );
              if (new URL(acs).origin !== application)
                return HttpServerResponse.empty({ status: 400 });
              const sp = ServiceProvider({
                entityID: control.mode === "wrong-audience" ? "https://another.example/sp" : entity,
                wantAssertionsSigned: true,
                assertionConsumerService: [
                  { Binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST", Location: acs },
                ],
              });
              const result = yield* Effect.promise(() =>
                idp(origin).createLoginResponse(
                  sp,
                  { extract: { request: { id } } },
                  "post",
                  { email: control.email },
                  {
                    relayState: query.RelayState,
                    customTagReplacement: (template) => {
                      const responseId = `_${randomUUID()}`;
                      const now = new Date().toISOString();
                      const expires = new Date(Date.now() + 300_000).toISOString();
                      return {
                        id: responseId,
                        context: SamlLib.replaceTagsByValue(
                          template.replace(
                            "{AttributeStatement}",
                            '<saml:AttributeStatement><saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><saml:AttributeValue>{Email}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>',
                          ),
                          {
                            ID: responseId,
                            AssertionID: `_${randomUUID()}`,
                            Destination: acs,
                            Audience: sp.entityMeta.getEntityID(),
                            SubjectRecipient: acs,
                            Issuer: `${origin}/saml`,
                            IssueInstant: now,
                            StatusCode: "urn:oasis:names:tc:SAML:2.0:status:Success",
                            ConditionsNotBefore: now,
                            ConditionsNotOnOrAfter: expires,
                            SubjectConfirmationDataNotOnOrAfter: expires,
                            NameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
                            NameID: createHash("sha256").update(control.email).digest("hex"),
                            InResponseTo: id,
                            AuthnStatement: "",
                            // Entra commonly uses an opaque NameID and a signed email claim.
                            Email: control.email,
                          },
                        ),
                      };
                    },
                  },
                ),
              );
              const response =
                control.mode === "tamper"
                  ? Buffer.from(
                      Buffer.from(result.context, "base64")
                        .toString()
                        .replaceAll(control.email, "tampered@sso.example.test"),
                    ).toString("base64")
                  : result.context;
              lastSaml = { response, relay: query.RelayState, acs };
              return HttpServerResponse.html(
                `<form method="post" action="${escape(acs)}"><input type="hidden" name="SAMLResponse" value="${escape(response)}"><input type="hidden" name="RelayState" value="${escape(query.RelayState)}"><button>Continue to Executor</button></form>`,
              );
            }),
          ),
          HttpRouter.add(
            "GET",
            "/saml/replay",
            Effect.gen(function* () {
              if (!lastSaml) return HttpServerResponse.empty({ status: 404 });
              return HttpServerResponse.html(
                `<form method="post" action="${escape(lastSaml.acs)}"><input type="hidden" name="SAMLResponse" value="${escape(lastSaml.response)}"><input type="hidden" name="RelayState" value="${escape(lastSaml.relay)}"><button>Replay assertion</button></form>`,
              );
            }),
          ),
        );
        const services = yield* Layer.build(
          HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
          ),
        );
        const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
        if (!("port" in server.address))
          return yield* Effect.die("Expected a loopback TCP listener");
        const origin = `http://127.0.0.1:${server.address.port}`;
        yield* Deferred.succeed(address, origin);
        yield* fs.writeFileString(`${directory}/sso-idp.json`, JSON.stringify({ origin }), {
          mode: 0o600,
        });
        yield* Effect.never;
      }),
    ),
  ),
);
NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
