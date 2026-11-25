export interface RetrySignature {
  readonly name: "hyperdrive-origin";
  readonly description: string;
  readonly matches: (message: string) => boolean;
  readonly cause: string;
}

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

export const isDeployOutcomeLine = (line: string) => {
  const plain = line.replaceAll(colour, "");
  return failed.test(plain) || summary.test(plain);
};

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
