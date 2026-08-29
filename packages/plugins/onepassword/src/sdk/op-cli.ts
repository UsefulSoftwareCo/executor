import { execFile } from "node:child_process";

// Raw `op` CLI spawn boundary. Kept as its own module so the service can be
// tested against a fake without mocking node builtins. The spawn is
// asynchronous on purpose: the previous backend (`@1password/op-js`) ran `op`
// with execFileSync, so an `op` stuck on a 1Password approval prompt blocked
// the host's entire event loop — on the single-threaded local daemon that
// froze every in-flight request until the prompt was answered.

/** Spawn outcome as plain data. The promise always resolves; the service
 *  layer owns failure typing and message shaping (redaction, truncation). */
export type OpCliResult =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      /** True when the child was killed by the spawn timeout. */
      readonly timedOut: boolean;
      readonly message: string;
    };

export interface OpCliInvocation {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Hard deadline for the child; on expiry it is killed and the result
   *  carries `timedOut: true`. */
  readonly timeoutMs: number;
  /** Fiber interruption reaches the child through this signal. */
  readonly signal: AbortSignal;
}

const isExecFileError = (
  error: unknown,
): error is NodeJS.ErrnoException & { readonly killed?: boolean } =>
  typeof error === "object" && error !== null && "message" in error;

const describeSpawnError = (error: unknown): string => {
  if (isExecFileError(error)) {
    // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: normalizing the untyped execFile callback error into plain result data
    return error.message;
  }
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: last-resort stringification of a non-Error spawn failure
  return String(error);
};

/** Run `op` once. stdout carries the successful payload; stderr carries the
 *  CLI's human-readable diagnostics, so a non-zero exit reports stderr when
 *  present (falling back to the spawn error, e.g. `spawn op ENOENT`). */
export const opCliExec = ({
  args,
  env,
  timeoutMs,
  signal,
}: OpCliInvocation): Promise<OpCliResult> =>
  new Promise((resolve) => {
    execFile(
      "op",
      args,
      {
        env: env as NodeJS.ProcessEnv,
        timeout: timeoutMs,
        signal,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout });
          return;
        }
        const stderrText = stderr.trim();
        resolve({
          ok: false,
          timedOut: isExecFileError(error) && error.killed === true,
          message: stderrText.length > 0 ? stderrText : describeSpawnError(error),
        });
      },
    );
  });
