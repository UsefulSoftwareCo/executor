const makeExitLine = () => {
  let began: number | undefined;
  return {
    closeStarted: () => {
      began ??= performance.now();
    },
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

export const { closeStarted, exitLine } = makeExitLine();
