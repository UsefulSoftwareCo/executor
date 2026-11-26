import { randomBytes, randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { appsManifest } from "../support/apps-release.ts";
import { HostedLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, roleHost } from "../support/role-hosts.ts";

interface Probe {
  readonly name: string;
  readonly url: string;
  readonly status: number;
  readonly route: string;
}

const probeRoutes = (probes: ReadonlyArray<Probe>, headers = {}) =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const recorded: Record<string, { status: number; tags: Readonly<Record<string, string>> }> = {};
    for (const probe of probes) {
      const traceId = randomBytes(16).toString("hex"),
        parent = randomBytes(8).toString("hex");
      const response = yield* rawRequest(probe.url, {
        headers: { ...headers, traceparent: `00-${traceId}-${parent}-01` },
      });
      const tags = yield* telemetry.query(traceId).pipe(
        Effect.flatMap((result) => {
          const found = result.data.find(
            ({ span }) =>
              span.parentSpanId === parent && span.operationName.startsWith("http.server"),
          );
          return found === undefined
            ? Effect.fail(new Error(`No server span for ${probe.name}`))
            : Effect.succeed(found.span.tags);
        }),
        Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
      );
      recorded[probe.name] = { status: response.status, tags };
    }
    return recorded;
  });

const expectTemplates = (
  probes: ReadonlyArray<Probe>,
  recorded: Effect.Success<ReturnType<typeof probeRoutes>>,
  marker: string,
) =>
  expect(
    Object.fromEntries(
      Object.entries(recorded).map(([name, { status, tags }]) => [
        name,
        {
          status,
          path: tags["url.path"],
          route: tags["http.route"],
          marker: JSON.stringify(tags).includes(marker),
        },
      ]),
    ),
  ).toEqual(
    Object.fromEntries(
      probes.map((probe) => [
        probe.name,
        { status: probe.status, path: probe.route, route: probe.route, marker: false },
      ]),
    ),
  );

layer(HostedLive, { excludeTestServices: true })("Wildcard route telemetry", (it) => {
  it.effect(scenarios.wildcardRouteTelemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          target = yield* Target;
        const origin = target.metadata.origin;
        const cloud = target.metadata.target === "cloud";
        const marker = `route-marker-${randomUUID().slice(0, 8)}`;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Route probe ${marker.slice(-8)}`,
          files: [
            {
              path: "index.ts",
              content: 'import { defineApp } from "apps"; export default defineApp({}, {});',
            },
            { path: "ui/index.html", content: "<!doctype html><h1>Route probe</h1>" },
            appsManifest,
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const appOrigin = new URL(yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`))
          .origin;
        const probes: ReadonlyArray<Probe> = [
          {
            name: "auth endpoint",
            url: `${origin}/api/auth/get-session`,
            status: 200,
            route: "/api/auth/get-session",
          },
          {
            name: "unknown auth path",
            url: `${origin}/api/auth/${marker}`,
            status: 404,
            route: "/api/auth/*",
          },
          {
            name: "app host not found",
            url: `${appOrigin}/_executor/${marker}`,
            status: 404,
            route: "/_executor/*",
          },
          ...(cloud
            ? [
                {
                  name: "SSO callback",
                  url: `${origin}/api/auth/sso/callback/sso-${marker}`,
                  status: 302,
                  route: "/api/auth/sso/callback/:providerId",
                },
                {
                  name: "analytics",
                  url: `${origin}/api/${randomBytes(8).toString("hex")}/array/${marker}/config.js`,
                  status: 404,
                  route: "/api/:channel/*",
                },
                {
                  name: "site page",
                  url: `${roleHost(origin, "edge")}/docs/${marker}`,
                  status: 404,
                  route: "/docs/*",
                },
              ]
            : []),
        ];
        const recorded = yield* probeRoutes(probes);
        yield* evidence.json("wildcard-route-spans.json", recorded);
        expectTemplates(probes, recorded, marker);
      }),
    ),
  );

  it.effect(scenarios.localWildcardRouteTelemetry.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence,
          target = yield* Target;
        const origin = target.metadata.origin;
        const marker = `route-marker-${randomUUID().slice(0, 8)}`;
        const probes: ReadonlyArray<Probe> = [
          {
            name: "unknown auth path",
            url: `${origin}/api/auth/${marker}`,
            status: 404,
            route: "/api/auth/*",
          },
          {
            name: "dashboard page",
            url: `${origin}/${marker}/page`,
            status: 404,
            route: "*",
          },
        ];
        const recorded = yield* probeRoutes(probes, {
          authorization: `Bearer ${Redacted.value(target.apiKey)}`,
        });
        yield* evidence.json("wildcard-route-spans.json", recorded);
        expectTemplates(probes, recorded, marker);
      }),
    ),
  );
});
