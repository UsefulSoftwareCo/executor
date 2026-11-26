import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { generateKeyPairSync, createHash, randomUUID, sign, type KeyObject } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import samlify from "samlify";
import { Config, Deferred, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

const Control = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+@[a-z0-9.-]+$/u)),
  mode: Schema.Literals([
    "valid",
    "tamper",
    "wrong-audience",
    "userinfo-verified",
    "userinfo-other-subject",
    "discovery-redirect",
    "cleartext-authorization",
    "cleartext-token",
    "cleartext-jwks",
    "token-redirect",
    "jwks-redirect",
    "unverified",
    "unverified-thin",
    "unverified-absent",
  ]),
});
const thinModes: ReadonlySet<typeof Control.Type.mode> = new Set([
  "userinfo-verified",
  "userinfo-other-subject",
  "unverified-thin",
  "unverified-absent",
]);
const unverifiedModes: ReadonlySet<typeof Control.Type.mode> = new Set([
  "unverified",
  "unverified-thin",
  "unverified-absent",
]);
const { IdentityProvider, ServiceProvider, SamlLib } = samlify;
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value);
const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const jwks = (key: KeyObject, kid: string) => ({
  keys: [{ ...key.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }],
});
const signJwt = (key: KeyObject, kid: string, claims: Record<string, unknown>) => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString(
    "base64url",
  );
  const signed = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return { signed, signature: sign("RSA-SHA256", Buffer.from(signed), key).toString("base64url") };
};

const command = Command.make("sso-idp", {
  directory: Flag.String("directory"),
  application: Flag.String("application"),
  certificate: Flag.String("tls-certificate").pipe(Flag.optional),
  key: Flag.String("tls-key").pipe(Flag.optional),
}).pipe(
  Command.withHandler(({ directory, application, certificate: tlsCertificate, key: tlsKey }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Config.String("NODE_ENV").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literal("test"))),
        );
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const address = yield* Deferred.make<string>();
        const issuer = yield* Deferred.make<string>();
        const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const unpublished = generateKeyPairSync("rsa", { modulusLength: 2048 });
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
        const accessTokens = new Map<string, typeof Control.Type>();
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
        const routes = (listener: Effect.Effect<string>) =>
          Layer.mergeAll(
            HttpRouter.add(
              "POST",
              "/control",
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                control = yield* request.json.pipe(
                  Effect.flatMap((value) => decode(Control, value)),
                );
                return yield* HttpServerResponse.json({ success: true });
              }),
            ),
            HttpRouter.add(
              "GET",
              "/.well-known/openid-configuration",
              Effect.gen(function* () {
                const origin = yield* Deferred.await(issuer);
                const cleartextOrigin = yield* Deferred.await(address);
                const copied = control.mode === "discovery-redirect";
                if (copied && (yield* listener) === origin && origin !== cleartextOrigin)
                  return HttpServerResponse.redirect(
                    `${cleartextOrigin}/.well-known/openid-configuration`,
                  );
                const at = (path: string, cleartext: typeof Control.Type.mode) =>
                  `${control.mode === cleartext ? cleartextOrigin : origin}${path}`;
                return yield* HttpServerResponse.json({
                  issuer: origin,
                  authorization_endpoint: at("/authorize", "cleartext-authorization"),
                  token_endpoint: copied
                    ? `${origin}/unpublished/token`
                    : at("/token", "cleartext-token"),
                  userinfo_endpoint: `${origin}/userinfo`,
                  jwks_uri: copied ? `${origin}/unpublished/jwks` : at("/jwks", "cleartext-jwks"),
                  response_types_supported: ["code"],
                  subject_types_supported: ["public"],
                  id_token_signing_alg_values_supported: ["RS256"],
                  token_endpoint_auth_methods_supported: [
                    "client_secret_basic",
                    "client_secret_post",
                  ],
                  code_challenge_methods_supported: ["S256"],
                });
              }),
            ),
            HttpRouter.add(
              "GET",
              "/jwks",
              Effect.gen(function* () {
                const cleartextOrigin = yield* Deferred.await(address);
                if (control.mode === "jwks-redirect" && (yield* listener) !== cleartextOrigin)
                  return HttpServerResponse.redirect(`${cleartextOrigin}/jwks`);
                return yield* HttpServerResponse.json(jwks(keys.publicKey, "synthetic"));
              }),
            ),
            HttpRouter.add(
              "GET",
              "/unpublished/jwks",
              Effect.suspend(() =>
                HttpServerResponse.json(jwks(unpublished.publicKey, "unpublished")),
              ),
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
                if (redirect.origin !== application)
                  return HttpServerResponse.empty({ status: 400 });
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
                const cleartextOrigin = yield* Deferred.await(address);
                if (control.mode === "token-redirect" && (yield* listener) !== cleartextOrigin)
                  return HttpServerResponse.redirect(`${cleartextOrigin}/token`, { status: 307 });
                const request = yield* HttpServerRequest.HttpServerRequest;
                const form = new URLSearchParams(yield* request.text);
                const input = yield* decode(
                  Schema.Struct({
                    code: Schema.String,
                    code_verifier: Schema.String,
                    redirect_uri: Schema.String,
                    client_id: Schema.optionalKey(Schema.String),
                    client_secret: Schema.optionalKey(Schema.String),
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
                  (request.headers.authorization !==
                    `Basic ${Buffer.from("synthetic-sso-client:synthetic-sso-secret").toString("base64")}` &&
                    (input.client_id !== "synthetic-sso-client" ||
                      input.client_secret !== "synthetic-sso-secret"))
                )
                  return HttpServerResponse.empty({ status: 401 });
                const origin = yield* Deferred.await(issuer);
                const now = Math.floor(Date.now() / 1000);
                const { signed, signature } = signJwt(keys.privateKey, "synthetic", {
                  iss: origin,
                  aud:
                    code.identity.mode === "wrong-audience"
                      ? "another-client"
                      : "synthetic-sso-client",
                  sub: code.identity.email,
                  email: code.identity.email,
                  ...(thinModes.has(code.identity.mode)
                    ? {}
                    : { email_verified: !unverifiedModes.has(code.identity.mode) }),
                  name: "Synthetic SSO Member",
                  nonce: code.nonce,
                  iat: now,
                  exp: now + 300,
                });
                const accessToken = randomUUID();
                accessTokens.set(accessToken, code.identity);
                return yield* HttpServerResponse.json({
                  access_token: accessToken,
                  token_type: "Bearer",
                  expires_in: 300,
                  id_token: `${signed}.${code.identity.mode === "tamper" ? signature.slice(1) : signature}`,
                });
              }),
            ),
            HttpRouter.add(
              "POST",
              "/unpublished/token",
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const form = new URLSearchParams(yield* request.text);
                const code = codes.get(form.get("code") ?? "");
                codes.delete(form.get("code") ?? "");
                if (!code) return HttpServerResponse.empty({ status: 401 });
                const now = Math.floor(Date.now() / 1000);
                const { signed, signature } = signJwt(unpublished.privateKey, "unpublished", {
                  iss: yield* Deferred.await(issuer),
                  aud: "synthetic-sso-client",
                  sub: "unpublished@sso.example.test",
                  email: "unpublished@sso.example.test",
                  email_verified: true,
                  name: "Synthetic SSO Member",
                  nonce: code.nonce,
                  iat: now,
                  exp: now + 300,
                });
                return yield* HttpServerResponse.json({
                  access_token: randomUUID(),
                  token_type: "Bearer",
                  expires_in: 300,
                  id_token: `${signed}.${signature}`,
                });
              }),
            ),
            HttpRouter.add(
              "GET",
              "/userinfo",
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const identity = accessTokens.get(
                  request.headers.authorization?.replace(/^Bearer /u, "") ?? "",
                );
                if (!identity) return HttpServerResponse.empty({ status: 401 });
                return yield* HttpServerResponse.json({
                  sub:
                    identity.mode === "userinfo-other-subject"
                      ? "another-subject@sso.example.test"
                      : identity.email,
                  email: identity.email,
                  ...(identity.mode === "unverified-absent"
                    ? {}
                    : { email_verified: !unverifiedModes.has(identity.mode) }),
                  name: "Synthetic SSO Member",
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
                  entityID:
                    control.mode === "wrong-audience" ? "https://another.example/sp" : entity,
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
        if (Option.isSome(tlsCertificate) !== Option.isSome(tlsKey))
          return yield* Effect.die("Pass both --tls-certificate and --tls-key, or neither");
        const tls =
          Option.isSome(tlsCertificate) && Option.isSome(tlsKey)
            ? {
                cert: yield* fs.readFileString(tlsCertificate.value),
                key: yield* fs.readFileString(tlsKey.value),
              }
            : undefined;
        const listen = (
          scheme: "http" | "https",
          evaluate: typeof createServer | (() => ReturnType<typeof createHttpsServer>),
        ) =>
          Effect.gen(function* () {
            const listener = yield* Deferred.make<string>();
            const services = yield* Layer.build(
              HttpRouter.serve(routes(Deferred.await(listener)), {
                disableLogger: true,
                disableListenLog: true,
              }).pipe(
                Layer.provideMerge(NodeHttpServer.layer(evaluate, { host: "127.0.0.1", port: 0 })),
              ),
            );
            const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
            if (!("port" in server.address))
              return yield* Effect.die("Expected a loopback TCP listener");
            const origin = `${scheme}://127.0.0.1:${server.address.port}`;
            yield* Deferred.succeed(listener, origin);
            return origin;
          });
        const origin = yield* listen("http", createServer);
        const secureOrigin =
          tls === undefined ? undefined : yield* listen("https", () => createHttpsServer(tls));
        yield* Deferred.succeed(address, origin);
        yield* Deferred.succeed(issuer, secureOrigin ?? origin);
        yield* fs.writeFileString(
          `${directory}/sso-idp.json`,
          JSON.stringify({ origin, issuer: secureOrigin ?? origin }),
          {
            mode: 0o600,
          },
        );
        return yield* Effect.never;
      }),
    ),
  ),
);
NodeRuntime.runMain(
  Command.run(command, { version: "0.0.0" }).pipe(Effect.provide(NodeServices.layer)),
);
