import { appendFileSync, writeSync } from "node:fs";

const slowQuitMillis = 10_000;

const describeThrown = (value: unknown): string => {
  try {
    if (value instanceof Error && typeof value.stack === "string") return value.stack;
  } catch {}
  try {
    return String(value);
  } catch {}
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "a thrown value that cannot be described";
  }
};

export const makeQuitRecord = () => {
  let file: string | undefined;
  let closing = "nothing yet";
  let began: number | undefined;
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
    } catch {}
    if (file === undefined) return;
    try {
      appendFileSync(file, line, { mode: 0o600 });
    } catch {}
  };
  const seconds = () => (began === undefined ? 0 : (Date.now() - began) / 1_000);
  return {
    useLog: (path: string) => {
      file = path;
    },
    closing: (name: string) => {
      closing = name;
    },
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
    closed: (outcome: "success" | "failure") => {
      write("INFO", "Desktop closed", { seconds: seconds(), outcome });
    },
    exception: (thrown: unknown, origin: string) => {
      write("ERROR", "Desktop uncaught exception", {
        exceptionOrigin: origin,
        closing: began === undefined ? undefined : closing,
        error: describeThrown(thrown),
      });
    },
  };
};
