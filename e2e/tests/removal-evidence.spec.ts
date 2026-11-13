/**
 * A stalled organization removal's records are saved before its stage is destroyed. The fixture
 * server notes the removal in `removal-stalls.jsonl`; the deployed runner reads Cloudflare's API
 * for the stage's API Worker, its `OrganizationRemoval` Workflow, that instance and the Worker's
 * logs naming the organization, and writes `removal-stalls.json`. A local server stands in for
 * Cloudflare's API and records what it was asked.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  captureRemovalStalls,
  removalEvidenceFile,
  removalStallsFile,
} from "../sdk/removal-evidence.ts";
import { secret } from "../support/failure-text.ts";

const account = "acct0000";
const token = "cf-SYNTHETIC-token-0001";
const slug = "e2e-stall0";
const apiScript = "executor-next-hosted-api-test-stall0hash";
const workflow = `${apiScript}-c3a498af`;
const organization = "Qm7Xk2pLw9Rt4Zb1Nc8Vd3Hs6Jf0Ga5E";
// A secret the runner holds, as it holds the emulator instance URLs and keys, and a URL whose
// query carries a credential. Log events and step causes can quote either.
const heldValue = "emu-instance-SYNTH-7731";
const queryToken = "SYNTHQUERYTOKEN4821";
const loggedUrl = `https://emulators.example/resend/kind-x/emails?token=${queryToken}`;

type Seen = { method: string; path: string; authorization: string | undefined; body: string };

/** Cloudflare's account API for one stage: two pages of scripts, its Workflows, one instance. */
const cloudflare = (seen: Seen[], { instanceStatus }: { instanceStatus: number }) =>
  Effect.acquireRelease(
    Effect.callback<{ origin: string; close: () => void }>((resume) => {
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const url = new URL(request.url ?? "/", "http://localhost");
          seen.push({
            method: request.method ?? "",
            path: url.pathname + url.search,
            authorization: request.headers.authorization,
            body,
          });
          const json = (status: number, value: unknown) =>
            response
              .writeHead(status, { "content-type": "application/json" })
              .end(JSON.stringify(value));
          const prefix = `/accounts/${account}`;
          const page = Number(url.searchParams.get("page") ?? "1");
          if (url.pathname === `${prefix}/workers/scripts`)
            return json(200, {
              success: true,
              result:
                page === 1
                  ? [
                      // Another stage's API Worker, and this stage's Marketing Worker.
                      { id: "other-api", tags: ["alchemy:stage:test-e2e-other", "alchemy:id:Api"] },
                      {
                        id: "marketing",
                        tags: [`alchemy:stage:test-${slug}`, "alchemy:id:Marketing"],
                      },
                    ]
                  : [{ id: apiScript, tags: [`alchemy:stage:test-${slug}`, "alchemy:id:Api"] }],
              result_info: { total_pages: 2 },
            });
          if (url.pathname === `${prefix}/workflows`)
            return json(200, {
              success: true,
              result: [
                {
                  name: `${apiScript}-aaaa0000`,
                  class_name: "AppWorkflows",
                  script_name: apiScript,
                },
                { name: workflow, class_name: "OrganizationRemoval", script_name: apiScript },
                {
                  name: "other-removal",
                  class_name: "OrganizationRemoval",
                  script_name: "other-api",
                },
              ],
              result_info: { total_pages: 1 },
            });
          if (url.pathname === `${prefix}/workflows/${workflow}/instances/instance-1`)
            return instanceStatus === 200
              ? json(200, {
                  success: true,
                  result: {
                    status: "running",
                    steps: [
                      { name: "delete-auth-records", type: "step", success: true, attempts: [{}] },
                    ],
                  },
                })
              : json(instanceStatus, { success: false, errors: [{ code: 10000 }] });
          if (url.pathname === `${prefix}/workers/observability/telemetry/query`)
            return json(200, {
              success: true,
              result: {
                events: {
                  events: [
                    {
                      message: "x",
                      cause: `Organization removal step failed: POST ${loggedUrl} for ${heldValue}`,
                    },
                  ],
                },
              },
            });
          return json(404, { success: false });
        });
      });
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resume(Effect.succeed({ origin: `http://localhost:${port}`, close: () => server.close() }));
      });
    }),
    ({ close }) => Effect.sync(close),
  );

const withCloudflare = () =>
  Layer.mergeAll(
    FetchHttpClient.layer,
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CLOUDFLARE_ACCOUNT_ID: account,
        CLOUDFLARE_API_TOKEN: token,
      }),
    ),
  );

const stall = (instance: string | null) =>
  `${JSON.stringify({
    organization,
    instance,
    status: "running",
    phase: "wait-for-removal",
    at: "2026-11-12T19:39:30.000Z",
  })}\n`;

layer(NodeServices.layer, { excludeTestServices: true })("Removal stall evidence", (it) => {
  it.effect("saves the stalled removal's Workflow instance and the API Worker's logs", () =>
    Effect.gen(function* () {
      // Registered before the capture, as the runner registers the emulator secrets at start.
      secret(heldValue);
      const fs = yield* FileSystem.FileSystem;
      const seen: Seen[] = [];
      const { origin } = yield* cloudflare(seen, { instanceStatus: 200 });
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "removal-evidence-" });
      const { join } = yield* Path.Path;
      // A line the fixture server could not finish is skipped, not fatal.
      yield* fs.writeFileString(
        join(directory, removalStallsFile),
        `${stall("instance-1")}{"organization":`,
      );

      yield* captureRemovalStalls(slug, directory, origin).pipe(Effect.provide(withCloudflare()));

      const saved = JSON.parse(yield* fs.readFileString(join(directory, removalEvidenceFile)));
      expect(saved.removals).toHaveLength(1);
      const [removal] = saved.removals;
      // Values of 40 characters or more (the Worker and Workflow names) are masked as opaque; a
      // test stage's synthetic organization id is shorter and kept, as is what Cloudflare said.
      expect(saved.apiScript).toBe("<opaque>");
      expect(removal.workflow).toBe("<opaque>");
      expect(removal.stall).toMatchObject({
        organization,
        status: "running",
        phase: "wait-for-removal",
      });
      expect(removal.instance).toMatchObject({ status: "running" });
      expect(removal.instance.steps[0]).toMatchObject({ name: "delete-auth-records" });
      expect(removal.logs).toMatchObject({ events: { events: [{ message: "x" }] } });

      // Every call carried the token; the logs query names the organization and the API Worker,
      // starting two minutes before the stall.
      for (const call of seen) expect(call.authorization).toBe(`Bearer ${token}`);
      const query = seen.find((call) => call.path.endsWith("/telemetry/query"));
      const body = JSON.parse(query?.body ?? "{}");
      expect(body.parameters.needle.value).toBe(organization);
      expect(body.parameters.filters[0]).toMatchObject({
        key: "$workers.scriptName",
        value: apiScript,
      });
      expect(body.timeframe.from).toBe(Date.parse("2026-11-12T19:37:30.000Z"));
      // Nothing is written back to Cloudflare.
      expect(
        seen.filter((call) => call.method !== "GET" && !call.path.endsWith("/telemetry/query")),
      ).toEqual([]);
      // The saved record never holds the token, a held secret or a URL's query.
      const text = yield* fs.readFileString(join(directory, removalEvidenceFile));
      expect(text).not.toContain(token);
      expect(text).not.toContain(heldValue);
      expect(text).not.toContain(queryToken);
      expect(text).toContain("https://emulators.example/resend/kind-x/emails");
    }),
  );

  it.effect("records a refused read and carries on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const seen: Seen[] = [];
      const { origin } = yield* cloudflare(seen, { instanceStatus: 403 });
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "removal-evidence-" });
      const { join } = yield* Path.Path;
      yield* fs.writeFileString(
        join(directory, removalStallsFile),
        `${stall("instance-1")}${stall(null)}`,
      );

      yield* captureRemovalStalls(slug, directory, origin).pipe(Effect.provide(withCloudflare()));

      const saved = JSON.parse(yield* fs.readFileString(join(directory, removalEvidenceFile)));
      expect(saved.removals.map((removal: { instance: unknown }) => removal.instance)).toEqual([
        { error: "HTTP 403" },
        { error: "no instance id" },
      ]);
      // The logs are still read for both.
      expect(seen.filter((call) => call.path.endsWith("/telemetry/query"))).toHaveLength(2);
    }),
  );

  it.effect("does nothing when no removal stalled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const seen: Seen[] = [];
      const { origin } = yield* cloudflare(seen, { instanceStatus: 200 });
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "removal-evidence-" });
      const { join } = yield* Path.Path;

      yield* captureRemovalStalls(slug, directory, origin).pipe(Effect.provide(withCloudflare()));

      expect(yield* fs.exists(join(directory, removalEvidenceFile))).toBe(false);
      expect(seen).toEqual([]);
    }),
  );
});
