/**
 * A transient Cloudflare answer makes a new test stage's `alchemy deploy` fail through no fault of
 * the change under test. `test-stage deploy` retries a new stage's deploy once when its failed
 * output shows it and nothing else (notes/test-stages.md, "Retrying a new stage's
 * deploy"). Alchemy's plain log has one `[<id>] fail — <message>` line for each failed resource and
 * ends with `Failed: <n> succeeded, <m> failed` (alchemy `Cli/LoggingCli.ts`).
 */

/** Why a failed deploy is retried. */
export interface RetrySignature {
  readonly name: "hyperdrive-origin";
  /** What failed, for the one log line that says the deploy was retried. */
  readonly description: string;
  /** Whether a failed resource's message is this signature's. */
  readonly matches: (message: string) => boolean;
  /** A resource that must be among the failed ones, as the failure's cause. */
  readonly cause: string;
}

/**
 * Cloudflare checks a Hyperdrive config's origin when it is created. On a new PlanetScale branch
 * the pooled origin can still refuse that check after migrations reached the branch directly.
 * Resources that depend on the config fail with the same message.
 */
const hyperdriveOrigin: RetrySignature = {
  name: "hyperdrive-origin",
  description:
    "Hyperdrive config DatabaseConnection could not reach the new database's pooled origin",
  matches: (message) =>
    message.includes("BadRequest: Network connection to the provided database timed out."),
  cause: "DatabaseConnection",
};

export const retrySignatures: ReadonlyArray<RetrySignature> = [hyperdriveOrigin];

// oxlint-disable-next-line no-control-regex -- Alchemy colours its status lines.
const colour = /\u001b\[[0-9;]*m/gu;
const failed = /\[([^\]\s]+)\] fail(?= |$)(.*)$/u;
const summary = /\bFailed: \d+ succeeded, (\d+) failed\b/u;

/** Whether a line of the deploy's output is one the signatures are read from. */
export const isDeployOutcomeLine = (line: string) => {
  const plain = line.replaceAll(colour, "");
  return failed.test(plain) || summary.test(plain);
};

/**
 * The signature a failed deploy's output shows, if every failed resource failed with it and the
 * summary counts no other failure. Anything else, or an output without a summary, is not retried.
 */
export const retrySignature = (lines: ReadonlyArray<string>): RetrySignature | undefined => {
  const plain = lines.map((line) => line.replaceAll(colour, ""));
  const counted = plain.flatMap((line) => {
    const match = summary.exec(line);
    return match === null ? [] : [Number(match[1])];
  });
  if (counted.length !== 1) return undefined;
  const failures = new Map<string, Array<string>>();
  for (const line of plain) {
    const match = failed.exec(line);
    if (match !== null) failures.set(match[1]!, [...(failures.get(match[1]!) ?? []), match[2]!]);
  }
  if (failures.size === 0 || failures.size !== counted[0]) return undefined;
  const messages = [...failures.values()].flat();
  return retrySignatures.find(
    (signature) => messages.every(signature.matches) && failures.has(signature.cause),
  );
};
