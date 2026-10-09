/**
 * A scoped MCP authorization server that accepts OAuth Client ID Metadata Documents beside
 * dynamic registration, as Linear, Sentry and Notion do. A URL-formatted `client_id` is fetched
 * and checked the way draft-ietf-oauth-client-id-metadata-document asks of a public server.
 */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Deferred, Effect, Layer, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

/** Why the server refused a client; each is a check the draft or OAuth 2.1 requires. */
export type ClientRefusal =
  | "client_id_url"
  | "unreachable"
  | "status"
  | "content_type"
  | "size"
  | "document"
  | "client_id_mismatch"
  | "shared_secret"
  | "unknown_client"
  | "redirect_uri"
  | "pkce";

/** The members a public server reads from a document; anything else passes through. */
const Document = Schema.Struct({
  client_id: Schema.String,
  client_name: Schema.String,
  redirect_uris: Schema.NonEmptyArray(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.String),
  client_secret: Schema.optional(Schema.Unknown),
  client_secret_expires_at: Schema.optional(Schema.Unknown),
  logo_uri: Schema.optional(Schema.String),
});

/** Read the document as a public server would: the recommended 5 KB, no redirects, 200 only. */
const documentReadLimit = 5 * 1024;

export const clientMetadataIssuer = (options: {
  /**
   * Where this server's requests to a public HTTPS origin land, standing in for DNS and TLS.
   * The product listens on loopback but names a public origin in its client ID.
   */
  readonly publicOrigins: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const address = yield* Deferred.make<string>();
    /** Whether the metadata advertises `client_id_metadata_document_supported`. */
    let documents = true;
    const registrations: Array<{ readonly redirectUris: readonly string[] }> = [];
    const fetches: Array<{
      readonly url: string;
      readonly status: number;
      readonly cacheControl: string | undefined;
    }> = [];
    const logos: Array<{
      readonly url: string;
      readonly status: number;
      readonly contentType: string | undefined;
    }> = [];
    const refusals: ClientRefusal[] = [];
    const authorizations: Array<{
      readonly clientId: string;
      readonly redirectUri: string;
      readonly client: "document" | "registered";
    }> = [];
    const exchanges: Array<{
      readonly clientId: string;
      readonly clientAuthentication: boolean;
      readonly issued: boolean;
    }> = [];
    const clients = new Map<string, readonly string[]>();
    const codes = new Map<string, { clientId: string; redirect: string; challenge: string }>();

    /** GET a public URL through its mapped origin. Redirects are answers, never followed. */
    const fetchPublic = (url: URL) =>
      Effect.gen(function* () {
        const target = options.publicOrigins[url.origin];
        if (target === undefined) return Option.none();
        const response = yield* HttpClient.withScope(http).get(
          new URL(`${url.pathname}${url.search}`, target),
        );
        const body = yield* response.arrayBuffer;
        return Option.some({
          status: response.status,
          headers: response.headers,
          body: new Uint8Array(body),
        });
      }).pipe(
        Effect.scoped,
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.orElseSucceed(() => Option.none()),
      );

    /** Section 4 of the draft: fetch the client ID, then hold the document to its own URL. */
    const documentClient = (clientId: string) =>
      Effect.gen(function* () {
        const url = URL.parse(clientId);
        if (
          url === null ||
          url.protocol !== "https:" ||
          url.href !== clientId ||
          url.pathname === "/" ||
          url.username !== "" ||
          url.password !== "" ||
          url.hash !== ""
        )
          return { refused: "client_id_url" as const };
        const fetched = yield* fetchPublic(url);
        if (Option.isNone(fetched)) return { refused: "unreachable" as const };
        const { status, headers, body } = fetched.value;
        fetches.push({ url: clientId, status, cacheControl: headers["cache-control"] });
        if (status !== 200) return { refused: "status" as const };
        if (headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
          return { refused: "content_type" as const };
        if (body.byteLength > documentReadLimit) return { refused: "size" as const };
        const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Document))(
          new TextDecoder().decode(body),
        ).pipe(Effect.option);
        if (Option.isNone(document)) return { refused: "document" as const };
        if (document.value.client_id !== clientId)
          return { refused: "client_id_mismatch" as const };
        if (
          document.value.client_secret !== undefined ||
          document.value.client_secret_expires_at !== undefined ||
          ![undefined, "none", "private_key_jwt"].includes(
            document.value.token_endpoint_auth_method,
          )
        )
          return { refused: "shared_secret" as const };
        // Section 6.7: prefetch the logo so it can be checked and cached.
        const logo = URL.parse(document.value.logo_uri ?? "");
        if (logo !== null) {
          const fetchedLogo = yield* fetchPublic(logo);
          logos.push({
            url: logo.href,
            status: Option.isSome(fetchedLogo) ? fetchedLogo.value.status : 0,
            contentType: Option.isSome(fetchedLogo)
              ? fetchedLogo.value.headers["content-type"]
              : undefined,
          });
        }
        return { redirects: document.value.redirect_uris };
      });

    const refuse = (reason: ClientRefusal) =>
      Effect.sync(() => refusals.push(reason)).pipe(
        Effect.andThen(
          HttpServerResponse.json(
            { error: reason === "redirect_uri" ? "invalid_request" : "invalid_client", reason },
            { status: 400 },
          ),
        ),
      );

    const routes = Layer.mergeAll(
      HttpRouter.add(
        "*",
        "/mcp",
        Effect.gen(function* () {
          const origin = yield* Deferred.await(address);
          return HttpServerResponse.empty({
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
            },
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource/mcp",
        Effect.gen(function* () {
          const origin = yield* Deferred.await(address);
          return yield* HttpServerResponse.json({
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            scopes_supported: ["read"],
          });
        }),
      ),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-authorization-server",
        Effect.gen(function* () {
          const origin = yield* Deferred.await(address);
          return yield* HttpServerResponse.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            scopes_supported: ["read"],
            authorization_response_iss_parameter_supported: true,
            ...(documents ? { client_id_metadata_document_supported: true } : {}),
          });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/register",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = yield* request.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({ redirect_uris: Schema.NonEmptyArray(Schema.String) }),
              ),
            ),
          );
          registrations.push({ redirectUris: input.redirect_uris });
          const clientId = `registered-client-${registrations.length}`;
          clients.set(clientId, input.redirect_uris);
          return yield* HttpServerResponse.json(
            {
              client_id: clientId,
              redirect_uris: input.redirect_uris,
              token_endpoint_auth_method: "none",
            },
            { status: 201 },
          );
        }),
      ),
      HttpRouter.add(
        "GET",
        "/authorize",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const params = new URL(request.url, "http://localhost").searchParams;
          const clientId = params.get("client_id") ?? "",
            redirect = params.get("redirect_uri") ?? "",
            challenge = params.get("code_challenge");
          // A URL-formatted client ID is a document only where the server advertises support.
          const kind = documents && clientId.includes("://") ? "document" : "registered";
          const client =
            kind === "document"
              ? yield* documentClient(clientId)
              : clients.has(clientId)
                ? { redirects: clients.get(clientId) ?? [] }
                : { refused: "unknown_client" as const };
          if ("refused" in client) return yield* refuse(client.refused);
          // RFC 9700: the redirect URI must match a registered one exactly.
          if (!client.redirects.includes(redirect)) return yield* refuse("redirect_uri");
          if (challenge === null || params.get("code_challenge_method") !== "S256")
            return yield* refuse("pkce");
          authorizations.push({ clientId, redirectUri: redirect, client: kind });
          const code = randomUUID();
          codes.set(code, { clientId, redirect, challenge });
          const callback = new URL(redirect);
          callback.searchParams.set("code", code);
          callback.searchParams.set("state", params.get("state") ?? "");
          callback.searchParams.set("iss", yield* Deferred.await(address));
          return HttpServerResponse.empty({ status: 302, headers: { location: callback.href } });
        }),
      ),
      HttpRouter.add(
        "POST",
        "/token",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const input = new URLSearchParams(yield* request.text);
          const code = input.get("code") ?? "";
          const issued = codes.get(code);
          const clientId = input.get("client_id") ?? "";
          // A public client presents its client ID and no secret.
          const clientAuthentication =
            request.headers.authorization !== undefined || input.has("client_secret");
          const verifier = input.get("code_verifier") ?? "";
          const valid =
            issued !== undefined &&
            input.get("grant_type") === "authorization_code" &&
            clientId === issued.clientId &&
            !clientAuthentication &&
            input.get("redirect_uri") === issued.redirect &&
            createHash("sha256").update(verifier).digest("base64url") === issued.challenge;
          exchanges.push({ clientId, clientAuthentication, issued: valid });
          if (!valid)
            return yield* HttpServerResponse.json({ error: "invalid_grant" }, { status: 400 });
          codes.delete(code);
          return yield* HttpServerResponse.json({
            access_token: `access-${randomUUID()}`,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: `refresh-${randomUUID()}`,
            scope: "read",
          });
        }),
      ),
    );
    const listener = yield* Effect.sync(() => createServer());
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => listener, { host: "127.0.0.1", port: 0 })),
      ),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address))
      return yield* Effect.die("Client metadata fixture needs a TCP listener");
    const origin = `http://127.0.0.1:${server.address.port}`;
    yield* Deferred.succeed(address, origin);
    return {
      origin,
      /** Advertise, or stop advertising, Client ID Metadata Document support. */
      configure: (input: { readonly documents: boolean }) =>
        Effect.sync(() => {
          documents = input.documents;
        }),
      metrics: Effect.sync(() => ({
        registrations: [...registrations],
        fetches: [...fetches],
        logos: [...logos],
        refusals: [...refusals],
        authorizations: [...authorizations],
        exchanges: [...exchanges],
      })),
    };
  });
