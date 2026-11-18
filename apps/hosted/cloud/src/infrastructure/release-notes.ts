/**
 * Cloud's "what's new" for a deploy. Writing the notes is a step of its own, which reads main's
 * history (`scripts/releases/release-notes.ts --cloud <file>`); the deploy names that file in
 * `EXECUTOR_CLOUD_RELEASE_NOTES_FILE`, and the dashboard's build takes its notes as
 * `EXECUTOR_CLOUD_RELEASE_NOTES` (apps/hosted/cloud/web/release-notes.ts).
 *
 * Production, which every Cloud user sees, must have them: a production deploy without the file,
 * or with one that holds no such notes, stops here before anything builds. Any other stage,
 * development and a checkout's own builds take the notes when a file is named, and otherwise build
 * with none, which shows no "What's new".
 */
import { Config, Effect, FileSystem, Option, Schema } from "effect";
import { CloudReleaseNotes } from "@executor-js/utils/release-notes";
import { DeploySettingRejected } from "./deploy-settings.ts";
import { productionStage, stageName } from "./stage.ts";

const notesFile = "EXECUTOR_CLOUD_RELEASE_NOTES_FILE";

/** The notes JSON the dashboard's build takes, or none for a build given no notes file. */
export const cloudReleaseNotesInput = Effect.gen(function* () {
  const file = yield* Config.String(notesFile).pipe(Config.option);
  if (Option.isNone(file)) {
    if (Option.getOrUndefined(yield* stageName) !== productionStage) return Option.none<string>();
    return yield* new DeploySettingRejected({
      message:
        `${notesFile} is unset; a production deploy builds Cloud's "What's new" from the notes ` +
        "file the deploy workflow writes first (scripts/releases/release-notes.ts --cloud). " +
        "Write it and name it, then deploy again. Nothing was deployed.",
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file.value).pipe(
    Effect.mapError(
      () =>
        new DeploySettingRejected({
          message: `${notesFile} names ${file.value}, which cannot be read. Nothing was deployed.`,
        }),
    ),
  );
  const notes = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CloudReleaseNotes))(
    text,
  ).pipe(
    Effect.mapError(
      () =>
        new DeploySettingRejected({
          message: `${file.value} (${notesFile}) does not hold Cloud's notes as scripts/releases/release-notes.ts --cloud writes them. Nothing was deployed.`,
        }),
    ),
  );
  return Option.some(JSON.stringify(notes));
});
