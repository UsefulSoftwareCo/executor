import { Config, Effect, FileSystem, Option, Schema } from "effect";
import { CloudReleaseNotes } from "@executor-js/utils/release-notes";
import { DeploySettingRejected } from "./deploy-settings.ts";
import { productionStage, stageName } from "./stage.ts";

const notesFile = "EXECUTOR_CLOUD_RELEASE_NOTES_FILE";

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
