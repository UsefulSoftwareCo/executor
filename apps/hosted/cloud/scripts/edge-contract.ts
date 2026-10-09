/**
 * Publish what v1's edge on `executor.sh` forwards to v2 (`productionEdgeForwards`) as
 * `src/contracts/edge-contract.json`: the rules, production's telemetry paths and state prefix,
 * and example requests with whether v1 forwards each. v1 keeps a verbatim copy and tests its own
 * edge against every example, so the two lists cannot drift apart unnoticed: a change here
 * changes the file, and v1's copy must change with it.
 *
 * Every example must agree with `productionEdgeForwards`, and every rule must forward at least
 * one example, so a new rule cannot ship without one. The slashed form of each page in
 * `slashRedirectedSitePages` is not forwarded: v1 redirects it to the page, which is, and every
 * such page has an example. Pass --check to fail when the file is stale.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  accountOAuthStatePrefix,
  forwardsToV2,
  productionEdgeForwards,
  productionSiteTelemetry,
  slashRedirectedSitePages,
} from "../src/contracts/edge-paths.ts";

class EdgeContractInvalid extends Schema.TaggedError<EdgeContractInvalid>()("EdgeContractInvalid", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}

const origin = "https://executor.sh";
const { analyticsProxy, errorTunnel } = productionSiteTelemetry;

/** Example requests without cookies: a path and query, and whether v1 forwards it to v2. */
const forwarded: ReadonlyArray<readonly [method: string, target: string]> = [
  ["GET", "/.well-known/oauth-authorization-server/api/auth"],
  ["GET", "/api/auth/callback/google?code=c&state=s"],
  ["GET", "/api/auth/callback/github"],
  ["GET", `/api/oauth/callback?code=c&state=${accountOAuthStatePrefix}abc`],
  ["GET", "/git/acme/site.git/info/refs?service=git-upload-pack"],
  ["POST", "/git/acme/site.git/git-receive-pack"],
  ["GET", "/"],
  ["GET", "/home"],
  ["GET", "/pricing"],
  ["GET", "/pricing.md"],
  ["GET", "/index.md"],
  ["GET", "/setup-prompt.md"],
  ["GET", "/llms.txt"],
  ["GET", "/about-executor"],
  ["GET", "/google-workspace"],
  ["GET", "/blog"],
  ["GET", "/blog/"],
  ["GET", "/blog/a-post"],
  ["GET", "/docs"],
  ["GET", "/docs/"],
  ["GET", "/docs/quickstart"],
  ["GET", "/apps"],
  ["GET", "/apps/detail"],
  ["GET", "/experiments/hero/a"],
  ["GET", "/experiments/demo/posthog"],
  ["GET", "/_astro/page.abc123.js"],
  ["GET", "/authors/author.png"],
  ["GET", "/og-image.png"],
  ["GET", "/pattern-graph-paper.svg"],
  ["GET", "/.well-known/agent-skills/index.json"],
  ["POST", `${analyticsProxy}/e/?ip=0`],
  ["GET", `${analyticsProxy}/static/array.js`],
  ["POST", errorTunnel],
];

const kept: ReadonlyArray<readonly [method: string, target: string]> = [
  ["GET", "/api/auth/.well-known/openid-configuration"],
  ["GET", "/.well-known/oauth-authorization-server"],
  ["GET", "/.well-known/oauth-protected-resource"],
  ["GET", "/api/auth/callback?code=c&state=s"],
  ["GET", "/api/auth/callback/google/extra"],
  ["GET", "/api/auth/login"],
  ["GET", "/api/oauth/callback?code=c&state=abc"],
  ["GET", "/api/oauth/callback?code=c"],
  ["GET", "/oauth/client-metadata.json"],
  ["GET", "/oauth/client-id-metadata.json"],
  ["GET", "/git"],
  ["GET", "/gitlab/repo"],
  ["GET", "/demo"],
  ["GET", "/demo/posthog"],
  ["GET", "/experiments"],
  ["GET", "/privacy"],
  ["GET", "/terms"],
  ["GET", "/google-oauth"],
  ["GET", "/_v1-marketing/style.css"],
  ["GET", "/favicon-32.png"],
  ["GET", "/favicon-192.png"],
  ["GET", "/apple-touch-icon.png"],
  ["GET", "/favicon.ico"],
  ["GET", "/pricing/extra"],
  ["GET", "/home/extra"],
  ["GET", "/about-executor/extra"],
  ["GET", "/google-workspace/extra"],
  // Only a page's `GET` or `HEAD` slashed form redirects; see `slashRedirects`.
  ["POST", "/pricing/"],
  ["GET", "/login"],
  ["GET", "/sign-up"],
  ["GET", "/signup"],
  ["POST", "/mcp"],
  ["POST", "/acme/mcp"],
  ["GET", "/acme"],
  ["GET", analyticsProxy],
  ["GET", errorTunnel.replace(/\/submit$/u, "")],
  ["POST", `${errorTunnel}/extra`],
  ["GET", "/api/0123456789abcdef/e/"],
  ["POST", "/api/webhooks/workos"],
];

/** Slashed pages v1 redirects (308) to the page itself, query kept, and the redirect's target. */
const slashRedirects: ReadonlyArray<readonly [target: string, location: string]> = [
  ["/pricing/", "/pricing"],
  ["/pricing/?ref=hn", "/pricing?ref=hn"],
  ["/home/", "/home"],
  ["/about-executor/", "/about-executor"],
  ["/google-workspace/", "/google-workspace"],
];

const EdgeContract = Schema.Struct({
  source: Schema.String,
  origin: Schema.String,
  oauthStatePrefix: Schema.String,
  telemetry: Schema.Struct({ analyticsProxy: Schema.String, errorTunnel: Schema.String }),
  rules: Schema.Array(Schema.String),
  cases: Schema.Array(
    Schema.Struct({ method: Schema.String, target: Schema.String, forwards: Schema.Boolean }),
  ),
  slashRedirects: Schema.Struct({
    rule: Schema.String,
    pages: Schema.Array(Schema.String),
    cases: Schema.Array(Schema.Struct({ target: Schema.String, location: Schema.String })),
  }),
});

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cases = [
      ...forwarded.map(([method, target]) => ({ method, target, forwards: true })),
      ...kept.map(([method, target]) => ({ method, target, forwards: false })),
    ];
    for (const example of cases)
      if (
        forwardsToV2(productionEdgeForwards, new URL(example.target, origin)) !== example.forwards
      )
        return yield* new EdgeContractInvalid({
          reason: `${example.method} ${example.target} should ${example.forwards ? "" : "not "}forward`,
        });
    for (const [target, location] of slashRedirects) {
      const url = new URL(target, origin);
      const page = url.pathname.slice(0, -1);
      const expected = new URL(location, origin);
      if (
        !url.pathname.endsWith("/") ||
        !slashRedirectedSitePages.some((redirected) => redirected === page) ||
        forwardsToV2(productionEdgeForwards, url) ||
        !forwardsToV2(productionEdgeForwards, expected) ||
        expected.pathname !== page ||
        expected.search !== url.search
      )
        return yield* new EdgeContractInvalid({
          reason: `GET ${target} is not the slashed form of a forwarded page redirecting to ${location}`,
        });
    }
    for (const page of slashRedirectedSitePages)
      if (!slashRedirects.some(([target]) => new URL(target, origin).pathname === `${page}/`))
        return yield* new EdgeContractInvalid({
          reason: `No slash redirect example covers ${page}/`,
        });
    for (const forward of productionEdgeForwards)
      if (!forwarded.some(([, target]) => forward.matches(new URL(target, origin))))
        return yield* new EdgeContractInvalid({
          reason: `No forwarded example covers the rule ${forward.rule}`,
        });
    const contract: typeof EdgeContract.Type = {
      source:
        "Executor v2: apps/hosted/cloud/src/contracts/edge-contract.json, generated by " +
        "apps/hosted/cloud/scripts/edge-contract.ts from productionEdgeForwards",
      origin,
      oauthStatePrefix: accountOAuthStatePrefix,
      telemetry: { analyticsProxy, errorTunnel },
      rules: productionEdgeForwards.map((forward) => forward.rule),
      cases,
      slashRedirects: {
        rule: "GET or HEAD <page>/ answers 308 to <page>, query kept, for each of pages",
        pages: [...slashRedirectedSitePages],
        cases: slashRedirects.map(([target, location]) => ({ target, location })),
      },
    };
    const output = path.join(
      yield* path.fromFileUrl(new URL("../src/contracts/", import.meta.url)),
      "edge-contract.json",
    );
    if (!process.argv.includes("--check")) {
      yield* fs.writeFileString(output, `${JSON.stringify(contract, null, 2)}\n`);
      return;
    }
    // Compared as data, so formatting the file does not make it stale.
    const current = yield* fs
      .readFileString(output)
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(EdgeContract))),
        Effect.option,
      );
    if (Option.isNone(current) || JSON.stringify(current.value) !== JSON.stringify(contract))
      return yield* new EdgeContractInvalid({
        reason: "edge-contract.json is stale. Run: bun run edge:contract, then copy it to v1",
      });
  }).pipe(Effect.provide(NodeServices.layer)),
);
