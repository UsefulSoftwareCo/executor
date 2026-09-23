import { dialog, shell, type Session } from "electron";
import { PairingLink } from "@executor-js/local-server/auth";
import { Effect, Redacted, Schema, Semaphore } from "effect";
import { BrowserOpenFailed, externalUrl } from "../contracts/desktop.ts";

/** Pair the system browser using the desktop session, without exposing the local API key. */
export const makeOpenBrowserAction = (session: Session, origin: string) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const open = Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          session.fetch(`${origin}/auth/pair`, {
            method: "POST",
            credentials: "include",
            headers: { origin },
            redirect: "error",
            signal,
          }),
        catch: () => new BrowserOpenFailed(),
      });
      if (!response.ok) return yield* new BrowserOpenFailed();
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new BrowserOpenFailed(),
      });
      const link = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(PairingLink))(body).pipe(
        Effect.mapError(() => new BrowserOpenFailed()),
      );
      const url = externalUrl(Redacted.value(link.url));
      if (url === undefined || url.origin !== origin) return yield* new BrowserOpenFailed();
      yield* Effect.tryPromise({
        try: () => shell.openExternal(url.href),
        catch: () => new BrowserOpenFailed(),
      });
    }).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Could not open the dashboard in the system browser");
          yield* Effect.tryPromise({
            try: () =>
              dialog.showMessageBox({
                type: "error",
                message: "Could not open Executor in your browser.",
                detail:
                  "Wait for the desktop dashboard to load, then try File → Open in browser again.",
              }),
            catch: () => new BrowserOpenFailed(),
          }).pipe(Effect.ignore);
        }),
      ),
    );
    return lock.withPermitsIfAvailable(1)(open);
  });
