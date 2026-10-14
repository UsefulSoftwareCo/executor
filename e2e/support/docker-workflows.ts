/** Released-image workflow engine fixtures shared by the docker-release workflow specs. */
import { Effect, Schema, Schedule } from "effect";
import { appsManifest } from "./apps-release.ts";
import { releasedServer } from "./docker-release-server.ts";

// Each workflow run is its own durable engine in the image's workerd process. An engine that
// stays loaded after its run finishes keeps its database and state resident, so memory grows
// with every run a server has ever executed. Engines therefore unload once idle, and a run that
// is sleeping or waiting to retry resumes from its durable alarm in a newly loaded engine.

/** A fresh released image with an owner and one deployed app; removed when the scope closes. */
export const workflowServer = (source: string) =>
  Effect.gen(function* () {
    const server = yield* releasedServer;
    const app = yield* server.deploy("Workflow engines", [
      { path: "index.ts", content: source },
      appsManifest,
    ]);
    const runs = `${server.prefix}/apps/${app.id}/workflow-runs`;
    // A loaded engine maps its database's shared-memory index into the workerd process; the
    // namespace's own metadata database stays mapped. workerd unloads an idle object after it
    // has been inactive and its callers have gone, within about two and a half minutes.
    const loadedEngines = server
      .exec(
        'for process in /proc/[0-9]*; do read name < "$process/comm"; [ "$name" = workerd ] && cat "$process/maps"; done',
      )
      .pipe(
        Effect.map(
          (maps) =>
            new Set(
              maps
                .split("\n")
                .map((line) => line.split(/\s+/).at(-1) ?? "")
                .filter(
                  (file) =>
                    file.includes("/executor-app-workflows/") &&
                    file.endsWith(".sqlite-shm") &&
                    !file.endsWith("/metadata.sqlite-shm"),
                ),
            ).size,
        ),
      );
    return {
      json: server.json,
      runs,
      loadedEngines,
      restart: server.restart,
      restartAfter: server.restartAfter,
    };
  });

export const WorkflowRun = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
});

export type WorkflowServer = Effect.Success<ReturnType<typeof workflowServer>>;

/** Polls a run until it reaches a final status. */
export const finishedRun = (server: WorkflowServer, run: string) =>
  server.json(WorkflowRun, `${server.runs}/${run}`).pipe(
    Effect.flatMap((current) =>
      ["complete", "errored", "terminated"].includes(current.status)
        ? Effect.succeed(current)
        : Effect.fail(current),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 150 }),
  );

/** Polls until no engine is loaded, and returns how many remain if some never unload. */
export const unloadedEngines = (server: WorkflowServer) =>
  server.loadedEngines.pipe(
    Effect.flatMap((loaded) => (loaded === 0 ? Effect.succeed(loaded) : Effect.fail(loaded))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
    Effect.catch((error) =>
      typeof error === "number" ? Effect.succeed(error) : Effect.fail(error),
    ),
  );

export const Timed = Schema.Struct({ before: Schema.Number, after: Schema.Number });
