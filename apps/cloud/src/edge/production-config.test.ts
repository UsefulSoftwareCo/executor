import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { unstable_readConfig } from "wrangler";

import { frontResponse } from "./front";
import { parseV2Edge, v2EdgeResponse, type V2EdgeEnv, type V2Service } from "./marketing";

// The deployed edge reads its v2 settings from wrangler.jsonc. These tests read
// that file the way wrangler does and run the edge with the values it ships.
// wrangler's config arrives untyped here, so it is decoded first.
const WranglerConfig = Schema.Struct({
  vars: Schema.Record(Schema.String, Schema.Unknown),
  services: Schema.Array(Schema.Struct({ binding: Schema.String, service: Schema.String })),
});
const config = Schema.decodeUnknownSync(WranglerConfig)(
  unstable_readConfig({ config: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)) }),
);

// The front Worker (wrangler.edge.jsonc) runs the same edge on executor.sh
// before `executor-cloud`, with its own copy of the settings.
const EdgeWranglerConfig = Schema.Struct({
  main: Schema.String,
  vars: Schema.Record(Schema.String, Schema.Unknown),
  services: Schema.Array(Schema.Struct({ binding: Schema.String, service: Schema.String })),
  routes: Schema.Array(
    Schema.Struct({ pattern: Schema.String, zone_name: Schema.optional(Schema.String) }),
  ),
  placement: Schema.optional(Schema.Unknown),
});
const edgeConfig = Schema.decodeUnknownSync(EdgeWranglerConfig)(
  unstable_readConfig({
    config: fileURLToPath(new URL("../../wrangler.edge.jsonc", import.meta.url)),
  }),
);

const stringVar = (name: string): string | undefined => {
  const value = config.vars[name];
  return typeof value === "string" ? value : undefined;
};

const standIn: V2Service = { fetch: () => Promise.resolve(new Response("v2")) };

/** The shipped settings, with a stand-in for v2's Worker. */
const shipped: V2EdgeEnv = {
  V2: standIn,
  V2_SIGN_UP_URL: stringVar("V2_SIGN_UP_URL"),
  V2_OAUTH_STATE_PREFIX: stringVar("V2_OAUTH_STATE_PREFIX"),
  V2_ANALYTICS_PROXY_PATH: stringVar("V2_ANALYTICS_PROXY_PATH"),
  V2_ERROR_TUNNEL_PATH: stringVar("V2_ERROR_TUNNEL_PATH"),
};

const edgeStringVar = (name: string): string | undefined => {
  const value = edgeConfig.vars[name];
  return typeof value === "string" ? value : undefined;
};

/** The front Worker's shipped settings, with the same stand-in. */
const frontShipped: V2EdgeEnv = {
  V2: standIn,
  V2_SIGN_UP_URL: edgeStringVar("V2_SIGN_UP_URL"),
  V2_OAUTH_STATE_PREFIX: edgeStringVar("V2_OAUTH_STATE_PREFIX"),
  V2_ANALYTICS_PROXY_PATH: edgeStringVar("V2_ANALYTICS_PROXY_PATH"),
  V2_ERROR_TUNNEL_PATH: edgeStringVar("V2_ERROR_TUNNEL_PATH"),
};

describe("production v2 edge settings", () => {
  it("binds V2 to the unplaced marketing gateway", () => {
    const bindings = config.services.filter((service) => service.binding === "V2");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.service).toBe("executor-next-marketing-v2");
  });

  it("redirects sign-up to v2's sign-up page on app.executor.sh", async () => {
    const response = await v2EdgeResponse(new Request("https://executor.sh/sign-up"), shipped);

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://app.executor.sh/login?mode=signup");
  });

  it("ships v2's connected-account state prefix", () => {
    const edge = parseV2Edge(shipped);
    if (edge === null || typeof edge === "string") return expect.unreachable("settings must parse");
    expect(edge.oauthStatePrefix).toBe("x2.");
  });

  it("ships v2's analytics proxy root and error tunnel", () => {
    const edge = parseV2Edge(shipped);
    if (edge === null || typeof edge === "string") return expect.unreachable("settings must parse");
    expect(edge.analyticsProxyPath).toBe("/api/00e2e1f082a6ef17");
    expect(edge.errorTunnelPath).toBe("/api/fd6fab1fbb4883e1/submit");
  });

  it("binds V2_MCP to v2's MCP Worker and names its origin", () => {
    const bindings = config.services.filter((service) => service.binding === "V2_MCP");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.service).toBe("executor-next-hosted-api-v2-qs32brgjwvt7ytx4");
    expect(stringVar("V2_MCP_ORIGIN")).toBe("https://mcp.executor.sh");
  });

  it("keeps the MARKETING binding for v1's terms", () => {
    expect(config.services.filter((service) => service.binding === "MARKETING")).toHaveLength(1);
  });
});

describe("the executor.sh front Worker's settings", () => {
  it("runs the front entry on a zone route for every executor.sh path", () => {
    expect(edgeConfig.main).toMatch(/src\/edge\/front\.ts$/);
    expect(edgeConfig.routes).toEqual([{ pattern: "executor.sh/*", zone_name: "executor.sh" }]);
  });

  // Placement would send every request it answers to the placed region,
  // which is the trip this Worker exists to avoid.
  it("is not placed", () => {
    expect(edgeConfig.placement).toBeUndefined();
  });

  it("ships the same v2 settings as executor-cloud", () => {
    // The MCP forwarding settings (`V2_MCP_*`) belong to executor-cloud alone:
    // the edge never serves MCP.
    const v2Vars = (vars: Readonly<Record<string, unknown>>) =>
      Object.fromEntries(
        Object.entries(vars).filter(
          ([name]) => name.startsWith("V2_") && !name.startsWith("V2_MCP_"),
        ),
      );
    expect(Object.keys(v2Vars(edgeConfig.vars)).toSorted()).toEqual([
      "V2_ANALYTICS_PROXY_PATH",
      "V2_ERROR_TUNNEL_PATH",
      "V2_OAUTH_STATE_PREFIX",
      "V2_SIGN_UP_URL",
    ]);
    expect(v2Vars(edgeConfig.vars)).toEqual(v2Vars(config.vars));
  });

  it("binds the same v2 and marketing Workers as executor-cloud", () => {
    const bound = (services: typeof config.services) =>
      services
        .filter((service) => service.binding === "V2" || service.binding === "MARKETING")
        .toSorted((a, b) => a.binding.localeCompare(b.binding));
    expect(bound(edgeConfig.services)).toEqual(bound(config.services));
    expect(bound(edgeConfig.services)).toHaveLength(2);
  });
});

// v2 publishes the exact set of executor.sh requests v1's edge forwards to it.
// `v2-edge-contract.json` is a verbatim copy of v2's edge contract; update it
// only together with v2's contract, never by hand here. Every case runs
// through v1's real edge decision with the shipped settings.
const EdgeContract = Schema.Struct({
  origin: Schema.String,
  oauthStatePrefix: Schema.String,
  telemetry: Schema.Struct({ analyticsProxy: Schema.String, errorTunnel: Schema.String }),
  cases: Schema.Array(
    Schema.Struct({ method: Schema.String, target: Schema.String, forwards: Schema.Boolean }),
  ),
  slashRedirects: Schema.Struct({
    pages: Schema.Array(Schema.String),
    cases: Schema.Array(Schema.Struct({ target: Schema.String, location: Schema.String })),
  }),
});
const contract = Schema.decodeUnknownSync(Schema.fromJsonString(EdgeContract))(
  readFileSync(fileURLToPath(new URL("./v2-edge-contract.json", import.meta.url)), "utf8"),
);

const SIGN_UP_TARGETS: ReadonlySet<string> = new Set(["/sign-up", "/signup"]);

/** Run one contract case through v1's edge with the shipped settings and a
 *  stand-in for v2's Worker that records every call. */
const runCase = async (method: string, target: string) => {
  const calls: Request[] = [];
  const v2: V2Service = {
    fetch: (request) => {
      calls.push(request);
      return Promise.resolve(new Response("v2"));
    },
  };
  const request = new Request(`${contract.origin}${target}`, { method });
  const response = await v2EdgeResponse(request, { ...shipped, V2: v2 });
  return { request, calls, response };
};

const forwarded = contract.cases.filter((c) => c.forwards);
const signUps = contract.cases.filter((c) => !c.forwards && SIGN_UP_TARGETS.has(c.target));
const kept = contract.cases.filter((c) => !c.forwards && !SIGN_UP_TARGETS.has(c.target));

describe("v2's edge contract", () => {
  it("pins the telemetry paths and state prefix v1 ships", () => {
    expect(contract.origin).toBe("https://executor.sh");
    expect(contract.oauthStatePrefix).toBe(stringVar("V2_OAUTH_STATE_PREFIX"));
    expect(contract.telemetry.analyticsProxy).toBe(stringVar("V2_ANALYTICS_PROXY_PATH"));
    expect(contract.telemetry.errorTunnel).toBe(stringVar("V2_ERROR_TUNNEL_PATH"));
  });

  for (const { method, target } of forwarded) {
    it(`forwards ${method} ${target} to v2`, async () => {
      const { request, calls, response } = await runCase(method, target);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(request.url);
      expect(calls[0]?.method).toBe(method);
      expect(await response?.text()).toBe("v2");
    });
  }

  for (const { method, target } of kept) {
    it(`keeps ${method} ${target} with v1`, async () => {
      const { calls, response } = await runCase(method, target);
      expect(calls).toHaveLength(0);
      expect(response).toBeNull();
    });
  }

  // The front Worker answers the same requests the same way: everything the
  // contract forwards reaches v2 once, and nothing else reaches it.
  const runFrontCase = async (method: string, target: string) => {
    const calls: Request[] = [];
    const v2: V2Service = {
      fetch: (request) => {
        calls.push(request);
        return Promise.resolve(new Response("v2"));
      },
    };
    const request = new Request(`${contract.origin}${target}`, { method });
    const response = await frontResponse(request, { ...frontShipped, V2: v2 });
    return { request, calls, response };
  };

  for (const { method, target } of forwarded) {
    it(`front Worker forwards ${method} ${target} to v2`, async () => {
      const { request, calls, response } = await runFrontCase(method, target);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(request.url);
      expect(calls[0]?.method).toBe(method);
      expect(await response?.text()).toBe("v2");
    });
  }

  for (const { method, target } of contract.cases.filter((c) => !c.forwards)) {
    it(`front Worker does not forward ${method} ${target} to v2`, async () => {
      const { calls } = await runFrontCase(method, target);
      expect(calls).toHaveLength(0);
    });
  }

  // Sign-up is not forwarded: the edge redirects it to v2's sign-up page.
  it("lists both sign-up paths as not forwarded", () => {
    expect(signUps.map((c) => c.target).toSorted()).toEqual(["/sign-up", "/signup"]);
  });

  // A slashed exact page is not forwarded: the edge redirects it to the page,
  // which is. Every page v2 lists has an example.
  it("covers every slashed page v2 lists", () => {
    expect(
      contract.slashRedirects.cases
        .map((c) => new URL(c.target, contract.origin).pathname)
        .toSorted(),
    ).toEqual(expect.arrayContaining(contract.slashRedirects.pages.map((page) => `${page}/`)));
  });

  for (const { target, location } of contract.slashRedirects.cases) {
    for (const method of ["GET", "HEAD"]) {
      it(`redirects ${method} ${target} to ${location} without forwarding`, async () => {
        const { calls, response } = await runCase(method, target);
        expect(calls).toHaveLength(0);
        expect(response?.status).toBe(308);
        expect(response?.headers.get("location")).toBe(`${contract.origin}${location}`);
      });
    }
  }

  for (const { method, target } of signUps) {
    it(`redirects ${method} ${target} to v2's sign-up page without forwarding`, async () => {
      const { calls, response } = await runCase(method, target);
      expect(calls).toHaveLength(0);
      expect(response?.status).toBe(302);
      expect(response?.headers.get("location")).toBe(stringVar("V2_SIGN_UP_URL"));
    });
  }
});
