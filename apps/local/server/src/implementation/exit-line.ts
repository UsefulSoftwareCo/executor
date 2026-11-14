/**
 * The local server's last line: how long its stop took, from the moment it started to close until
 * its process ends. "Local server stopped" is logged before the final telemetry flush, the step a
 * collector that is already gone can hold, and the diagnostics log has closed by then, so a
 * terminal or a supervisor reading stderr learns the whole stop's length only from this line.
 *
 * The CLI writes it through its own output as it exits (`processOutput.last`), after every other
 * line and with the same guarantees: a reader that stopped reading cannot hold the exit, which
 * waits at most half a second for output after a signal.
 */

const makeExitLine = () => {
  let began: number | undefined;
  return {
    /** The server starts to close. */
    closeStarted: () => {
      began ??= performance.now();
    },
    /** The line, once the server has started to close. */
    exitLine: () =>
      began === undefined
        ? undefined
        : JSON.stringify({
            message: "Local server exited",
            level: "INFO",
            timestamp: new Date().toISOString(),
            annotations: { "executor.shutdown_ms": Math.round(performance.now() - began) },
          }),
  };
};

/** One process runs one server. */
export const { closeStarted, exitLine } = makeExitLine();
