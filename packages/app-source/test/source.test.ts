import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, FileSystem, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AppCodeId, SourceError, SourceFiles } from "@executor-js/sdk/core";
import { gitSourceStorage } from "../src/index.ts";
import { nativeRepositories } from "../src/node.ts";

test("retained Git revisions survive author edits and reject deletion through Git HTTP", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-source-" });
        const repos = nativeRepositories(directory);
        const store = gitSourceStorage(repos);
        const code = AppCodeId.make("code_source_test");
        const before = SourceFiles.make([
          { path: "index.ts", content: "export default 'before';" },
        ]);
        // A failed first attempt can leave the directory before Git initialization.
        yield* fs.makeDirectory(`${directory}/${code}.git`);
        const after = SourceFiles.make([{ path: "index.ts", content: "export default 'after';" }]);
        const first = yield* store.retain(code, before);
        const again = yield* store.retain(code, before);
        assert.deepEqual(again, first);
        // A retained snapshot must not become the editable workspace when main is still absent.
        assert.equal(yield* store.workspace(code), null);
        const absent = yield* repos.read(code, "main").pipe(Effect.flip);
        assert.equal(absent.reason, "not-found");
        const main = yield* repos.commit({
          id: code,
          branch: "main",
          expected: null,
          files: before,
          message: "Initial source",
        });
        yield* repos.commit({
          id: code,
          branch: "main",
          expected: main,
          files: after,
          message: "Update source",
        });
        assert.deepEqual(yield* store.read(first), before);
        assert.deepEqual((yield* repos.read(code, "main")).files, after);
        const line = `${first.commit} ${"0".repeat(40)} refs/heads/__executor/sources/retained\0report-status\n`;
        const body = `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, "0")}${line}0000`;
        const rejected = yield* repos
          .request(
            code,
            new Request("http://localhost/repo/git-receive-pack", { method: "POST", body }),
          )
          .pipe(Effect.flip);
        assert.ok(Schema.is(SourceError)(rejected));
        assert.equal(rejected.reason, "protected");
        const deletion = `${yield* repos.head(code, "main")} ${"0".repeat(40)} refs/heads/main\0report-status\n`;
        const deletionBody = `${(Buffer.byteLength(deletion) + 4).toString(16).padStart(4, "0")}${deletion}0000`;
        const deniedMain = yield* repos
          .request(
            code,
            new Request("http://localhost/repo/git-receive-pack", {
              method: "POST",
              body: deletionBody,
            }),
          )
          .pipe(Effect.flip);
        assert.equal(deniedMain.reason, "protected");
        assert.deepEqual((yield* repos.read(code, "main")).files, after);
        assert.deepEqual(yield* store.read(first), before);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  ));
