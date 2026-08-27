import type {
  EnterpriseIdentityProviderDescriptor,
  IntegrationSlug,
  OAuthClientSummary,
} from "@executor-js/sdk/shared";

import type { AuthMethod } from "./auth-placements";

// ---------------------------------------------------------------------------
// Which connect a click runs on an enterprise-managed server.
//
// Three routes reach one button, and picking the wrong one is not cosmetic:
//
//   - ENTERPRISE. The server declares an identity provider AND an `id_jag`
//     client is registered for it. `oauth.start` names that client with
//     `enterprise: { idpClient, idpClientOwner }` and NO subject token — the
//     server resolves the member's held work identity. There is no consent
//     screen and nothing for the member to grant.
//   - DCR / CIMD / bring-your-own-app. Today's behavior, and still correct for
//     every server that declares no identity provider.
//   - Neither, yet: the server IS declared managed but nobody has registered the
//     `id_jag` client it needs. The console must not silently register a fresh
//     `authorization_code` client and walk the member through per-server consent
//     as if the declaration were absent — that is the failure this module
//     exists to name. It falls through to the ordinary route (a member has to
//     be able to work) while telling an administrator exactly what is missing.
//
// The decision is STRUCTURAL throughout: the declaration comes off the auth
// method, and the client is matched on its recorded intent, its RFC 8707
// resource, or its host — never on a name, a message, or the grant of whatever
// app a picker happened to default to.
// ---------------------------------------------------------------------------

/** Whether two hosts are the same, case-insensitively, when both are known. */
const sameHost = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a === b;

const hostOf = (url: string | null | undefined): string | undefined => {
  if (url === null || url === undefined || url.length === 0) return undefined;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL() throws on a stored value that is not a URL; treat as "no host"
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/** How well a registered `id_jag` app matches the server being connected. Lower
 *  is better; `null` means it does not match at all and must never be used —
 *  presenting an assertion to the wrong Resource Authorization Server is not a
 *  degraded connect, it is a different server. */
const enterpriseClientTier = (
  client: OAuthClientSummary,
  target: {
    readonly integration: IntegrationSlug;
    readonly resource: string | undefined;
  },
): number | null => {
  // 1. Recorded intent: registered from THIS integration's dialog.
  if (client.origin.kind === "manual" && client.origin.integration === target.integration) return 0;
  // 2. The RFC 9728 resource identifier the app was registered against is this
  //    server's endpoint. This is the identity the ID-JAG is audienced to, so an
  //    exact match is as strong a signal as intent.
  const resource = target.resource;
  if (resource !== undefined && client.resource != null && client.resource === resource) return 1;
  // 3. Same host as the server. Weaker (one host can serve several resources),
  //    kept because an administrator registering by hand may not paste the
  //    endpoint character-for-character.
  const resourceHost = hostOf(resource);
  if (sameHost(hostOf(client.tokenUrl), resourceHost)) return 2;
  if (sameHost(hostOf(client.authorizationUrl), resourceHost)) return 2;
  return null;
};

/**
 * The registered enterprise (`id_jag`) app for one server, or null when none is
 * registered.
 *
 * Ties break toward the organization's app: an enterprise registration is the
 * organization's by definition, and a personal one that happens to match is the
 * odd case, not the default.
 */
export const selectEnterpriseClient = (
  clients: readonly OAuthClientSummary[],
  target: {
    readonly integration: IntegrationSlug;
    readonly resource: string | undefined;
  },
): OAuthClientSummary | null => {
  const ranked = clients.flatMap((client: OAuthClientSummary) => {
    if (client.grant !== "id_jag") return [];
    const tier = enterpriseClientTier(client, target);
    return tier === null ? [] : [{ client, tier }];
  });
  const best = ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.client.owner === "org") - Number(a.client.owner === "org") ||
      String(a.client.slug).localeCompare(String(b.client.slug)),
  )[0];
  return best?.client ?? null;
};

/** What the connect button on this method should do. */
export type EnterpriseConnectPlan =
  /** The server declares no identity provider: today's routes apply unchanged. */
  | { readonly kind: "unmanaged" }
  /** Declared managed, but no `id_jag` app is registered for this server. The
   *  ordinary route still runs; an administrator has to register one before the
   *  enterprise branch can be taken at all. */
  | {
      readonly kind: "unregistered";
      readonly identityProvider: EnterpriseIdentityProviderDescriptor;
    }
  /** Declared managed and registered: name this app with the identity provider
   *  and no subject token. */
  | {
      readonly kind: "enterprise";
      readonly identityProvider: EnterpriseIdentityProviderDescriptor;
      readonly client: OAuthClientSummary;
    };

/**
 * Decide the connect route for one auth method.
 *
 * `method.oauth.enterpriseIdentityProvider` is the ONLY thing that makes a
 * server managed here — deliberately not the presence of an `id_jag` app, which
 * an administrator may register before (or after) declaring the server, and
 * which on its own says nothing about whether members should stop consenting.
 */
export const enterpriseConnectPlan = (input: {
  readonly method: AuthMethod | undefined;
  readonly integration: IntegrationSlug;
  readonly clients: readonly OAuthClientSummary[];
}): EnterpriseConnectPlan => {
  const method = input.method;
  if (method === undefined || method.kind !== "oauth") return { kind: "unmanaged" };
  const identityProvider = method.oauth?.enterpriseIdentityProvider;
  if (identityProvider === undefined) return { kind: "unmanaged" };
  const client = selectEnterpriseClient(input.clients, {
    integration: input.integration,
    resource: method.oauth?.resource ?? method.oauth?.discoveryUrl,
  });
  return client === null
    ? { kind: "unregistered", identityProvider }
    : { kind: "enterprise", identityProvider, client };
};
