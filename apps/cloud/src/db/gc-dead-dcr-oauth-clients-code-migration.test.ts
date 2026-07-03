/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- test fake throws on an unexpected query to catch wiring drift */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { gcDeadDcrOAuthClientsMigration } from "../../scripts/code-migrations/gc-dead-dcr-oauth-clients";
import type { CodeMigrationContext, CodeMigrationSql } from "../../scripts/code-migrations/runner";

// Cloud counterpart of the local libSQL GC migration test. A small in-memory
// fake models the SQL shapes the migration issues (the oauth_client SELECT, the
// single GROUPED connection-count query, and the DELETE/UPDATE mutations) so the
// same shared decision matrix is proven end-to-end over the Postgres wiring.

interface OAuthClientRow {
  readonly tenant: string;
  readonly owner: string;
  readonly slug: string;
  readonly grant: string | null;
  readonly resource: string | null;
  readonly origin_kind: string | null;
  readonly origin_issuer: string | null;
  readonly token_url: string | null;
}

const makeFake = (input: {
  rows: OAuthClientRow[];
  /** connection count keyed by `${tenant}|${owner}|${slug}`. */
  readonly references: Record<string, number>;
}) => {
  const deletes: string[] = [];
  const updates: { slug: string; issuer: string }[] = [];
  const stamps: { slug: string; kind: string }[] = [];

  const sql: CodeMigrationSql = {
    unsafe: (query: string, params?: readonly unknown[]) => {
      const q = query.trim();
      if (q.startsWith("SELECT") && q.includes("FROM oauth_client")) {
        return Promise.resolve(input.rows as never);
      }
      if (q.startsWith("SELECT") && q.includes("FROM connection")) {
        // One grouped pass: emit a row per referenced (tenant, owner, slug).
        const grouped = Object.entries(input.references).map(([composite, count]) => {
          const [tenant, owner, slug] = composite.split("|");
          return { tenant, oauth_client_owner: owner, oauth_client: slug, count };
        });
        return Promise.resolve(grouped as never);
      }
      if (q.startsWith("DELETE FROM oauth_client")) {
        const [tenant, owner, slug] = params as [string, string, string];
        input.rows = input.rows.filter(
          (r) => !(r.tenant === tenant && r.owner === owner && r.slug === slug),
        );
        deletes.push(slug);
        return Promise.resolve([] as never);
      }
      if (q.startsWith("UPDATE oauth_client")) {
        // The slug is always the last positional param. The DCR-survivor UPDATE
        // may set origin_issuer (an `origin_issuer = $N` clause with the issuer
        // as its first param) and/or stamp origin_kind (a literal in the SQL).
        const args = (params ?? []) as readonly string[];
        const slug = args[args.length - 1];
        if (q.includes("origin_kind = 'manual'")) {
          stamps.push({ slug, kind: "manual" });
        }
        if (q.includes("origin_kind = 'dynamic_client_registration'")) {
          stamps.push({ slug, kind: "dynamic_client_registration" });
        }
        if (q.includes("origin_issuer =")) {
          updates.push({ slug, issuer: args[0] });
        }
        return Promise.resolve([] as never);
      }
      throw new Error(`unexpected query: ${q}`);
    },
  };

  return { sql, deletes, updates, stamps, rowsRef: () => input.rows };
};

const row = (over: Partial<OAuthClientRow> & { readonly slug: string }): OAuthClientRow => ({
  tenant: "t1",
  owner: "org",
  slug: over.slug,
  grant: over.grant ?? "authorization_code",
  resource: over.resource ?? null,
  origin_kind: over.origin_kind ?? null,
  origin_issuer: over.origin_issuer ?? null,
  token_url: over.token_url ?? "https://oauth.cloudflare.com/token",
});

const runMigration = (
  fake: ReturnType<typeof makeFake>,
  dryRun: boolean,
): Promise<{ readonly summary: string }> => {
  const context: CodeMigrationContext = { sql: fake.sql, dryRun, log: () => {} };
  return gcDeadDcrOAuthClientsMigration.run(context);
};

describe("gcDeadDcrOAuthClientsMigration", () => {
  it.effect("deletes orphaned DCR, keeps manual + referenced, backfills survivors", () =>
    Effect.promise(async () => {
      const fake = makeFake({
        rows: [
          row({
            slug: "dcr-cloudflare-com",
            resource: "https://cf.example/mcp",
            origin_kind: "dynamic_client_registration",
            origin_issuer: "https://cloudflare.com",
          }),
          row({ slug: "cloudflare-mcp-2", resource: "https://cf.example/mcp" }),
          row({ slug: "cloudflare-mcp", resource: "https://cf.example/mcp" }),
          row({
            slug: "my-github-app",
            token_url: "https://github.com/login/oauth/access_token",
            origin_kind: "manual",
          }),
        ],
        references: { "t1|org|cloudflare-mcp": 1 },
      });

      const result = await runMigration(fake, false);

      expect(fake.deletes.sort()).toEqual(["cloudflare-mcp-2", "dcr-cloudflare-com"]);
      expect(fake.updates).toEqual([{ slug: "cloudflare-mcp", issuer: "https://cloudflare.com" }]);
      // The surviving legacy DCR row gets an explicit DCR stamp; the already
      // explicitly-stamped manual app is never restamped.
      expect(fake.stamps).toEqual([
        { slug: "cloudflare-mcp", kind: "dynamic_client_registration" },
      ]);
      expect(
        fake
          .rowsRef()
          .map((r) => r.slug)
          .sort(),
      ).toEqual(["cloudflare-mcp", "my-github-app"]);
      expect(result.summary).toContain("deleted 2 orphaned DCR client(s)");
      expect(result.summary).toContain("backfilled 1 of 1 referenced DCR client(s)");
      expect(result.summary).toContain("stamped 1 legacy row(s) (1 dcr, 0 manual)");
    }),
  );

  it.effect("stamps a legacy null-origin manual survivor as manual with no issuer", () =>
    Effect.promise(async () => {
      const fake = makeFake({
        rows: [
          // Legacy manual row: null origin_kind, auth-code, NO resource → manual.
          row({
            slug: "legacy-manual",
            token_url: "https://github.com/login/oauth/access_token",
            resource: null,
          }),
        ],
        references: {},
      });

      const result = await runMigration(fake, false);

      expect(fake.deletes).toEqual([]);
      expect(fake.updates).toEqual([]);
      expect(fake.stamps).toEqual([{ slug: "legacy-manual", kind: "manual" }]);
      expect(fake.rowsRef().map((r) => r.slug)).toEqual(["legacy-manual"]);
      expect(result.summary).toContain("stamped 1 legacy row(s) (0 dcr, 1 manual)");
    }),
  );

  it.effect("dry run mutates nothing but reports the plan", () =>
    Effect.promise(async () => {
      const fake = makeFake({
        rows: [
          row({ slug: "cloudflare-mcp-2", resource: "https://cf.example/mcp" }),
          row({ slug: "cloudflare-mcp", resource: "https://cf.example/mcp" }),
        ],
        references: { "t1|org|cloudflare-mcp": 1 },
      });

      const result = await runMigration(fake, true);

      expect(fake.deletes).toEqual([]);
      expect(fake.updates).toEqual([]);
      expect(fake.stamps).toEqual([]);
      expect(fake.rowsRef()).toHaveLength(2);
      expect(result.summary).toContain("would delete 1 orphaned DCR client(s)");
      expect(result.summary).toContain("would backfill 1 of 1 referenced DCR client(s)");
      // The referenced legacy DCR survivor WOULD be stamped, counted but not
      // written.
      expect(result.summary).toContain("would stamp 1 legacy row(s) (1 dcr, 0 manual)");
    }),
  );

  it.effect("never deletes a manual app even when orphaned and MCP-shaped", () =>
    Effect.promise(async () => {
      const fake = makeFake({
        rows: [
          row({
            slug: "cloudflare-mcp",
            resource: "https://cf.example/mcp",
            origin_kind: "manual",
          }),
        ],
        references: {},
      });
      await runMigration(fake, false);
      expect(fake.deletes).toEqual([]);
      expect(fake.rowsRef().map((r) => r.slug)).toEqual(["cloudflare-mcp"]);
    }),
  );
});
