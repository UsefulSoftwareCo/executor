/**
 * The desktop's own record of quitting. A quit closes the desktop's scope before the app exits.
 * A quit that does not finish never flushes the batched log, and an uncaught exception meanwhile
 * opens Electron's error box, which blocks the main process with nothing written. So each record
 * is written at once, to stderr and to the desktop's log, in the log's JSON shape.
 */
import { appendFileSync, writeSync } from "node:fs";

/** A quit still running after this long has hung; an orderly one takes well under a second. */
const slowQuitMillis = 10_000;

/**
 * What a thrown value says, for any value: an Error's stack, else its string form. `throw null`,
 * `throw undefined`, an object with no prototype and an object whose conversion throws all
 * produce text; this never throws, since a throw in an `uncaughtExceptionMonitor` listener ends
 * the process.
 */
const describeThrown = (value: unknown): string => {
  try {
    if (value instanceof Error && typeof value.stack === "string") return value.stack;
  } catch {
    // A proxy or getter may throw; the forms below still describe the value.
  }
  try {
    return String(value);
  } catch {
    // An object with no prototype has no toString.
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "a thrown value that cannot be described";
  }
};

export const makeQuitRecord = () => {
  let file: string | undefined;
  /** The finalizers that run now, named by the last marker the scope passed. */
  let closing = "nothing yet";
  let began: number | undefined;
  /**
   * A record must never throw or emit an error: it runs while the desktop quits and inside the
   * uncaught-exception listener. stderr is written synchronously by descriptor, so a pipe whose
   * reader has gone fails this one write, which is dropped, instead of raising `EPIPE` as an
   * uncaught exception from the process stream, which this listener would record by writing to
   * stderr again. The log keeps what stderr cannot take.
   */
  const write = (level: "INFO" | "WARN" | "ERROR", message: string, annotations: object) => {
    let line: string;
    try {
      line = `${JSON.stringify({ message, level, timestamp: new Date().toISOString(), annotations })}\n`;
    } catch {
      return;
    }
    try {
      // oxlint-disable-next-line executor/no-sync-stdio-write -- Known risk, kept for now: a stderr pipe nobody reads blocks this write (always on Windows), and the desktop's quit with it. It records quits that hang, while the scope's own logger may be gone; replacing it needs its own change.
      writeSync(2, line);
    } catch {
      // No reader, or stderr is closed or full; the log has the record.
    }
    if (file === undefined) return;
    try {
      appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // The log may have moved, as a data reset moves it; stderr has the record.
    }
  };
  const seconds = () => (began === undefined ? 0 : (Date.now() - began) / 1_000);
  return {
    /** Also write to the desktop's log, once it is open. */
    useLog: (path: string) => {
      file = path;
    },
    /** The scope reached the finalizers of `name`, which run next. */
    closing: (name: string) => {
      closing = name;
    },
    /**
     * The desktop was asked to quit, or stopped. Once only. A quit still running after
     * `slowQuitMillis` says which finalizers it waits on and what keeps the event loop alive.
     */
    began: (reason: string) => {
      if (began !== undefined) return;
      began = Date.now();
      write("INFO", "Desktop quitting", { reason });
      setTimeout(() => {
        write("WARN", "Desktop still quitting", {
          seconds: seconds(),
          closing,
          resources: process.getActiveResourcesInfo(),
        });
      }, slowQuitMillis).unref();
    },
    /** The desktop's scope has closed; the app exits next. */
    closed: (outcome: "success" | "failure") => {
      write("INFO", "Desktop closed", { seconds: seconds(), outcome });
    },
    /** For `uncaughtExceptionMonitor`, which runs before Electron's error box. Any value. */
    exception: (thrown: unknown, origin: string) => {
      write("ERROR", "Desktop uncaught exception", {
        exceptionOrigin: origin,
        closing: began === undefined ? undefined : closing,
        error: describeThrown(thrown),
      });
    },
  };
};
