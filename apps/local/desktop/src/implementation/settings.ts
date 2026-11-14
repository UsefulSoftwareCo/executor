/**
 * The background server's port, kept in the data directory's `service.json` like `executor service
 * set port`. The form is a script-free document; its submission is a navigation.
 */
import { createServer } from "node:net";
import { BrowserWindow, session } from "electron";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { readSettings, writeSettings } from "../../../server/src/implementation/service-files.ts";
import { DesktopPort, LegacyDesktopSettings, SettingsFailed } from "../contracts/desktop.ts";

/** Where the server's port comes from. An explicit EXECUTOR_PORT always wins over the setting. */
export type PortSource =
  | { readonly kind: "environment"; readonly port: string }
  | { readonly kind: "setting"; readonly port: number }
  | { readonly kind: "default" }
  | { readonly kind: "invalid"; readonly message: string };

/** The port source now. `environment` is EXECUTOR_PORT as this desktop started. */
export const portSource = (directory: string, environment: Option.Option<string>) =>
  Option.isSome(environment)
    ? Effect.succeed<PortSource>({ kind: "environment", port: environment.value })
    : readSettings(directory).pipe(
        Effect.map((settings): PortSource =>
          settings.port === undefined
            ? { kind: "default" }
            : { kind: "setting", port: settings.port },
        ),
        Effect.catchTag("ServiceSettingInvalid", (error) =>
          Effect.succeed<PortSource>({ kind: "invalid", message: error.message }),
        ),
      );

/** Keep every other setting; only the port changes. */
const savePort = (platform: string, directory: string, port: number) =>
  readSettings(directory).pipe(
    Effect.flatMap((settings) => writeSettings(platform, directory, { ...settings, port })),
    Effect.mapError(() => new SettingsFailed()),
  );

/**
 * The port an old desktop saved in its own data directory's `desktop.json`, for the migration.
 * A missing file has none; an unreadable one is logged and carries none over.
 */
export const legacyPort = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, "desktop.json");
    if (!(yield* fs.exists(file))) return undefined;
    const settings = yield* fs
      .readFileString(file)
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyDesktopSettings))),
      );
    return settings.port;
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("The old desktop.json is unreadable; its port is not carried over").pipe(
        Effect.as(undefined),
      ),
    ),
  );

/** Probe the loopback address the server binds. A later bind can still race another process. */
const portAvailable = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const server = createServer();
    server.once("error", () => resume(Effect.succeed(false)));
    server.listen(port, "127.0.0.1", () => server.close(() => resume(Effect.succeed(true))));
  });

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );

const action = "executor-settings:";

const portPage = (options: {
  readonly current: number | undefined;
  readonly source: PortSource;
  readonly value: string;
  readonly error: string | undefined;
}) => {
  const locked = options.source.kind === "environment" || options.source.kind === "invalid";
  const note =
    options.source.kind === "environment"
      ? `EXECUTOR_PORT sets the port for this launch. Unset it to choose a port here.`
      : options.source.kind === "invalid"
        ? options.source.message
        : options.current === undefined
          ? `The background server is not running. It restarts to apply a new port.`
          : `MCP clients and scripts use http://127.0.0.1:${options.current}. Update them after a change. The background server restarts to apply it, and the Executor CLI uses it too.`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action ${action}">
<title>Server port</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; font-size: 13px; }
  body { margin: 0; padding: 20px 24px; background: Canvas; color: CanvasText; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 14px; }
  label { display: block; font-weight: 500; margin-bottom: 6px; }
  input { font: inherit; width: 120px; padding: 5px 8px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: Field; color: FieldText; }
  p { margin: 10px 0 0; line-height: 1.45; opacity: 0.7; }
  p.error { opacity: 1; color: #d93b3b; }
  .actions { display: flex; flex-direction: row-reverse; justify-content: flex-start; gap: 8px; margin-top: 20px; }
  button { font: inherit; padding: 5px 14px; border-radius: 6px; }
</style>
<form action="${action}port" method="get">
  <h1>Local server port</h1>
  <label for="port">Port</label>
  <input id="port" name="port" type="number" min="1024" max="65535" required${locked ? " disabled" : " autofocus"} value="${escape(options.value)}">
  ${options.error === undefined ? "" : `<p class="error" role="alert">${escape(options.error)}</p>`}
  <p>${escape(note)}</p>
  <div class="actions">
    ${locked ? "" : `<button type="submit">Save and restart</button>`}
    <button type="submit" formaction="${action}cancel" formnovalidate>${locked ? "Close" : "Cancel"}</button>
  </div>
</form>
</html>`)}`;
};

/**
 * Make the "Server port…" action. `current` is the port the running server bound, if one is
 * running. Saving writes `service.json` and restarts the background server, because the listener
 * cannot move in place.
 */
export const makePortAction = (options: {
  readonly directory: string;
  readonly platform: string;
  /** EXECUTOR_PORT as this desktop started; it locks the form. */
  readonly environment: Option.Option<string>;
  readonly current: () => number | undefined;
  readonly parent: () => BrowserWindow | undefined;
  /** Stop the background server and start it again, so it listens on the saved port. */
  readonly restart: () => void;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      Effect.runPromise(Effect.provide(effect, services));
    let open: BrowserWindow | undefined;
    const show = Effect.gen(function* () {
      if (open !== undefined && !open.isDestroyed()) return open.focus();
      // Read once per opened form, so a restart while it is open cannot change the page.
      const source = yield* portSource(options.directory, options.environment);
      const running = options.current();
      const parent = options.parent();
      const current = new BrowserWindow({
        width: 420,
        height: 300,
        useContentSize: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        title: "Server port",
        show: false,
        ...(parent === undefined || parent.isDestroyed() ? {} : { parent, modal: true }),
        webPreferences: {
          session: session.fromPartition("executor-desktop-settings"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      open = current;
      current.once("closed", () => {
        if (open === current) open = undefined;
      });
      current.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      current.webContents.on("will-attach-webview", (event) => event.preventDefault());
      current.once("ready-to-show", () => current.show());
      const load = (value: string, error: string | undefined) => {
        void current
          .loadURL(portPage({ current: running, source, value, error }))
          .catch(() => current.destroy());
      };
      const submit = (value: string) =>
        Effect.gen(function* () {
          const port = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopPort))(value);
          if (Option.isNone(port)) return load(value, "Choose a whole number from 1024 to 65535.");
          if (port.value === running) return current.destroy();
          if (!(yield* portAvailable(port.value)))
            return load(
              value,
              `Port ${port.value} is in use by another program. Choose another port.`,
            );
          const saved = yield* savePort(options.platform, options.directory, port.value).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!saved)
            return load(
              value,
              "Executor could not save this setting. Check the data directory permissions.",
            );
          current.destroy();
          options.restart();
        });
      current.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        if (source.kind === "environment" || source.kind === "invalid" || !url.startsWith(action)) {
          current.destroy();
          return;
        }
        const target = new URL(url);
        if (target.pathname === "port") void run(submit(target.searchParams.get("port") ?? ""));
        else current.destroy();
      });
      load(String(running ?? (source.kind === "setting" ? source.port : "")), undefined);
    });
    return show;
  });
