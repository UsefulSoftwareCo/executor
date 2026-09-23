import { Effect } from "effect";
import { SiteRedirectLimitExceeded, siteRedirectLimits } from "../contracts/site-redirects.ts";

/** Keep fixed paths ahead of patterns and enforce the combined site's upload budgets. */
export const siteRedirects = (lines: Iterable<string>) =>
  Effect.gen(function* () {
    const fixed: Array<string> = [];
    const dynamic: Array<string> = [];
    for (const line of new Set(lines)) {
      const source = line.split(/\s+/, 1)[0];
      if (source === undefined || source === "" || source.startsWith("#")) continue;
      // Cloudflare treats every rule after the first pattern as dynamic, even
      // fixed paths. Group them explicitly instead of sorting all paths together.
      (source.includes(":") || source.includes("*") ? dynamic : fixed).push(line);
    }
    for (const [kind, count] of [
      ["static", fixed.length],
      ["dynamic", dynamic.length],
    ] as const) {
      const limit = siteRedirectLimits[kind];
      if (count > limit) return yield* new SiteRedirectLimitExceeded({ kind, count, limit });
    }
    return [...fixed.sort(), ...dynamic.sort()].join("\n") + "\n";
  });
