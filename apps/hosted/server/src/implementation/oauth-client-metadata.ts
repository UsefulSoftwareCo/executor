/** Serve the hosted Client ID Metadata Document from host configuration alone. */
import { httpsOnlyUrlPolicy, parseDestination } from "@executor-js/utils/url-policy";
import { Config, Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";
import {
  type ClientMetadataDocument,
  ClientMetadataUrlInvalid,
  clientMetadataDocumentPath,
  hostedOAuthClientName,
} from "../contracts/oauth-client-metadata.ts";
import { accountOAuthRedirectUri } from "./auth.ts";

/**
 * The operator's document URL, whether this host serves the document at it, and the one callback
 * the document lists, which every sign-in as the document's client sends.
 */
export interface ClientMetadataSetting {
  readonly url: string;
  readonly served: boolean;
  readonly redirectUri: string;
}

/**
 * The callback a served document lists: on the document's own origin, because authorization
 * servers may accept only redirect URIs there (draft-ietf-oauth-client-id-metadata-document
 * section 6). That is the host's callback when it is on that origin, and otherwise
 * `/api/oauth/callback` on it, which the host serves wherever it serves the document: Cloud's
 * deployment origin serves the document while sign-ins otherwise return through `executor.sh`.
 * A document the operator publishes lists the host's callback, as the operator wrote it.
 */
const documentCallback = (url: URL, served: boolean, callback: string) =>
  !served || new URL(callback).origin === url.origin
    ? callback
    : new URL("/api/oauth/callback", url.origin).href;

const parse = (value: string, origin: string, callback: string) =>
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
    return {
      url: url.href,
      served,
      redirectUri: documentCallback(url, served, callback),
    } satisfies ClientMetadataSetting;
  });

/**
 * `EXECUTOR_OAUTH_CLIENT_METADATA_URL`, checked at startup. Unset, the host registers clients
 * dynamically. At `/oauth/client-metadata.json`, normally on this host's public origin, the host
 * serves the document itself; a private install can publish that path, and `/api/oauth/callback`
 * when its callback is elsewhere, through a public proxy. At any other path the operator
 * publishes the document. `auth` names the host's origin and its account callback.
 */
export const clientMetadataSetting = (auth: {
  readonly origin: string;
  /** Required, so no caller drops a configured callback. */
  readonly oauthRedirectUri: string | undefined;
}) =>
  Config.String("EXECUTOR_OAUTH_CLIENT_METADATA_URL").pipe(
    Config.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ClientMetadataSetting>()),
        onSome: (value) =>
          parse(value, auth.origin, accountOAuthRedirectUri(auth)).pipe(Effect.map(Option.some)),
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
 * request: `client_id` is the configured URL and `redirect_uris` holds the callback sign-ins as
 * this client send as `redirect_uri`. A host that does not serve a document answers 404.
 */
export const clientMetadataDocument = (setting: Option.Option<ClientMetadataSetting>) =>
  Effect.sync(() => {
    if (Option.isNone(setting) || !setting.value.served)
      return HttpServerResponse.empty({ status: 404 });
    const url = new URL(setting.value.url);
    const callback = setting.value.redirectUri;
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
