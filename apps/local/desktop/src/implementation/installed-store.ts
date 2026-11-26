import {
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Ref,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { writeAtomically } from "../../../server/src/implementation/atomic-file.ts";
import {
  DesktopUnavailable,
  type InstalledApp,
  InstalledAppsFile,
  installedAppsFileName,
  InstalledAppsUnreadable,
} from "../contracts/installed-apps.ts";

const FileJson = Schema.fromJsonString(InstalledAppsFile);
const empty: InstalledAppsFile = { version: 1, servers: {} };

export const makeInstalledStore = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, installedAppsFileName);
    const read = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, "NotFound"),
        () => Effect.succeed(Option.none<string>()),
      ),
      Effect.result,
    );
    const loaded = Result.isFailure(read)
      ? Option.none<InstalledAppsFile>()
      : Option.isNone(read.success)
        ? Option.some(empty)
        : Schema.decodeUnknownOption(FileJson)(read.success.value);
    if (Option.isNone(loaded))
      yield* Effect.logError(
        "Installed apps are unreadable; installing and opening apps stays off until the file is fixed or removed",
        ...(Result.isFailure(read) ? [read.failure] : []),
      ).pipe(Effect.annotateLogs({ detail: file }));
    const state = yield* Ref.make(Option.getOrElse(loaded, () => empty));
    const lock = yield* Semaphore.make(1);
    const usable = Option.isSome(loaded)
      ? Effect.void
      : Effect.fail(new InstalledAppsUnreadable({ file }));
    const save = (next: InstalledAppsFile) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* writeAtomically(
          process.platform,
          directory,
          file,
          yield* Schema.encodeEffect(FileJson)(next),
        );
        yield* Ref.set(state, next);
      }).pipe(
        Effect.tapCause((cause) => Effect.logError("Could not save installed apps", cause)),
        Effect.mapError(() => new DesktopUnavailable()),
      );
    const find = (file: InstalledAppsFile, server: string, app: string) =>
      Option.fromUndefinedOr(file.servers[server]?.apps[app]);
    const get = (server: string, app: string) =>
      usable.pipe(
        Effect.andThen(Ref.get(state)),
        Effect.map((file) => find(file, server, app)),
      );
    const peek = (server: string, app: string) =>
      Option.isSome(loaded) ? find(Ref.getUnsafe(state), server, app) : Option.none<InstalledApp>();
    const update = (
      server: string,
      app: string,
      change: (current: Option.Option<InstalledApp>) => Option.Option<InstalledApp>,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* usable;
          const current = yield* Ref.get(state);
          const found = find(current, server, app);
          const next = change(found);
          const unchanged = Option.isNone(next)
            ? Option.isNone(found)
            : Option.isSome(found) && found.value === next.value;
          if (unchanged) return next;
          const apps = { ...current.servers[server]?.apps };
          if (Option.isSome(next)) apps[app] = next.value;
          else delete apps[app];
          const servers = { ...current.servers };
          if (Object.keys(apps).length === 0) delete servers[server];
          else servers[server] = { apps };
          yield* save({ version: 1, servers });
          return next;
        }),
      );
    const appsOf = (server: string) =>
      usable.pipe(
        Effect.andThen(Ref.get(state)),
        Effect.map((file) => Object.values(file.servers[server]?.apps ?? {})),
      );
    const servers = usable.pipe(
      Effect.andThen(Ref.get(state)),
      Effect.map((file) => Object.keys(file.servers)),
    );
    return { get, peek, update, appsOf, servers };
  });

export type InstalledStore = Effect.Success<ReturnType<typeof makeInstalledStore>>;
