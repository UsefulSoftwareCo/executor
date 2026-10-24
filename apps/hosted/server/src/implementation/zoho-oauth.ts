/** Regional clients for the official Zoho CRM app. One Multi-DC registration supplies them. */
import type { FirstPartyOAuthClientDefinition } from "./first-party-oauth.ts";

const scopes = [
  "ZohoCRM.modules.ALL",
  "ZohoCRM.settings.ALL",
  "ZohoCRM.users.ALL",
  "ZohoCRM.org.ALL",
  "ZohoCRM.bulk.ALL",
  "ZohoCRM.coql.READ",
  "ZohoCRM.notifications.READ",
  "ZohoCRM.notifications.CREATE",
  "ZohoCRM.notifications.UPDATE",
  "ZohoCRM.notifications.DELETE",
  "ZohoCRM.features.READ",
  "ZohoCRM.send_mail.all.CREATE",
  // Zoho's CRM v8 Files guide uses this exact casing: https://www.zoho.com/crm/developer/docs/api/v8/upload-files-to-zfs.html
  "ZohoCRM.Files.CREATE",
  "ZohoCRM.Files.READ",
] as const;

const regions = [
  { id: "us", accounts: "accounts.zoho.com", api: "www.zohoapis.com" },
  { id: "eu", accounts: "accounts.zoho.eu", api: "www.zohoapis.eu" },
  { id: "in", accounts: "accounts.zoho.in", api: "www.zohoapis.in" },
  { id: "au", accounts: "accounts.zoho.com.au", api: "www.zohoapis.com.au" },
  { id: "jp", accounts: "accounts.zoho.jp", api: "www.zohoapis.jp" },
  { id: "ca", accounts: "accounts.zohocloud.ca", api: "www.zohoapis.ca" },
  { id: "sa", accounts: "accounts.zoho.sa", api: "www.zohoapis.sa" },
  { id: "cn", accounts: "accounts.zoho.com.cn", api: "www.zohoapis.com.cn" },
] as const;

/** Enable the same credentials for these data centers in Zoho's Multi-DC settings. */
export const zohoOAuthClients: readonly FirstPartyOAuthClientDefinition[] = regions.map(
  (region) => ({
    id: `zoho-${region.id}`,
    label: `Executor for Zoho CRM (${region.id.toUpperCase()})`,
    server: {
      authorizationUrl: `https://${region.accounts}/oauth/v2/auth`,
      tokenUrl: `https://${region.accounts}/oauth/v2/token`,
      revocationUrl: `https://${region.accounts}/oauth/v2/token/revoke`,
      scopeSeparator: ",",
      grantedScopeSeparator: ",",
      authorizationParams: { access_type: "offline", prompt: "consent" },
    },
    tokenEndpointAuthMethod: "client_secret_post",
    defaultScopes: scopes,
    placement: { hosts: [region.api], scheme: "Zoho-oauthtoken" },
  }),
);

/** All regional clients use the one reviewed Multi-DC application's credential pair. */
export const isZohoOAuthClient = (id: string): boolean =>
  regions.some((region) => id === `zoho-${region.id}`);
