/**
 * Executor v1's OAuth client ID metadata documents, which the edge serves byte for byte once v1
 * shuts down (`notes/v1-shutdown.md`, decision 5). OAuth apps imported from v1 name them as their
 * client IDs, so each must stay exactly as v1 generated it. v1's terms, privacy policy and Google
 * OAuth page are not kept: the site's own pages of the same name serve those paths.
 */

import { Option } from "effect";

/** v1's OAuth client ID metadata documents: `<prefix>.json` and `<prefix>/<target>.json`. */
export const v1ClientIdMetadataPrefix = "/api/oauth/client-id-metadata";

/** Whether `pathname` is one of v1's client ID metadata documents. */
export const isV1ClientIdMetadataPath = (pathname: string) =>
  pathname === `${v1ClientIdMetadataPrefix}.json` ||
  pathname.startsWith(`${v1ClientIdMetadataPrefix}/`);

const decodeComponent = Option.liftThrowable(decodeURIComponent);

/**
 * The client ID metadata document v1 served at `url` (v1's `oauthClientIdMetadataDocumentFromRequest`
 * with its `/api` mount): `local` is the desktop's native client with loopback callbacks; every
 * other target, an organization's slug or `default` among them, is the web client whose one
 * callback is `/api/oauth/callback`. The client ID is the document's own URL, query included.
 * Property order is v1's, so the JSON is byte for byte v1's.
 */
export const v1ClientIdMetadataDocument = (url: URL) => {
  const own = new URL(`${url.pathname}${url.search}`, url.origin);
  const prefix = `${v1ClientIdMetadataPrefix}/`;
  const encoded =
    own.pathname.startsWith(prefix) && own.pathname.endsWith(".json")
      ? own.pathname.slice(prefix.length, -".json".length)
      : "";
  // v1 decoded and trimmed the target; one that does not decode is no target, as in v1.
  const target =
    encoded === "" || encoded.includes("/")
      ? undefined
      : Option.getOrUndefined(Option.map(decodeComponent(encoded), (value) => value.trim()));
  if (target === "local")
    return {
      client_id: own.toString(),
      client_name: "Executor Local",
      client_uri: own.origin,
      redirect_uris: [
        "http://127.0.0.1/api/oauth/callback",
        "http://localhost/api/oauth/callback",
        "http://[::1]/api/oauth/callback",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    };
  return {
    client_id: own.toString(),
    client_name: "Executor",
    client_uri: own.origin,
    redirect_uris: [new URL("/api/oauth/callback", own.origin).toString()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
};
