/**
 * `scripts/releases/channel-guard.ts` stops a publish step that would move a release channel
 * backwards, and `scripts/releases/publication-report.ts` says what a failed publish job made
 * public. These cases run both as processes against one local stub that answers as each public
 * surface does: npm's dist-tags and versions, GHCR's token, manifests and image configs, the
 * desktop feed's files, the tap's formula and the GitHub release. No case reaches the network.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const repository = "SyntheticOrg/executor";
const image = "ghcr.io/syntheticorg/executor-selfhost";
const imageRepository = "syntheticorg/executor-selfhost";
const tap = "SyntheticOrg/homebrew-tap";
const feedTag = "executor-v2-desktop-updates";

/** What each public surface names. Absent keys answer 404. */
type State = {
  readonly npmTags?: Readonly<Record<string, string>>;
  readonly npmVersions?: ReadonlyArray<string>;
  /** Versions npm holds with this archive, and when and whether it deprecated them. */
  readonly npmArchives?: Readonly<
    Record<
      string,
      { readonly integrity: string; readonly deprecated?: string; readonly time?: string }
    >
  >;
  /** Image tags and the version label of the image each names. */
  readonly images?: Readonly<Record<string, string>>;
  /** Feed file names and the version each names. */
  readonly feed?: Readonly<Record<string, string>>;
  /** Formula names (`executor-beta`) and the version each names. */
  readonly formulas?: Readonly<Record<string, string>>;
  readonly release?: { readonly draft: boolean; readonly assets: number; readonly target?: string };
  /** Every request answers 500. */
  readonly broken?: boolean;
  /** These surfaces answer 500 to every request. */
  readonly failing?: ReadonlyArray<"npm" | "ghcr" | "feed" | "raw" | "api">;
  /** These surfaces never answer. */
  readonly hanging?: ReadonlyArray<"npm" | "ghcr" | "feed" | "raw" | "api">;
  /** npm's dist-tags answer 503 to this many requests first. */
  readonly flakyTags?: number;
};

const json = (body: unknown) => ({ status: 200, body: JSON.stringify(body) });
const missing = { status: 404, body: "{}" };

/** The answer `state` gives for `url`. Image manifests are an index, then one image, then a config. */
/** Which surface a route belongs to, for `failing`. */
const surfaceOf = (route: string) =>
  route === "/token" || route.startsWith("/v2/")
    ? "ghcr"
    : route.startsWith("/repos/")
      ? "api"
      : route.includes("/releases/download/")
        ? "feed"
        : route.includes("/HEAD/Formula/")
          ? "raw"
          : "npm";

const answer = (state: State, url: string, tagReads: number): { status: number; body: string } => {
  if (state.broken === true) return { status: 500, body: "{}" };
  const route = new URL(url, "http://stub").pathname;
  if (state.failing?.includes(surfaceOf(route)) === true) return { status: 500, body: "{}" };
  if (route === "/-/package/executor/dist-tags") {
    if (tagReads <= (state.flakyTags ?? 0)) return { status: 503, body: "{}" };
    return state.npmTags === undefined ? missing : json(state.npmTags);
  }
  if (route === "/executor")
    return json({
      time: Object.fromEntries(
        Object.entries(state.npmArchives ?? {}).flatMap(([held, archive]) =>
          archive.time === undefined ? [] : [[held, archive.time]],
        ),
      ),
    });
  const version = /^\/executor\/(.+)$/u.exec(route)?.[1];
  if (version !== undefined) {
    const archive = state.npmArchives?.[version];
    if (archive !== undefined)
      return json({
        version,
        dist: { integrity: archive.integrity },
        ...(archive.deprecated === undefined ? {} : { deprecated: archive.deprecated }),
      });
    return state.npmVersions?.includes(version) === true
      ? json({ version, dist: { integrity: "sha512-synthetic" } })
      : missing;
  }
  if (route === "/token") return json({ token: "synthetic-token" });
  const manifest = new RegExp(`^/v2/${imageRepository}/manifests/(.+)$`, "u").exec(route)?.[1];
  if (manifest !== undefined) {
    const single = /^sha256:image-(.+)$/u.exec(manifest)?.[1];
    if (single !== undefined) return json({ config: { digest: `sha256:config-${single}` } });
    if (state.images?.[manifest] === undefined) return missing;
    return json({
      manifests: [
        { digest: `sha256:image-${manifest}`, platform: { os: "linux", architecture: "amd64" } },
      ],
    });
  }
  const config = new RegExp(`^/v2/${imageRepository}/blobs/sha256:config-(.+)$`, "u").exec(
    route,
  )?.[1];
  if (config !== undefined) {
    const labelled = state.images?.[config];
    return labelled === undefined
      ? missing
      : json({ config: { Labels: { "org.opencontainers.image.version": labelled } } });
  }
  const file = new RegExp(`^/${repository}/releases/download/${feedTag}/(.+)$`, "u").exec(
    route,
  )?.[1];
  if (file !== undefined) {
    const named = state.feed?.[file];
    return named === undefined ? missing : json({ version: named, files: [] });
  }
  const formula = new RegExp(`^/${tap}/HEAD/Formula/(.+)\\.rb$`, "u").exec(route)?.[1];
  if (formula !== undefined) {
    const named = state.formulas?.[formula];
    return named === undefined
      ? missing
      : { status: 200, body: `class ExecutorBeta < Formula\n  version "${named}"\nend\n` };
  }
  if (route.startsWith(`/repos/${repository}/releases/tags/`))
    return state.release === undefined
      ? missing
      : json({
          draft: state.release.draft,
          assets: Array.from({ length: state.release.assets }),
          ...(state.release.target === undefined ? {} : { target_commitish: state.release.target }),
        });
  return missing;
};

/** One stub serving every surface from `state`. */
const surfaces = (state: State) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; paths: () => ReadonlyArray<string>; close: () => void }>(
      (resume) => {
        let tagReads = 0;
        const asked: Array<string> = [];
        const hung: Array<ServerResponse> = [];
        const server = createServer((request, response) => {
          const route = new URL(request.url ?? "/", "http://stub").pathname;
          asked.push(route);
          if (state.hanging?.includes(surfaceOf(route)) === true) {
            hung.push(response);
            return;
          }
          if (
            new URL(request.url ?? "/", "http://stub").pathname === "/-/package/executor/dist-tags"
          )
            tagReads += 1;
          const { status, body } = answer(state, request.url ?? "/", tagReads);
          response.writeHead(status, { "content-type": "application/json" });
          response.end(body);
        });
        server.listen(0, "127.0.0.1", () =>
          resume(
            Effect.succeed({
              url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
              paths: () => [...asked],
              close: () => {
                for (const response of hung) response.destroy();
                server.close();
              },
            }),
          ),
        );
      },
    ),
    (stub) => Effect.sync(stub.close),
  );

/** Runs `script` with `args` against the stub, as the publish job would for VERSION and CHANNEL. */
const run = (
  stub: string,
  script: "channel-guard.ts" | "publication-report.ts",
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make("node", [`scripts/releases/${script}`, ...args], {
        env: {
          EXECUTOR_PUBLIC_NPM: stub,
          EXECUTOR_PUBLIC_GHCR: stub,
          EXECUTOR_PUBLIC_GITHUB: stub,
          EXECUTOR_PUBLIC_GITHUB_API: stub,
          EXECUTOR_PUBLIC_RAW: stub,
          EXECUTOR_PUBLIC_RETRY_SECONDS: "0.05",
          IMAGE: image,
          PUBLIC_REPOSITORY: repository,
          RELEASE_TAG: `executor@${env.VERSION ?? ""}`,
          GITHUB_RUN_ID: "4242",
          ...env,
        },
        extendEnv: true,
      }),
    );
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode: Number(exitCode), log };
  }).pipe(Effect.scoped);

const guard = (state: State, surface: string, version: string, extra: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const stub = yield* surfaces(state);
    return yield* run(stub.url, "channel-guard.ts", [surface, ...extra], {
      VERSION: version,
      CHANNEL: version.includes("-beta.") ? "beta" : "latest",
    });
  }).pipe(Effect.scoped);

const betaFeed = (version: string) => ({
  "executor-v2-beta-mac.yml": version,
  "executor-v2-beta.yml": version,
  "executor-v2-beta-linux.yml": version,
  "executor-v2-beta-linux-arm64.yml": version,
});

layer(NodeServices.layer)("a publish step never moves a channel backwards", (it) => {
  it.effect(
    "an image channel naming a newer beta stops the step, ordering beta.10 after beta.9",
    () =>
      Effect.gen(function* () {
        const result = yield* guard({ images: { beta: "2.0.0-beta.10" } }, "image", "2.0.0-beta.9");
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain(
          `${image}:beta names 2.0.0-beta.10: newer than 2.0.0-beta.9. Nothing was changed`,
        );
      }),
  );

  it.effect("the same, an older or no image channel lets the step go on", () =>
    Effect.gen(function* () {
      for (const [images, version] of [
        [{ beta: "2.0.0-beta.10" }, "2.0.0-beta.10"],
        [{ beta: "2.0.0-beta.9" }, "2.0.0-beta.10"],
        [{}, "2.0.0-beta.10"],
      ] as const) {
        const result = yield* guard({ images }, "image", version);
        expect(result.exitCode, result.log).toBe(0);
      }
    }),
  );

  it.effect("npm's tag naming a newer release stops the npm step", () =>
    Effect.gen(function* () {
      const result = yield* guard(
        { npmTags: { latest: "1.6.11", beta: "2.0.0-beta.52" } },
        "npm",
        "2.0.0-beta.51",
      );
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain("npm's executor@beta names 2.0.0-beta.52: newer than");
    }),
  );

  it.effect("a stable release may move latest past Executor 1, and never back", () =>
    Effect.gen(function* () {
      const forward = yield* guard({ npmTags: { latest: "1.6.11" } }, "npm", "2.0.0");
      expect(forward.exitCode, forward.log).toBe(0);
      const back = yield* guard({ npmTags: { latest: "2.0.1" } }, "npm", "2.0.0");
      expect(back.exitCode, back.log).toBe(1);
    }),
  );

  it.effect("the tap's formula naming a newer beta stops the Homebrew step", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-tap-" });
      yield* fs.makeDirectory(path.join(directory, "Formula"));
      const fresh = yield* guard({}, "homebrew", "2.0.0-beta.51", [directory]);
      expect(fresh.exitCode, fresh.log).toBe(0);
      yield* fs.writeFileString(
        path.join(directory, "Formula/executor-beta.rb"),
        'class ExecutorBeta < Formula\n  version "2.0.0-beta.52"\nend\n',
      );
      const result = yield* guard({}, "homebrew", "2.0.0-beta.51", [directory]);
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain("the executor-beta formula names 2.0.0-beta.52: newer than");
    }).pipe(Effect.scoped),
  );

  it.effect("the Homebrew step's check stops when the tap directory is missing", () =>
    Effect.gen(function* () {
      const result = yield* guard({}, "homebrew", "2.0.0-beta.51", ["/nonexistent/executor-tap"]);
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain(
        "The tap directory /nonexistent/executor-tap does not exist. Nothing was changed",
      );
    }),
  );

  it.effect("one desktop feed file naming a newer beta stops the feed step", () =>
    Effect.gen(function* () {
      const feed = { ...betaFeed("2.0.0-beta.51"), "executor-v2-beta-linux.yml": "2.0.0-beta.52" };
      const result = yield* guard({ feed }, "desktop-feed", "2.0.0-beta.51");
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain("executor-v2-beta-linux.yml names 2.0.0-beta.52");
      const ok = yield* guard({ feed: betaFeed("2.0.0-beta.50") }, "desktop-feed", "2.0.0-beta.51");
      expect(ok.exitCode, ok.log).toBe(0);
    }),
  );

  it.effect("a beta never moves the stable channel", () =>
    Effect.gen(function* () {
      const stub = yield* surfaces({ npmTags: { latest: "1.6.11" } });
      const result = yield* run(stub.url, "channel-guard.ts", ["npm"], {
        VERSION: "2.0.0-beta.51",
        CHANNEL: "latest",
      });
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain("a beta never moves the stable channel");
    }).pipe(Effect.scoped),
  );

  it.effect("a value it cannot order, or a surface it cannot read, stops the step", () =>
    Effect.gen(function* () {
      const odd = yield* guard(
        { npmTags: { latest: "1.6.11", beta: "next" } },
        "npm",
        "2.0.0-beta.51",
      );
      expect(odd.exitCode, odd.log).toBe(1);
      expect(odd.log).toContain("cannot be ordered");
      const broken = yield* guard({ broken: true }, "npm", "2.0.0-beta.51");
      expect(broken.exitCode, broken.log).toBe(1);
      expect(broken.log).toContain("after about two minutes of asking");
      expect(broken.log).toContain("answered 500");
    }),
  );

  it.effect("a step's own check outlasts a short outage that quick reads would not", () =>
    Effect.gen(function* () {
      // Four failed reads: the quick schedule's four reads all fail; the patient one's fifth answers.
      const result = yield* guard(
        { npmTags: { latest: "1.6.11", beta: "2.0.0-beta.51" }, flakyTags: 4 },
        "npm",
        "2.0.0-beta.52",
      );
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(
        "npm's executor@beta names 2.0.0-beta.51; 2.0.0-beta.52 may move it",
      );
    }),
  );

  it.effect(
    "npm's dist-tags without a latest tag are unreadable, not a channel naming nothing",
    () =>
      Effect.gen(function* () {
        const result = yield* guard({ npmTags: { beta: "2.0.0-beta.50" } }, "npm", "2.0.0-beta.51");
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain("answered without a latest tag");
      }),
  );
});

/** Preflight against `state`, as the publish job's first step runs it, with the tap. */
const preflight = (state: State, version: string) =>
  Effect.gen(function* () {
    const stub = yield* surfaces(state);
    return yield* run(stub.url, "channel-guard.ts", ["preflight"], {
      VERSION: version,
      CHANNEL: "beta",
      TAP: tap,
    });
  }).pipe(Effect.scoped);

/** Every channel a step after beta.51 finds, before beta.52 publishes. */
const afterBeta51: State = {
  npmTags: { latest: "1.6.11", beta: "2.0.0-beta.51" },
  images: { beta: "2.0.0-beta.51" },
  formulas: { "executor-beta": "2.0.0-beta.50" },
  feed: betaFeed("2.0.0-beta.50"),
};

layer(NodeServices.layer)("a stale publish stops before anything moves", (it) => {
  it.effect("a release newer than every channel passes the first step", () =>
    Effect.gen(function* () {
      const result = yield* preflight(afterBeta51, "2.0.0-beta.52");
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain(
        "npm's executor@beta names 2.0.0-beta.51; 2.0.0-beta.52 may move it",
      );
      expect(result.log).toContain(`${image}:beta names 2.0.0-beta.51`);
      expect(result.log).toContain(`${tap}'s executor-beta formula names 2.0.0-beta.50`);
      expect(result.log).toContain("executor-v2-beta-mac.yml names 2.0.0-beta.50");
    }),
  );

  it.effect(
    "an old release re-run after a newer one stops at the first step, naming the channel",
    () =>
      Effect.gen(function* () {
        const result = yield* preflight(afterBeta51, "2.0.0-beta.50");
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain(
          `npm's executor@beta names 2.0.0-beta.51; ${image}:beta names 2.0.0-beta.51: newer than 2.0.0-beta.50. Nothing was changed`,
        );
      }),
  );

  it.effect("a newer formula alone stops the first step too", () =>
    Effect.gen(function* () {
      const result = yield* preflight(
        { ...afterBeta51, formulas: { "executor-beta": "2.0.0-beta.52" } },
        "2.0.0-beta.51",
      );
      expect(result.exitCode, result.log).toBe(1);
      expect(result.log).toContain(`${tap}'s executor-beta formula names 2.0.0-beta.52`);
    }),
  );

  it.effect(
    "a newer release half published, its image moved and npm not, stops the first step",
    () =>
      Effect.gen(function* () {
        const result = yield* preflight(
          { ...afterBeta51, images: { beta: "2.0.0-beta.52" } },
          "2.0.0-beta.51",
        );
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain(`${image}:beta names 2.0.0-beta.52: newer than 2.0.0-beta.51`);
      }),
  );

  it.effect("an image, formula or feed it cannot read or order is a warning, and it goes on", () =>
    Effect.gen(function* () {
      const result = yield* preflight(
        {
          ...afterBeta51,
          failing: ["ghcr", "feed"],
          formulas: { "executor-beta": "not-a-version" },
        },
        "2.0.0-beta.52",
      );
      expect(result.exitCode, result.log).toBe(0);
      expect(result.log).toContain("::warning title=Channel guard::Cannot read the image");
      expect(result.log).toContain("::warning title=Channel guard::Cannot read the desktop feed");
      expect(result.log).toContain(
        `::warning title=Channel guard::${tap}'s executor-beta formula names not-a-version, which cannot be ordered`,
      );
      expect(result.log).toContain(
        "npm's executor@beta names 2.0.0-beta.51; 2.0.0-beta.52 may move it",
      );
    }),
  );

  it.effect("npm it cannot read stops the first step", () =>
    Effect.gen(function* () {
      const result = yield* preflight({ ...afterBeta51, failing: ["npm"] }, "2.0.0-beta.52");
      expect(result.exitCode, result.log).toBe(1);
      // The first read, whether npm holds this version, already cannot be answered.
      expect(result.log).toContain("Cannot read whether npm holds executor@2.0.0-beta.52");
      expect(result.log).toContain("Nothing was changed");
    }),
  );

  it.effect(
    "a stable release passes the first step over Executor 1, and stops behind a newer one",
    () =>
      Effect.gen(function* () {
        const stub = yield* surfaces({
          npmTags: { latest: "1.6.11", beta: "2.0.0-beta.52" },
          images: { latest: "1.6.11", beta: "2.0.0-beta.52" },
        });
        const stable = { VERSION: "2.0.0", CHANNEL: "latest", TAP: tap };
        const passes = yield* run(stub.url, "channel-guard.ts", ["preflight"], stable);
        expect(passes.exitCode, passes.log).toBe(0);
        expect(passes.log).toContain("npm's executor@latest names 1.6.11; 2.0.0 may move it");
        expect(passes.log).toContain(`${tap}'s executor formula names nothing yet`);
        const newer = yield* surfaces({
          npmTags: { latest: "1.6.11" },
          feed: { "executor-v2-latest-mac.yml": "2.0.1" },
        });
        const stops = yield* run(newer.url, "channel-guard.ts", ["preflight"], stable);
        expect(stops.exitCode, stops.log).toBe(1);
        expect(stops.log).toContain("executor-v2-latest-mac.yml names 2.0.1: newer than 2.0.0");
      }).pipe(Effect.scoped),
  );
});

/** A launcher archive on disk, and its integrity as npm records it. */
const launcherFile = (contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-launcher-" });
    const file = path.join(directory, "executor.tgz");
    yield* fs.writeFileString(file, contents);
    return { file, integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}` };
  });

/** What npm holds as 2.0.0 today: an archive published in error and deprecated. */
const strayStable = {
  integrity: "sha512-stray",
  deprecated: "Published in error from a stale historical tag",
  time: "2026-03-16T04:49:22.003Z",
};

layer(NodeServices.layer)(
  "a version npm already holds is published only as its own resume",
  (it) => {
    it.effect(
      "a version npm holds with no published release is refused first, and nothing else is read",
      () =>
        Effect.gen(function* () {
          const stub = yield* surfaces({
            npmTags: { latest: "1.6.11" },
            npmArchives: { "2.0.0": strayStable },
            images: { latest: "1.6.11" },
          });
          const result = yield* run(stub.url, "channel-guard.ts", ["preflight"], {
            VERSION: "2.0.0",
            CHANNEL: "latest",
            TAP: tap,
          });
          expect(result.exitCode, result.log).toBe(1);
          expect(result.log).toContain(
            'npm already serves executor@2.0.0 (published 2026-03-16T04:49:22.003Z, deprecated: "Published in error from a stale historical tag"), and this is not a resumed publication of it',
          );
          expect(result.log).toContain(
            "this release needs another version number. Nothing was changed.",
          );
          // Refused on npm's and GitHub's answers alone: no image, formula or feed was asked for.
          expect(
            stub.paths().filter((route) => !["npm", "api"].includes(surfaceOf(route))),
            result.log,
          ).toEqual([]);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "a draft release does not make it a resume: npm gets the launcher only after the release is public",
      () =>
        Effect.gen(function* () {
          const result = yield* preflight(
            {
              ...afterBeta51,
              npmArchives: { "2.0.0-beta.52": { integrity: "sha512-elsewhere" } },
              release: { draft: true, assets: 3 },
            },
            "2.0.0-beta.52",
          );
          expect(result.exitCode, result.log).toBe(1);
          expect(result.log).toContain("has no published release executor@2.0.0-beta.52");
        }),
    );

    it.effect(
      "a version npm holds with its published release is a resume, and the preflight goes on",
      () =>
        Effect.gen(function* () {
          const result = yield* preflight(
            {
              ...afterBeta51,
              npmArchives: { "2.0.0-beta.51": { integrity: "sha512-this-build" } },
              release: { draft: false, assets: 21 },
            },
            "2.0.0-beta.51",
          );
          expect(result.exitCode, result.log).toBe(0);
          expect(result.log).toContain("a resumed publication");
        }),
    );

    it.effect(
      "the launcher check passes npm holding nothing on one read, or this very launcher",
      () =>
        Effect.gen(function* () {
          const launcher = yield* launcherFile("this build's launcher");
          const absent = yield* surfaces({});
          const first = yield* run(absent.url, "channel-guard.ts", ["launcher", launcher.file], {
            VERSION: "2.0.0-beta.52",
            CHANNEL: "beta",
          });
          expect(first.exitCode, first.log).toBe(0);
          expect(first.log).toContain("npm does not hold executor@2.0.0-beta.52 yet");
          expect(absent.paths()).toEqual(["/executor/2.0.0-beta.52"]);
          const resumed = yield* surfaces({
            npmArchives: { "2.0.0-beta.51": { integrity: launcher.integrity } },
          });
          const again = yield* run(resumed.url, "channel-guard.ts", ["launcher", launcher.file], {
            VERSION: "2.0.0-beta.51",
            CHANNEL: "beta",
          });
          expect(again.exitCode, again.log).toBe(0);
          expect(again.log).toContain("byte for byte: a resumed publication");
        }).pipe(Effect.scoped),
    );

    it.effect("the launcher check refuses npm holding the version with another archive", () =>
      Effect.gen(function* () {
        const launcher = yield* launcherFile("this build's launcher");
        const stub = yield* surfaces({ npmArchives: { "2.0.0": strayStable } });
        const result = yield* run(stub.url, "channel-guard.ts", ["launcher", launcher.file], {
          VERSION: "2.0.0",
          CHANNEL: "latest",
        });
        expect(result.exitCode, result.log).toBe(1);
        expect(result.log).toContain(
          `npm serves a different archive as executor@2.0.0 (sha512-stray, deprecated: "Published in error from a stale historical tag"), not the launcher this run built (${launcher.integrity})`,
        );
        expect(result.log).toContain(
          `${repository} has no published release executor@2.0.0 from this run's export commit`,
        );
        expect(result.log).toContain("this release needs another version number");
        expect(result.log).toContain("Nothing public was changed");
      }).pipe(Effect.scoped),
    );

    it.effect(
      "the launcher check says re-run the original run's failed jobs when this source published the release",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const launcher = yield* launcherFile("this attempt's rebuilt launcher");
          const exported = path.join(path.dirname(launcher.file), "public-commit");
          yield* fs.writeFileString(exported, "exportcommit51\n");
          const stub = yield* surfaces({
            npmArchives: { "2.0.0-beta.51": { integrity: "sha512-first-attempt" } },
            release: { draft: false, assets: 21, target: "exportcommit51" },
          });
          const result = yield* run(stub.url, "channel-guard.ts", ["launcher", launcher.file], {
            VERSION: "2.0.0-beta.51",
            CHANNEL: "beta",
            PUBLIC_EXPORT_COMMIT_FILE: exported,
          });
          expect(result.exitCode, result.log).toBe(1);
          expect(result.log).toContain(
            "The release executor@2.0.0-beta.51 is published and targets this run's export commit (exportcommit51), so the likely cause is a re-run of the whole workflow",
          );
          expect(result.log).toContain("re-run the failed jobs of the original run instead");
          expect(result.log).not.toContain("needs another version number");
        }).pipe(Effect.scoped),
    );

    it.effect(
      "with no launcher built, npm holding the version without a published release is the stray archive",
      () =>
        Effect.gen(function* () {
          // The preflight refused a stable 2.0.0: no launcher, npm's 2.0.0 is somebody else's.
          const result = yield* report(
            { npmTags: { latest: "1.6.11" }, npmArchives: { "2.0.0": strayStable } },
            {
              VERSION: "2.0.0",
              CHANNEL: "latest",
              RELEASE_TAG: "executor@2.0.0",
              LAUNCHER: "/nonexistent/executor-2.0.0.tgz",
            },
          );
          expect(result.summary).toContain(
            "| npm executor@2.0.0 | npm serves an archive this publication did not put there (no published release executor@2.0.0) | not done |",
          );
          expect(result.summary).toContain("Re-running cannot finish 2.0.0");
          expect(result.summary).toContain("This release needs another version number.");
          expect(result.summary).not.toContain("should finish");
        }),
    );

    it.effect(
      "with no launcher built, a published release keeps npm's row 'not compared', and a version npm lacks stays absent",
      () =>
        Effect.gen(function* () {
          const resumed = yield* report(beta51, { LAUNCHER: "/nonexistent/executor.tgz" });
          expect(resumed.summary).toContain(
            "| npm executor@2.0.0-beta.51 | published (not compared: this run built no launcher) | done |",
          );
          expect(resumed.summary).toContain("should finish 2.0.0-beta.51");
          const fresh = yield* report(
            { ...afterBeta51, release: { draft: true, assets: 3 } },
            {
              VERSION: "2.0.0-beta.52",
              RELEASE_TAG: "executor@2.0.0-beta.52",
              LAUNCHER: "/nonexistent/executor.tgz",
            },
          );
          expect(fresh.summary).toContain("| npm executor@2.0.0-beta.52 | absent | not done |");
          expect(fresh.summary).toContain("should finish 2.0.0-beta.52");
        }),
    );

    it.effect("the report calls a stray archive what it is, and says a re-run cannot finish", () =>
      Effect.gen(function* () {
        const launcher = yield* launcherFile("this build's launcher");
        const stray = yield* report(
          { ...beta51, npmArchives: { "2.0.0-beta.51": { integrity: "sha512-elsewhere" } } },
          { LAUNCHER: launcher.file },
        );
        expect(stray.summary).toContain(
          "| npm executor@2.0.0-beta.51 | npm serves a different archive under this version | not done |",
        );
        expect(stray.summary).toContain(
          "Re-running cannot finish 2.0.0-beta.51: npm already serves executor@2.0.0-beta.51 with an archive this publication did not build",
        );
        const same = yield* report(
          { ...beta51, npmArchives: { "2.0.0-beta.51": { integrity: launcher.integrity } } },
          { LAUNCHER: launcher.file },
        );
        expect(same.summary).toContain(
          "| npm executor@2.0.0-beta.51 | published, this run's launcher | done |",
        );
      }).pipe(Effect.scoped),
    );
  },
);

/** What beta.51 left public: everything but the formula and the desktop feed. */
const beta51: State = {
  release: { draft: false, assets: 21 },
  images: { "2.0.0-beta.51": "2.0.0-beta.51", beta: "2.0.0-beta.51" },
  npmVersions: ["2.0.0-beta.51"],
  npmTags: { latest: "1.6.11", beta: "2.0.0-beta.51" },
  formulas: { "executor-beta": "2.0.0-beta.50" },
  feed: betaFeed("2.0.0-beta.50"),
};

const report = (state: State, extra: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-report-" });
    const summary = path.join(directory, "summary.md");
    const stub = yield* surfaces(state);
    const result = yield* run(stub.url, "publication-report.ts", [], {
      VERSION: "2.0.0-beta.51",
      CHANNEL: "beta",
      TAP: tap,
      GH_TOKEN: "synthetic-token",
      GITHUB_STEP_SUMMARY: summary,
      ...extra,
    });
    const written = (yield* fs.exists(summary)) ? yield* fs.readFileString(summary) : "";
    return { ...result, summary: written };
  }).pipe(Effect.scoped);

layer(NodeServices.layer)("a failed publish job says what it published", (it) => {
  it.effect(
    "beta.51's state: published everywhere but Homebrew and the feed, and a re-run finishes it",
    () =>
      Effect.gen(function* () {
        const result = yield* report(beta51);
        expect(result.exitCode, result.log).toBe(0);
        expect(result.summary).toContain(
          "| GitHub release executor@2.0.0-beta.51 | public, 21 assets | done |",
        );
        expect(result.summary).toContain(`| ${image}:beta | 2.0.0-beta.51 | done |`);
        expect(result.summary).toContain("| npm tag beta | 2.0.0-beta.51 | done |");
        expect(result.summary).toContain("| npm tag latest (a beta leaves it) | 1.6.11 | done |");
        expect(result.summary).toContain("| Homebrew executor-beta | 2.0.0-beta.50 | not done |");
        expect(result.summary).toContain(
          "| desktop feed executor-v2-beta-mac.yml | 2.0.0-beta.50 | not done |",
        );
        expect(result.summary).toContain(
          "`gh run rerun 4242 --failed` should finish 2.0.0-beta.51",
        );
      }),
  );

  it.effect("a channel a newer release moved says a re-run would not finish it", () =>
    Effect.gen(function* () {
      const result = yield* report({
        ...beta51,
        images: { ...beta51.images, beta: "2.0.0-beta.52" },
      });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.summary).toContain("Re-running would not finish 2.0.0-beta.51");
      expect(result.summary).toContain(`${image}:beta names 2.0.0-beta.52`);
    }),
  );

  it.effect("a draft release is not done, and a release that finished says nothing is left", () =>
    Effect.gen(function* () {
      const draft = yield* report({ ...beta51, release: { draft: true, assets: 3 } });
      expect(draft.summary).toContain("| draft, 3 assets | not done |");
      const finished = yield* report({
        ...beta51,
        formulas: { "executor-beta": "2.0.0-beta.51" },
        feed: betaFeed("2.0.0-beta.51"),
      });
      expect(finished.summary).toContain("Nothing is left to finish");
    }),
  );

  it.effect(
    "a stable release lists the beta feed files it also moves, and is not done while they lag",
    () =>
      Effect.gen(function* () {
        const stable = (betaFeed2: Readonly<Record<string, string>>): State => ({
          release: { draft: false, assets: 21 },
          images: { "2.0.0": "2.0.0", latest: "2.0.0" },
          npmVersions: ["2.0.0"],
          npmTags: { latest: "2.0.0", beta: "2.0.0-beta.60" },
          formulas: { executor: "2.0.0" },
          feed: {
            "executor-v2-latest-mac.yml": "2.0.0",
            "executor-v2-latest.yml": "2.0.0",
            "executor-v2-latest-linux.yml": "2.0.0",
            "executor-v2-latest-linux-arm64.yml": "2.0.0",
            ...betaFeed2,
          },
        });
        const lagging = yield* report(stable(betaFeed("2.0.0-beta.60")), {
          VERSION: "2.0.0",
          CHANNEL: "latest",
          RELEASE_TAG: "executor@2.0.0",
        });
        expect(lagging.exitCode, lagging.log).toBe(0);
        expect(lagging.summary).toContain(
          "| desktop feed executor-v2-beta-mac.yml (beta installs follow) | 2.0.0-beta.60 | not done |",
        );
        expect(lagging.summary).not.toContain("Nothing is left to finish");
        const followed = yield* report(stable(betaFeed("2.0.0")), {
          VERSION: "2.0.0",
          CHANNEL: "latest",
          RELEASE_TAG: "executor@2.0.0",
        });
        expect(followed.summary).toContain("Nothing is left to finish");
        // A newer beta kept there is done too, and tells of no newer release.
        const kept = yield* report(stable(betaFeed("2.0.1-beta.1")), {
          VERSION: "2.0.0",
          CHANNEL: "latest",
          RELEASE_TAG: "executor@2.0.0",
        });
        expect(kept.summary).toContain("Nothing is left to finish");
      }),
  );

  it.effect(
    "surfaces that never answer are rows within their group's limit, and the table is written",
    () =>
      Effect.gen(function* () {
        const started = Date.now();
        const result = yield* report(
          { ...beta51, hanging: ["ghcr", "feed"] },
          { EXECUTOR_PUBLIC_REPORT_GROUP_SECONDS: "1" },
        );
        expect(result.exitCode, result.log).toBe(0);
        expect(result.summary).toContain(
          `| ${image}:beta | could not read: no answer within 1 s | ? |`,
        );
        expect(result.summary).toContain(
          "| desktop feed (beta) | could not read: no answer within 1 s | ? |",
        );
        expect(result.summary).toContain("| npm tag beta | 2.0.0-beta.51 | done |");
        expect(result.summary).toContain("Some surfaces could not be read");
        expect(Date.now() - started).toBeLessThan(30_000);
      }),
  );

  it.effect("surfaces it cannot read are rows that say so, and it still exits 0", () =>
    Effect.gen(function* () {
      const result = yield* report({ broken: true });
      expect(result.exitCode, result.log).toBe(0);
      expect(result.summary).toContain("could not read");
      expect(result.summary).toContain("Some surfaces could not be read");
    }),
  );

  it.effect("missing inputs are printed, never a failure", () =>
    Effect.gen(function* () {
      const result = yield* report(beta51, { IMAGE: "", RELEASE_TAG: "" });
      expect(result.exitCode, result.log).toBe(0);
    }),
  );
});

/** One step of the `publish` job: its fields at step level and its run block's lines. */
type Step = {
  readonly lines: ReadonlyArray<string>;
  readonly name: string;
  readonly fields: ReadonlyMap<string, string>;
  /** The run block's lines, as written; for `run: <command>` the one command at `indent`. */
  readonly run: ReadonlyArray<string>;
  /** The indentation of the run block's own lines: a line indented further is inside something. */
  readonly indent: number;
};

/** The `publish` job of release-artifacts.yml: its steps in order. */
const publishSteps = (workflow: string): ReadonlyArray<Step> => {
  const lines = workflow.split("\n");
  const start = lines.indexOf("  publish:");
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z0-9-]+:$/u.test(line));
  const blocks: Array<Array<string>> = [];
  for (const line of lines.slice(start + 1, end === -1 ? undefined : end)) {
    if (/^ {6}- /u.test(line)) blocks.push([line]);
    else if (blocks.length > 0 && (line.trim() === "" || /^ {8}/u.test(line)))
      blocks.at(-1)!.push(line);
  }
  return blocks.map((block) => {
    const fields = new Map<string, string>();
    let run: Array<string> = [];
    let indent = 10;
    block.forEach((line, index) => {
      const field = /^ {6}(?:- | {2})([a-z-]+):(?: (.*))?$/u.exec(line);
      if (field === null) return;
      fields.set(field[1]!, field[2]?.trim() ?? "");
      if (field[1] !== "run") return;
      if (field[2] !== undefined && field[2].trim() !== "|") {
        run = [`${" ".repeat(10)}${field[2].trim()}`];
        return;
      }
      const body: Array<string> = [];
      for (const next of block.slice(index + 1)) {
        if (next.trim() !== "" && !/^ {10}/u.test(next)) break;
        body.push(next);
      }
      run = body;
      indent = Math.min(
        ...body
          .filter((next) => next.trim() !== "")
          .map((next) => next.length - next.trimStart().length),
      );
    });
    return {
      lines: block,
      name: fields.get("name") ?? fields.get("uses") ?? "(unnamed)",
      fields,
      run,
      indent,
    };
  });
};

/**
 * The commands that move a channel, and the check the step that runs one must run first. A list
 * cannot catch a moving command nobody thought of: a new way to move a channel must be added here
 * with its check, and to the step that runs it.
 */
const movers: ReadonlyArray<{ readonly move: RegExp; readonly check: string }> = [
  { move: /\bimagetools create\b|\bcrane\b|\bskopeo\b|\boras\b/u, check: "channel-guard.ts image" },
  { move: /\bnpm publish\b|\bnpm dist-tag\b|publish-npm\.ts/u, check: "channel-guard.ts npm" },
  { move: /\bgit push\b/u, check: 'channel-guard.ts homebrew "$RUNNER_TEMP/tap"' },
  {
    move: /\bgh release upload "\$FEED"|executor-v2-desktop-updates/u,
    check: "channel-guard.ts desktop-feed",
  },
];
/** Anything that changes something public: the release, the image, npm, the tap or the feed. */
const changesPublic = (line: string) =>
  /\bgh release (create|upload|edit)\b/u.test(line) || movers.some(({ move }) => move.test(line));
/** The only condition a moving step may carry: no tap skips the formula's check and move alike. */
const allowedConditions: ReadonlyMap<string, string> = new Map([
  ['channel-guard.ts homebrew "$RUNNER_TEMP/tap"', "vars.HOMEBREW_TAP != ''"],
]);

/** A run line with its comment, if any, removed. */
const command = (line: string) => line.replace(/(^|\s)#.*$/u, "").trimEnd();

/**
 * Whether `step` runs `node scripts/releases/<check>` as a whole line of its own, at its run block's
 * own indentation (not inside an `if`, a loop or a group), with nothing after it (no `|| true`)
 * and no `set +e` before it, before line `before` of its run block.
 */
const runsCheck = (step: Step, check: string, before = step.run.length) => {
  const exact = `node scripts/releases/${check}`;
  const at = step.run.findIndex(
    (line, index) =>
      index < before &&
      line.trim() === exact &&
      line.length - line.trimStart().length === step.indent,
  );
  return at !== -1 && !step.run.slice(0, at).some((line) => /\bset \+e\b/u.test(command(line)));
};

/** Why the publish job's wiring of the guard and the report is wrong; empty when it is right. */
const wiring = (workflow: string): ReadonlyArray<string> => {
  const steps = publishSteps(workflow);
  const problems: Array<string> = [];
  const unconditional = (step: Step, allowed?: string) => {
    const condition = step.fields.get("if");
    if (condition !== undefined && condition !== allowed)
      problems.push(`the step "${step.name}" has if: ${condition}; it must always run`);
    if (step.fields.has("continue-on-error"))
      problems.push(`the step "${step.name}" has continue-on-error; its failure must stop the job`);
  };

  const preflight = steps.findIndex((step) => runsCheck(step, "channel-guard.ts preflight"));
  const firstChange = steps.findIndex((step) =>
    step.run.some((line) => changesPublic(command(line))),
  );
  if (preflight === -1)
    problems.push(
      "no step runs `node scripts/releases/channel-guard.ts preflight` as a line of its own",
    );
  else {
    if (firstChange !== -1 && preflight > firstChange)
      problems.push("the preflight runs after a step that changes something public");
    unconditional(steps[preflight]!);
  }

  // npm never accepts a version twice: once the launcher exists, and before anything exposes it
  // (the upload, the image, the release's publication), npm must not hold another archive.
  const launcherCheck =
    'channel-guard.ts launcher ".local/releases/$VERSION/wrapper/executor-$VERSION.tgz"';
  const wrapper = steps.findIndex((step) =>
    step.run.some((line) => command(line).includes("release:wrapper")),
  );
  const checksLauncher = steps.findIndex((step) => runsCheck(step, launcherCheck));
  const exposes = steps.findIndex((step) =>
    step.run.some((line) =>
      /\bgh release (upload|edit)\b|\bimagetools create\b/u.test(command(line)),
    ),
  );
  if (checksLauncher === -1)
    problems.push(
      `no step runs \`node scripts/releases/${launcherCheck}\` as a line of its own: add it after release:wrapper`,
    );
  else {
    if (wrapper === -1 || checksLauncher < wrapper)
      problems.push("the launcher check runs before release:wrapper builds the launcher");
    if (exposes !== -1 && checksLauncher > exposes)
      problems.push(
        "the launcher check runs after a step that uploads, moves the image or publishes the release",
      );
    unconditional(steps[checksLauncher]!);
  }

  for (const step of steps)
    for (const { move, check } of movers) {
      const moved = step.run.findIndex((line) => move.test(command(line)));
      if (moved === -1) continue;
      if (!runsCheck(step, check, moved))
        problems.push(
          `the step "${step.name}" runs \`${command(step.run[moved]!).trim()}\` without checking its channel first: add \`node scripts/releases/${check}\` on a line of its own before it`,
        );
      unconditional(step, allowedConditions.get(check));
    }

  const report = steps.find((step) =>
    step.run.some((line) => line.includes("publication-report.ts")),
  );
  if (report === undefined) problems.push("no step runs the report");
  else {
    if (report.fields.get("if") !== "failure()")
      problems.push("the report does not run only after a failure");
    if (report.fields.get("continue-on-error") !== "true")
      problems.push("the report can fail the job");
    const limit = report.fields.get("timeout-minutes");
    if (limit === undefined || Number(limit) > 5)
      problems.push("the report has no short time limit");
  }
  return problems;
};

layer(NodeServices.layer)(
  "the publish job runs the guard and the report where they protect",
  (it) => {
    const workflow = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(".github/workflows/release-artifacts.yml");
    });

    it.effect("the workflow checks every channel before moving it and bounds the report", () =>
      Effect.gen(function* () {
        expect(wiring(yield* workflow)).toEqual([]);
      }),
    );

    it.effect(
      "each change that would leave a channel or the job's result unguarded is caught",
      () =>
        Effect.gen(function* () {
          const text = yield* workflow;
          const once = (pattern: RegExp, replacement: string) => {
            const changed = text.replace(pattern, replacement);
            expect(changed, String(pattern)).not.toBe(text);
            return changed;
          };
          const preflightLine =
            /^( {8}run: node scripts\/releases\/channel-guard\.ts preflight)$/mu;
          const preflightName = /^( {6}- name: Refuse to publish over a newer release)$/mu;
          const afterPreflight = (step: string) => once(preflightLine, `$1\n${step}`);
          const cases: ReadonlyArray<readonly [string, string, string]> = [
            // Deleting a check, a step or a field.
            [
              "the image's own check deleted",
              once(/^ +node scripts\/releases\/channel-guard\.ts image\n/mu, ""),
              "imagetools create",
            ],
            [
              "every step's own check deleted",
              text.replace(
                /^ +node scripts\/releases\/channel-guard\.ts (image|npm|homebrew [^\n]*|desktop-feed)\n/gmu,
                "",
              ),
              "without checking its channel first",
            ],
            [
              "the preflight step deleted",
              once(
                /^ {6}# Before anything moves:[\s\S]*?run: node scripts\/releases\/channel-guard\.ts preflight\n/mu,
                "",
              ),
              "no step runs `node scripts/releases/channel-guard.ts preflight`",
            ],
            [
              "the report's continue-on-error deleted",
              once(
                /(name: Report what was and was not published\n(?: {8}.*\n)*?) {8}continue-on-error: true\n/u,
                "$1",
              ),
              "the report can fail the job",
            ],
            [
              "the report's time limit deleted",
              once(
                /(name: Report what was and was not published\n(?: {8}.*\n)*?) {8}timeout-minutes: \d+\n/u,
                "$1",
              ),
              "the report has no short time limit",
            ],
            // Disarming a check while its line stays.
            [
              "the npm check commented out",
              once(/^( +)(node scripts\/releases\/channel-guard\.ts npm)$/mu, "$1# $2"),
              "add `node scripts/releases/channel-guard.ts npm`",
            ],
            [
              "the feed check made to pass with || true",
              once(/^( +node scripts\/releases\/channel-guard\.ts desktop-feed)$/mu, "$1 || true"),
              "add `node scripts/releases/channel-guard.ts desktop-feed`",
            ],
            [
              "the Homebrew check inside if false",
              once(
                /^( +)(node scripts\/releases\/channel-guard\.ts homebrew "\$RUNNER_TEMP\/tap")$/mu,
                "$1if false; then\n$1  $2\n$1fi",
              ),
              'add `node scripts/releases/channel-guard.ts homebrew "$RUNNER_TEMP/tap"`',
            ],
            [
              "the preflight made to pass with || true",
              once(preflightLine, "$1 || true"),
              "no step runs `node scripts/releases/channel-guard.ts preflight`",
            ],
            [
              "the preflight replaced by an echo",
              once(preflightLine, "        run: echo channel-guard.ts preflight"),
              "no step runs `node scripts/releases/channel-guard.ts preflight`",
            ],
            [
              "the preflight given if: false",
              once(preflightName, "$1\n        if: false"),
              'the step "Refuse to publish over a newer release" has if: false',
            ],
            [
              "the preflight given continue-on-error",
              once(preflightName, "$1\n        continue-on-error: true"),
              'the step "Refuse to publish over a newer release" has continue-on-error',
            ],
            // The launcher check deleted, moved after the upload, or allowed to fail.
            [
              "the launcher check deleted",
              once(
                /^ {6}# npm never accepts a version twice[\s\S]*?channel-guard\.ts launcher [^\n]*\n/mu,
                "",
              ),
              "no step runs `node scripts/releases/channel-guard.ts launcher",
            ],
            [
              "the launcher check moved after the upload",
              (() => {
                const step =
                  /^ {6}- name: Refuse a version npm holds with another archive\n(?: {8}.*\n)+/mu;
                const moved = text.match(step)?.[0];
                expect(moved).toBeDefined();
                return text
                  .replace(step, "")
                  .replace(
                    /^( {6}- name: Publish the tested Docker manifest and channel)$/mu,
                    `${moved}$1`,
                  );
              })(),
              "the launcher check runs after a step that uploads",
            ],
            [
              "the launcher check given continue-on-error",
              once(
                /^( {6}- name: Refuse a version npm holds with another archive)$/mu,
                "$1\n        continue-on-error: true",
              ),
              'the step "Refuse a version npm holds with another archive" has continue-on-error',
            ],
            // A new step that moves a channel without its check.
            [
              "a new step moving npm's tag with npm dist-tag",
              afterPreflight(
                '      - name: Tag it\n        run: npm dist-tag add "executor@$VERSION" beta',
              ),
              'the step "Tag it" runs `npm dist-tag add "executor@$VERSION" beta` without checking its channel first',
            ],
            [
              "a new step moving the image's channel with a second imagetools create",
              afterPreflight(
                '      - name: Retag\n        run: docker buildx imagetools create --tag "$IMAGE:$CHANNEL" "$IMAGE:$VERSION"',
              ),
              'the step "Retag" runs',
            ],
            [
              "a new step moving the image's channel with crane",
              afterPreflight(
                '      - name: Crane\n        run: crane tag "$IMAGE:$VERSION" "$CHANNEL"',
              ),
              'the step "Crane" runs `crane tag',
            ],
          ];
          for (const [change, changed, problem] of cases)
            expect(wiring(changed).join("\n"), change).toContain(problem);
        }),
    );
  },
);
