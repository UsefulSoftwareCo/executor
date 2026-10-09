/** Serve the hosted Client ID Metadata Document from host configuration alone. */
import { httpsOnlyUrlPolicy, parseDestination } from "@executor-js/utils/url-policy";
import { Config, Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";
import { Authentication } from "../contracts/auth.ts";
import {
  type ClientMetadataDocument,
  ClientMetadataUrlInvalid,
  clientMetadataDocumentPath,
  hostedOAuthClientName,
} from "../contracts/oauth-client-metadata.ts";
import { accountOAuthRedirectUri } from "./auth.ts";

/** The operator's document URL, and whether this host serves the document at it. */
export interface ClientMetadataSetting {
  readonly url: string;
  readonly served: boolean;
}

const parse = (value: string, origin: string) =>
  Effect.gen(function* () {
    // The SDK sends `url.href` as the client ID and the authorization server compares it with
    // the document's `client_id` as a plain string, so only the canonical form is accepted.
    const url = parseDestination(value, httpsOnlyUrlPolicy);
    if (url === undefined || url.href !== value || value.includes("?") || url.pathname === "/") {
      const own = new URL(clientMetadataDocumentPath, origin);
      return yield* new ClientMetadataUrlInvalid({
        reason: "format",
        message: `EXECUTOR_OAUTH_CLIENT_METADATA_URL must be an HTTPS URL on a public host with a path, and no query, fragment or credentials. ${
          parseDestination(own.href, httpsOnlyUrlPolicy) === undefined
            ? "This host's own origin is not public HTTPS, so authorization servers cannot fetch a document from it."
            : `To serve this host's own document, use ${own.href}.`
        }`,
      });
    }
    const served = url.pathname === clientMetadataDocumentPath;
    if (!served && url.origin === new URL(origin).origin)
      return yield* new ClientMetadataUrlInvalid({
        reason: "path",
        message: `This host serves its client metadata document at ${clientMetadataDocumentPath}, not ${url.pathname}.`,
      });
    return { url: url.href, served } satisfies ClientMetadataSetting;
  });

/**
 * `EXECUTOR_OAUTH_CLIENT_METADATA_URL`, checked at startup. Unset, the host registers clients
 * dynamically. At `/oauth/client-metadata.json`, normally on this host's public origin, the host
 * serves the document itself; a private install can publish that path through a public proxy.
 * At any other path the operator publishes the document.
 */
export const clientMetadataSetting = (origin: string) =>
  Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(
    Config.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ClientMetadataSetting>()),
        onSome: (value) => parse(value, origin).pipe(Effect.map(Option.some)),
      }),
    ),
  );

/** RFC 8252 loopback callbacks belong to native clients; OpenID providers refuse them for web. */
const applicationType = (callback: string) => {
  const url = new URL(callback);
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ? "native"
    : "web";
};

/**
 * GET the document, unauthenticated. Every value comes from host configuration, never from the
 * request: `client_id` is the configured URL and `redirect_uris` holds the callback the host
 * sends as `redirect_uri`. A host that does not serve a document answers 404.
 */
export const clientMetadataDocument = (setting: Option.Option<ClientMetadataSetting>) =>
  Effect.gen(function* () {
    if (Option.isNone(setting) || !setting.value.served)
      return HttpServerResponse.empty({ status: 404 });
    const url = new URL(setting.value.url);
    const callback = accountOAuthRedirectUri(yield* Authentication);
    const document: ClientMetadataDocument = {
      client_id: url.href,
      client_name: hostedOAuthClientName,
      client_uri: url.origin,
      logo_uri: new URL("/favicon.png", url.origin).href,
      redirect_uris: [callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: applicationType(callback),
    };
    return HttpServerResponse.jsonUnsafe(document, {
      headers: {
        // Authorization servers cache the document by these headers. A short lifetime lets a
        // changed callback reach them within minutes.
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  });
