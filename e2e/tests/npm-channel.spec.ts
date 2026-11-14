/**
 * `scripts/releases/npm-channel.ts` waits for npm's dist-tags to name a release npm already serves,
 * as `publish-npm.ts` does after publishing. These cases run it as a process against a local
 * registry that replays what npm's dist-tags endpoint answered after beta.51's publish: the old
 * tag for a while, then the new one; or the old one for good.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

type Tags = Readonly<Record<string, string>>;

/** One answer of the dist-tags endpoint: tags, a status with a body, or no answer at all. */
type Answer = Tags | { readonly status: number; readonly body: string } | "hang";

const isStatus = (answer: Answer): answer is { readonly status: number; readonly body: string } =>
  typeof answer === "object" && typeof answer.status === "number";

/**
 * A registry whose `/-/package/executor/dist-tags` gives `answers` in order, repeating the last.
 * Counts the requests.
 */
const registry = (answers: ReadonlyArray<Answer>) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; requests: () => number; close: () => void }>((resume) => {
      let requests = 0;
      const hanging: Array<ServerResponse> = [];
      const server = createServer((request, response) => {
        const answer = answers[Math.min(requests, answers.length - 1)];
        if (request.url !== "/-/package/executor/dist-tags" || answer === undefined) {
          response.writeHead(404).end();
          return;
        }
        requests += 1;
        if (answer === "hang") {
          hanging.push(response);
          return;
        }
        const [status, body] = isStatus(answer)
          ? [answer.status, answer.body]
          : [200, JSON.stringify(answer)];
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body);
      });
      server.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            requests: () => requests,
            close: () => {
              for (const response of hanging) response.destroy();
              server.close();
            },
          }),
        ),
      );
    }),
    (stub) => Effect.sync(stub.close),
  );

const before: Tags = { latest: "1.6.11", beta: "2.0.0-beta.50" };
const published: Tags = { latest: "1.6.11", beta: "2.0.0-beta.51" };

/** The wait as a process, against `registry` with a 3 s limit, unless `env` says otherwise. */
const wait = (registry: string, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["scripts/releases/npm-channel.ts"], {
        env: {
          NPM_CHANNEL_REGISTRY: registry,
          NPM_CHANNEL: "beta",
          NPM_CHANNEL_VERSION: "2.0.0-beta.51",
          NPM_CHANNEL_BEFORE: JSON.stringify(before),
          NPM_CHANNEL_LIMIT_SECONDS: "3",
          NPM_CHANNEL_POLL_SECONDS: "0.1",
          NPM_CHANNEL_ATTEMPT_SECONDS: "0.5",
          ...env,
        },
        extendEnv: true,
      }),
    );
    const started = Date.now();
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode: Number(exitCode), log, seconds: (Date.now() - started) / 1000 };
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("publication waits for npm's channel tag", (it) => {
  it.effect("a tag npm moves after it serves the version is waited for", () =>
    Effect.gen(function* () {
      const stub = yield* registry([before, before, before, published]);
      const result = yield* wait(stub.url);
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain("npm's beta tag names 2.0.0-beta.51; latest=1.6.11");
      expect(result.log).toContain("npm's beta tag still names 2.0.0-beta.50");
      expect(stub.requests()).toBe(4);
    }).pipe(Effect.scoped),
  );

  it.effect("a tag that never moves fails at the limit, naming what it still says", () =>
    Effect.gen(function* () {
      const stub = yield* registry([before]);
      const result = yield* wait(stub.url);
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain("its beta tag did not name it within 3 s");
      expect(result.log).toContain("the last read: npm's beta tag still names 2.0.0-beta.50");
      expect(result.seconds).toBeLessThan(15);
      expect(stub.requests()).toBeGreaterThan(5);
    }).pipe(Effect.scoped),
  );

  it.effect("a beta publication that moved latest fails at once", () =>
    Effect.gen(function* () {
      const stub = yield* registry([{ latest: "2.0.0-beta.51", beta: "2.0.0-beta.51" }]);
      const result = yield* wait(stub.url);
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain("latest tag names 2.0.0-beta.51, not 1.6.11");
      expect(stub.requests()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a tag naming some third version fails at once", () =>
    Effect.gen(function* () {
      const stub = yield* registry([{ latest: "1.6.11", beta: "2.0.0-beta.52" }]);
      const result = yield* wait(stub.url);
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain("names 2.0.0-beta.52: neither 2.0.0-beta.51 nor 2.0.0-beta.50");
      expect(stub.requests()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("an error, an unreadable answer and no answer are asked again", () =>
    Effect.gen(function* () {
      const stub = yield* registry([
        { status: 503, body: "{}" },
        { status: 200, body: "not json" },
        "hang",
        published,
      ]);
      const result = yield* wait(stub.url);
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain("the registry answered 503");
      expect(result.log).toContain("the registry answered unreadably");
      expect(result.log).toContain("the registry did not answer within 0.5 s");
      expect(stub.requests()).toBe(4);
    }).pipe(Effect.scoped),
  );

  it.effect("a resumed job whose tag already names the release passes on one read", () =>
    Effect.gen(function* () {
      const stub = yield* registry([published]);
      const result = yield* wait(stub.url, { NPM_CHANNEL_BEFORE: JSON.stringify(published) });
      expect(result.exitCode, result.log).toBe(0);
      expect(stub.requests()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("a stable release waits for latest and may move it", () =>
    Effect.gen(function* () {
      const stub = yield* registry([before, { latest: "2.0.0", beta: "2.0.0-beta.50" }]);
      const result = yield* wait(stub.url, { NPM_CHANNEL: "latest", NPM_CHANNEL_VERSION: "2.0.0" });
      expect(result.exitCode, result.log).toBe(0);
      expect(stub.requests()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("npm's own wait cannot be shortened", () =>
    Effect.gen(function* () {
      const result = yield* wait("https://registry.npmjs.org");
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain("apply only to another registry");
    }).pipe(Effect.scoped),
  );
});
