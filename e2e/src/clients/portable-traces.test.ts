import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { writeJsonAtomicSync } from "../artifact-io";
import { exportPortableTraces } from "../portable-traces";

const TRACE_ID = "0123456789abcdef0123456789abcdef";

const temporaryRun = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-portable-traces-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
);

it.live("exports eventually available Motel traces and redacts secrets", () =>
  Effect.gen(function* () {
    const runDir = yield* temporaryRun;
    let requests = 0;
    const httpClient = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
        Effect.sync(() => {
          requests += 1;
          const body =
            requests === 1
              ? { error: "not ready" }
              : {
                  data: {
                    traceId: TRACE_ID,
                    tags: {
                      authorization: "Bearer secret-token",
                      route: "/api/tools?access_token=secret-token",
                    },
                  },
                };
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status: requests === 1 ? 404 : 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    writeJsonAtomicSync(join(runDir, "traces.json"), [
      { id: TRACE_ID },
      { id: TRACE_ID },
      { id: "invalid" },
    ]);

    const exported = yield* exportPortableTraces(runDir, "http://motel.invalid").pipe(
      Effect.provide(httpClient),
    );
    const artifact = readFileSync(join(runDir, "otel-traces.json"), "utf8");
    expect(exported, artifact).toEqual({
      file: "otel-traces.json",
      exported: 1,
      missing: 0,
      invalid: 1,
    });

    expect(artifact).toContain(TRACE_ID);
    expect(artifact).toContain("[REDACTED]");
    expect(artifact).not.toContain("secret-token");
  }),
);
