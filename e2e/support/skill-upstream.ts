/** Mutable publication fixture outside the real Executor server and isolated app runtime. */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, FileSystem, Layer, Ref, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";

type FileFailure = "oversized" | "encoding" | "redirect";

/** Serve well-known and GitHub-shaped publications with controlled changes and incomplete generations. */
export const skillUpstream = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const repository = yield* fs.makeTempDirectoryScoped({ prefix: "executor-skill-publication-" });
  const git = (args: readonly string[], input?: Uint8Array) =>
    Effect.gen(function* () {
      const process = yield* processes.spawn(
        ChildProcess.make(
          "git",
          ["-c", "user.name=Skill fixture", "-c", "user.email=fixture@example.invalid", ...args],
          {
            cwd: repository,
            env: {
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_PROTOCOL: "version=2",
            },
            stdin: input === undefined ? "ignore" : Stream.make(input),
            stderr: "ignore",
          },
        ),
      );
      const chunks = yield* Stream.runCollect(process.stdout);
      const code = yield* process.exitCode;
      if (code !== 0) return yield* Effect.die(new Error(`Skill fixture git exited ${code}`));
      return Buffer.concat(chunks);
    }).pipe(Effect.scoped);
  yield* git(["init", "--quiet", "--initial-branch=main"]);
  yield* git(["config", "uploadpack.allowFilter", "true"]);
  yield* fs.makeDirectory(`${repository}/skills/github-guide/references`, { recursive: true });
  const versions = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const publication = (version: number) =>
    Effect.gen(function* () {
      yield* fs.writeFileString(
        `${repository}/skills/github-guide/SKILL.md`,
        `---\nname: github-guide\ndescription: Published instructions.\n---\n# Guide ${version}\nRead [example](references/example.md).`,
      );
      yield* fs.writeFileString(
        `${repository}/skills/github-guide/references/example.md`,
        `# Reference ${version}`,
      );
      yield* git(["add", "skills"]);
      yield* git(["commit", "--quiet", "--allow-empty", "-m", `Publish ${version}`]);
      const commit = yield* Schema.decodeUnknownEffect(
        Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
      )((yield* git(["rev-parse", "HEAD"])).toString("utf8").trim());
      yield* Ref.update(versions, (current) => new Map([...current, [commit, version]]));
      return commit;
    });
  const commit = yield* publication(1);
  const state = yield* Ref.make<{
    version: number;
    commit: string;
    broken: boolean;
    traversal: boolean;
    malformed: "github" | "well-known" | undefined;
    fileFailure: FileFailure | undefined;
  }>({
    version: 1,
    commit,
    broken: false,
    traversal: false,
    malformed: undefined,
    fileFailure: undefined,
  });
  const requests = yield* Ref.make<string[]>([]);
  const route = HttpRouter.add(
    "*",
    "/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://fixture.invalid");
      yield* Ref.update(requests, (items) => [...items, url.pathname]);
      const current = yield* Ref.get(state);
      if (
        request.method === "POST" &&
        url.pathname === "/github/synthetic/skills.git/git-upload-pack"
      )
        return HttpServerResponse.uint8Array(
          yield* git(
            ["upload-pack", "--stateless-rpc", repository],
            new Uint8Array(yield* request.arrayBuffer),
          ),
          { contentType: "application/x-git-upload-pack-result" },
        );
      if (url.pathname.endsWith("/index.json"))
        return HttpServerResponse.jsonUnsafe({
          skills: [
            {
              name: "remote-guide",
              version: String(current.version),
              files: ["SKILL.md", current.traversal ? "../private.txt" : "references/example.md"],
            },
          ],
        });
      const github = url.pathname.startsWith("/github/synthetic/skills/");
      const name = github ? "github-guide" : "remote-guide";
      const version = github
        ? (yield* Ref.get(versions)).get(url.pathname.split("/")[4] ?? "")
        : current.version;
      if (version === undefined) return HttpServerResponse.empty({ status: 404 });
      if (url.pathname.endsWith("/SKILL.md"))
        return HttpServerResponse.text(
          current.malformed === (github ? "github" : "well-known")
            ? "Missing frontmatter"
            : `---\nname: ${name}\ndescription: Published instructions.\n---\n# Guide ${version}\nRead [example](references/example.md).`,
        );
      if (url.pathname.endsWith("/references/example.md")) {
        if (current.fileFailure === "oversized")
          return HttpServerResponse.text("x".repeat(2_000_001));
        if (current.fileFailure === "encoding")
          return HttpServerResponse.uint8Array(Uint8Array.of(0xff));
        if (current.fileFailure === "redirect") return HttpServerResponse.redirect("/private.txt");
        return current.broken
          ? HttpServerResponse.empty({ status: 503 })
          : HttpServerResponse.text(`# Reference ${version}`);
      }
      return HttpServerResponse.empty({ status: 404 });
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(route, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    url: `http://127.0.0.1:${server.address.port}`,
    publish: (
      version: number,
      options: {
        broken?: boolean;
        traversal?: boolean;
        malformed?: "github" | "well-known";
        fileFailure?: FileFailure;
      } = {},
    ) =>
      Effect.gen(function* () {
        const commit = yield* publication(version);
        yield* Ref.set(state, {
          version,
          commit,
          broken: options.broken ?? false,
          traversal: options.traversal ?? false,
          malformed: options.malformed,
          fileFailure: options.fileFailure,
        });
      }),
    commit: Ref.get(state).pipe(Effect.map((current) => current.commit)),
    requests: Ref.get(requests),
  };
});
