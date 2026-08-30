// ---------------------------------------------------------------------------
// The catalog behind the reworked picker.
//
// Everything here except the category is real registry data, loaded live from
// integrations.sh: ~3.4k domains, popularity-sorted, with icons, descriptions
// and the formats each one exposes.
//
// CATEGORY IS A STAND-IN. integrations.sh has a `categories` field, but only
// the 13 hand-curated entries populate it — the other ~3,365 domains have none.
// A category rail like the reference picker's therefore needs the catalog
// categorised first (the "leverage AI for the generation" step). The keyword
// pass below exists so the rail is real enough to design against; it is not a
// taxonomy and should not survive into the product.
// ---------------------------------------------------------------------------

import { fetchCatalogDomains, type CatalogDomain } from "./fixtures";

export type Category =
  | "Featured"
  | "Inbox & calendar"
  | "Docs & files"
  | "Developer tools"
  | "Analytics"
  | "Payments"
  | "Support"
  | "Project management"
  | "Infrastructure"
  | "Everything else";

export const CATEGORY_ORDER: readonly Category[] = [
  "Featured",
  "Inbox & calendar",
  "Docs & files",
  "Developer tools",
  "Analytics",
  "Payments",
  "Support",
  "Project management",
  "Infrastructure",
  "Everything else",
];

const KEYWORDS: readonly (readonly [Category, readonly string[]])[] = [
  ["Inbox & calendar", ["email", "mail", "calendar", "inbox", "meeting", "scheduling"]],
  ["Docs & files", ["document", "file", "drive", "storage", "note", "wiki", "knowledge"]],
  ["Analytics", ["analytic", "metric", "tracking", "telemetry", "dashboard", "insight"]],
  ["Payments", ["payment", "invoice", "billing", "subscription", "checkout", "payout"]],
  ["Support", ["support", "ticket", "helpdesk", "customer", "chat"]],
  ["Project management", ["issue", "task", "project", "sprint", "roadmap", "backlog"]],
  [
    "Infrastructure",
    ["deploy", "server", "cluster", "database", "kubernetes", "cloud", "hosting", "dns"],
  ],
  ["Developer tools", ["repo", "commit", "pull request", "ci", "build", "code", "sdk", "api"]],
];

/** Best-effort bucket from the description. Deliberately crude — see the file
 *  header. Anything unmatched lands in "Everything else" rather than being
 *  guessed at. */
const deriveCategory = (entry: CatalogDomain): Category => {
  const haystack = `${entry.domain} ${entry.description}`.toLowerCase();
  for (const [category, words] of KEYWORDS) {
    if (words.some((word) => haystack.includes(word))) return category;
  }
  return "Everything else";
};

/** Domains the reference picker would call "Featured": the ones executor
 *  already ships a curated preset for, which are also the ones most people
 *  arrive wanting. */
const FEATURED_DOMAINS: readonly string[] = [
  "google.com",
  "github.com",
  "linear.app",
  "notion.com",
  "slack.com",
  "stripe.com",
  "figma.com",
  "posthog.com",
  "sentry.io",
  "vercel.com",
  "resend.com",
  "asana.com",
];

export interface CatalogItem {
  readonly domain: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly formats: readonly string[];
  readonly category: Category;
  readonly featured: boolean;
  readonly popularity: number;
}

/** Title-case a domain into something that reads like a product name.
 *  `linear.app` → `Linear`, `google.com` → `Google`. */
const displayName = (domain: string): string => {
  const stem = domain.split(".")[0] ?? domain;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
};

export const loadCatalog = async (): Promise<readonly CatalogItem[]> => {
  const domains = await fetchCatalogDomains();
  return domains.map((entry): CatalogItem => {
    const featured = FEATURED_DOMAINS.includes(entry.domain);
    return {
      domain: entry.domain,
      name: displayName(entry.domain),
      description: entry.description,
      icon: entry.icon,
      formats: Object.keys(entry.formats ?? {}),
      category: featured ? "Featured" : deriveCategory(entry),
      featured,
      popularity: entry.popularity,
    };
  });
};

export const searchItems = (
  items: readonly CatalogItem[],
  query: string,
): readonly CatalogItem[] => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return items;
  return items.filter((item) =>
    `${item.domain} ${item.name} ${item.description}`.toLowerCase().includes(q),
  );
};

// ---------------------------------------------------------------------------
// Added integrations
//
// A registry pick and a hand-pasted URL become the SAME kind of thing the
// moment they're added. Only `source` differs, and it only affects what the
// detail screen can say about where the definition came from — never how you
// authenticate it or where it lives.
// ---------------------------------------------------------------------------

export interface AddedIntegration {
  readonly domain: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly formats: readonly string[];
  readonly source: "registry" | "custom";
  /** Custom only: the endpoint or spec URL the user pasted. */
  readonly url?: string;
}

export const fromCatalogItem = (item: CatalogItem): AddedIntegration => ({
  domain: item.domain,
  name: item.name,
  description: item.description,
  icon: item.icon,
  formats: item.formats,
  source: "registry",
});

/** integrations.sh serves a favicon for any domain, registry entry or not, so
 *  a custom integration still gets a real logo. */
export const logoFor = (domain: string): string => `https://integrations.sh/logo/${domain}`;
