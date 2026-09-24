import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { makeTestExecutor } from "@executor-js/sdk/testing";

import { discoverGitHubSkills } from "./github";

const commit = "0123456789abcdef0123456789abcdef01234567";

const skillArchive = Effect.promise(async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  await writer.add(
    `skills-${commit}/skills/example/SKILL.md`,
    new TextReader(
      "---\nname: example\ndescription: Exercise the archive fallback.\n---\n\n# Example\n",
    ),
  );
  return writer.close();
});

const discoverWithExhaustedApi = (input: string, requestedRef: string) =>
  Effect.gen(function* () {
    const archive = yield* skillArchive;
    const http = HttpClient.make((request) => {
      if (request.url.startsWith("https://api.github.com/")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("rate limited", { status: 403 })),
        );
      }
      if (request.url === `https://github.com/example/skills/commits/${requestedRef}.atom`) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(`<id>tag:github.com,2008:Grit::Commit/${commit}</id>`, { status: 200 }),
          ),
        );
      }
      if (request.url === `https://github.com/example/skills/archive/${commit}.zip`) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(archive, { status: 200 })),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("not found", { status: 404 })),
      );
    });
    const executor = yield* makeTestExecutor();

    return yield* discoverGitHubSkills(executor, {
      input,
      owner: "user",
      tracking: "follow",
    }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient)(http)));
  });

const expectArchiveCandidate = (requestedRef: string) =>
  Effect.gen(function* () {
    const input =
      requestedRef === "HEAD"
        ? "https://github.com/example/skills"
        : `https://github.com/example/skills/tree/${requestedRef}/skills`;
    const result = yield* discoverWithExhaustedApi(input, requestedRef);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.revision.name).toBe("example");
    expect(result.candidates[0]?.source).toMatchObject({
      locator: { requestedRef, resolvedCommit: commit },
      tracking: { symbolicReference: requestedRef, resolvedRevision: commit },
    });
  });

describe("discoverGitHubSkills", () => {
  it.effect("falls back for a repository URL when the GitHub API limit is exhausted", () =>
    expectArchiveCandidate("HEAD"),
  );

  it.effect("falls back for a tree URL when the GitHub API limit is exhausted", () =>
    expectArchiveCandidate("main"),
  );
});
