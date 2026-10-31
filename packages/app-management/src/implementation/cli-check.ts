import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { checkApp, type AppCheckFile } from "@executor-js/sdk/core";
import { readSource } from "./cli-source.ts";

const files = Flag.Path("files", { pathType: "either", mustExist: true }).pipe(
  Flag.withDescription("App source directory or JSON file to check without contacting a host"),
);

/** Offline metadata and source checks. readSource enforces the same limits used before uploads. */
export const checkCommand = Command.make("check", { files }).pipe(
  Command.withDescription("Check an app's package manifest and source limits without a host"),
  Command.withExamples([
    {
      command: "executor apps check --files ./hello",
      description: "Check app source before creating or deploying it",
    },
  ]),
  Command.withHandler(({ files: location }) =>
    readSource(location).pipe(
      Effect.flatMap((source) => {
        const appFiles: AppCheckFile[] = source.map((file) =>
          file.text === undefined
            ? { path: file.path, size: file.size }
            : { path: file.path, content: file.text, size: file.size },
        );
        const issues = checkApp(appFiles);
        return Console.log(
          JSON.stringify({ ok: issues.length === 0, files: source.length, issues }),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (issues.length > 0) process.exitCode = 1;
            }),
          ),
        );
      }),
      Effect.catchTag("SourceRejected", (error) =>
        Console.log(
          JSON.stringify({
            ok: false,
            issues: [{ code: error.reason, message: error.detail, paths: error.paths }],
          }),
        ).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1)))),
      ),
    ),
  ),
);
