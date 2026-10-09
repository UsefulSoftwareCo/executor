/**
 * The product zone's DNS. Every record that is not owned by a Cloudflare feature is declared here,
 * adopted in place and retained if it is removed from this file.
 *
 *   bun run dns:deploy
 *
 * Cloudflare features own the zone's read-only records, which are not declared here:
 *
 * - Workers Custom Domains own the `100::` AAAA records of `executor.sh` (v1, wrangler) and
 *   `v2.executor.sh` (the `v2` stage).
 *
 * The `v2` stage's role hosts (`app.`, `mcp.`, `api.`) are declared here as proxied `100::`
 * records, which the `v2` stage's Worker routes serve. Routes order no certificate, so these hosts
 * use the zone's `*.executor.sh` certificate. See `src/infrastructure/role-hosts.ts`.
 * - Email Sending owns the `cf-bounce` MX, SPF and DKIM records of `executor.sh` (welcome email)
 *   and `mail-v2.executor.sh` (`authEmailInfrastructure`).
 *
 * Each deploy also checks the zone's edge certificates. See {@link productZoneCertificateCoverage}.
 */
import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import { retain } from "alchemy/RemovalPolicy";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";
import { productZoneCertificateCoverage } from "./src/infrastructure/product-zone.ts";
import { hostRoles, productZone } from "./src/infrastructure/stage.ts";

type Declared =
  | { readonly type: "CNAME" | "TXT"; readonly name: string; readonly content: string }
  | {
      readonly type: "AAAA";
      readonly name: string;
      readonly content: "100::";
      readonly proxied: true;
    }
  | {
      readonly type: "MX";
      readonly name: string;
      readonly content: string;
      readonly priority: number;
    };

/** Records keep their current TTL, content and comment so adoption matches them verbatim. */
const records: ReadonlyArray<
  Declared & { readonly id: string; readonly ttl: number | "1"; readonly comment?: string }
> = [
  // WorkOS hosts executor-v1's AuthKit pages and admin portal.
  { id: "WorkosAdmin", type: "CNAME", name: "admin", content: "cname.workos-dns.com", ttl: "1" },
  { id: "WorkosAuth", type: "CNAME", name: "auth", content: "cname.workos-dns.com", ttl: "1" },
  { id: "WorkosSignin", type: "CNAME", name: "signin", content: "cname.workos-dns.com", ttl: "1" },
  {
    id: "WorkosVerification",
    type: "TXT",
    name: "@",
    content: "work-os-domain-verification-mnzmwq=OwUCEw1VhSrCZNToQi444fc6Q",
    ttl: "1",
  },
  // SendGrid sends WorkOS email from the zone.
  {
    id: "SendgridLink",
    type: "CNAME",
    name: "em7790",
    content: "u36670648.wl149.sendgrid.net",
    ttl: "1",
  },
  {
    id: "SendgridDkim1",
    type: "CNAME",
    name: "wos._domainkey",
    content: "wos.domainkey.u36670648.wl149.sendgrid.net",
    ttl: "1",
  },
  {
    id: "SendgridDkim2",
    type: "CNAME",
    name: "wos2._domainkey",
    content: "wos2.domainkey.u36670648.wl149.sendgrid.net",
    ttl: "1",
  },
  // Google Workspace mail.
  { id: "GoogleMx1", type: "MX", name: "@", content: "aspmx.l.google.com", priority: 1, ttl: 3600 },
  {
    id: "GoogleMx2",
    type: "MX",
    name: "@",
    content: "alt1.aspmx.l.google.com",
    priority: 5,
    ttl: 3600,
  },
  {
    id: "GoogleMx3",
    type: "MX",
    name: "@",
    content: "alt2.aspmx.l.google.com",
    priority: 5,
    ttl: 3600,
  },
  {
    id: "GoogleMx4",
    type: "MX",
    name: "@",
    content: "alt3.aspmx.l.google.com",
    priority: 10,
    ttl: 3600,
  },
  {
    id: "GoogleMx5",
    type: "MX",
    name: "@",
    content: "alt4.aspmx.l.google.com",
    priority: 10,
    ttl: 3600,
  },
  {
    id: "GoogleSpf",
    type: "TXT",
    name: "@",
    content: '"v=spf1 include:_spf.google.com ~all"',
    ttl: 3600,
  },
  {
    id: "GoogleDkim",
    type: "TXT",
    name: "google._domainkey",
    content:
      "v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuoWe2WNqbbtB1G1sVs/dTUdKhpMi2Q3zghWQk+HqgTwIl4iZ/JUTs5w89rCzfxCeWXma5+BFIuJN2E4uDp+Frmf6eYOgRLBC1KwqIxL/9Trbu0trpV8PbjRjP+T0ZvqLJZakjOufjZN5ZAOhvaipCMZW1thi9+EumaVp9Ys/WnCOfQaYnB+wUXlz8WBAefkPKeIY5272UDBk2s8hxk/kciTzU8Sucntd0IX3rwDoWoRVGZQw04hrErOX36PTTJi/0gn3gVm2depfpN3xU4NKXsQ8pMNa6PoLiBGCJy11u0QHn2XU72zIHmBpWWx05r6BBq26MyvS03NDcgk78GqzywIDAQAB",
    ttl: "1",
  },
  {
    id: "GoogleSiteVerification",
    type: "TXT",
    name: "@",
    content: '"google-site-verification=AqJEzoxS47Rj1XoKywfSvwRjCQhdEx-VWPpjYMNvtsE"',
    ttl: 3600,
  },
  // Domain verifications for OAuth publishers and Executor's own organization domain.
  {
    id: "MicrosoftEntraVerification",
    type: "TXT",
    name: "@",
    content: "MS=ms52432881",
    ttl: 3600,
    comment: "Microsoft Entra domain verification for Executor OAuth publisher",
  },
  {
    id: "ExecutorDomainVerification",
    type: "TXT",
    name: "@",
    content: "executor-domain-verification-zyjsgf=8UySnT5c6mduDXHriwkh0WCpD",
    ttl: "1",
  },
  // DMARC for the apex and for v2's auth email subdomain.
  {
    id: "ApexDmarc",
    type: "TXT",
    name: "_dmarc",
    content: "v=DMARC1; p=none;",
    ttl: "1",
    comment: "Monitor email authentication while onboarding Cloudflare welcome email sending",
  },
  {
    id: "AuthEmailDmarc",
    type: "TXT",
    name: "_dmarc.mail-v2",
    content: '"v=DMARC1; p=reject;"',
    ttl: "1",
  },
  // The `v2` stage's role hosts. Its API Worker serves them through zone routes.
  ...hostRoles.map((role) => ({
    id: `RoleHost-${role}`,
    type: "AAAA" as const,
    name: role,
    content: "100::" as const,
    proxied: true as const,
    ttl: "1" as const,
    comment: "Routes the v2 stage's role host to its API Worker",
  })),
];

export default Alchemy.Stack(
  "executor-product-dns",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    if ((yield* Stage) !== "shared") return yield* Effect.die(new Error("Use the shared stage."));
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const zone = yield* Cloudflare.Zone.findZoneByName({ accountId, name: productZone }).pipe(
      Effect.orDie,
    );
    if (!zone) return yield* Effect.die(new Error(`Cloudflare zone ${productZone} is missing`));
    const hostname = (name: string) => (name === "@" ? productZone : `${name}.${productZone}`);
    // Checked before any change, with the proxied hosts this deploy declares.
    yield* productZoneCertificateCoverage(
      zone.id,
      records.flatMap((record) => ("proxied" in record ? [hostname(record.name)] : [])),
    );
    for (const { id, name, ...record } of records) {
      yield* Cloudflare.DNS.Record(id, {
        zoneId: zone.id,
        name: hostname(name),
        proxied: false,
        ...record,
      }).pipe(adopt(), retain());
    }
  }),
);
