/**
 * The environment GitHub Actions gives a gate step of checks.yml (`check` and `e2e`): its `env:`
 * block's expressions evaluated against a `needs` object, as the runner would, so a case runs the
 * gate on exactly what the workflow passes it. An expression this does not know fails the case
 * instead of being guessed at.
 */

export interface Need {
  readonly result: string;
  readonly outputs: Readonly<Record<string, string>>;
}

/** The `env:` block of the step named `step` in the job `job` of a workflow's text. */
export const stepEnvironmentBlock = (workflow: string, job: string, step: string) => {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  if (start === -1) throw new Error(`No job ${job}`);
  const end = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  const text = end === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + end);
  const at = text.indexOf(`      - name: ${step}\n`);
  if (at === -1) throw new Error(`No step ${step} in ${job}`);
  const rest = text.slice(at);
  const env = rest.indexOf("\n        env:\n");
  const run = rest.indexOf("\n        run: |\n");
  if (env === -1 || run === -1 || env > run) throw new Error(`No env block in ${job} / ${step}`);
  return rest.slice(env + "\n        env:\n".length, run);
};

/** One `${{ … }}` value, evaluated against `needs`. */
const evaluate = (expression: string, needs: Readonly<Record<string, Need>>): string => {
  if (expression === "join(needs.*.result, ' ')")
    return Object.values(needs)
      .map((need) => need.result)
      .join(" ");
  if (expression === "github.token") return "synthetic-token";
  const result = expression.match(/^needs\.([\w-]+)\.result$/);
  if (result !== null) return needs[result[1]!]?.result ?? "";
  const output = expression.match(/^needs\.([\w-]+)\.outputs\.([\w-]+)$/);
  if (output !== null) return needs[output[1]!]?.outputs[output[2]!] ?? "";
  const set = expression.match(/^needs\.([\w-]+)\.outputs\.([\w-]+) != ''$/);
  if (set !== null) return String((needs[set[1]!]?.outputs[set[2]!] ?? "") !== "");
  throw new Error(`An expression gate-environment.ts does not evaluate: ${expression}`);
};

/** The variables a gate step gets for `needs`; comments and literal values are kept as written. */
export const gateEnvironment = (
  workflow: string,
  job: string,
  step: string,
  needs: Readonly<Record<string, Need>>,
): Record<string, string> =>
  Object.fromEntries(
    stepEnvironmentBlock(workflow, job, step)
      .split("\n")
      .filter((line) => /^ {10}[A-Za-z_][\w]*: /.test(line))
      .map((line) => {
        const [, name, value] = line.match(/^ {10}([A-Za-z_]\w*): (.*)$/)!;
        const expression = value!.match(/^\$\{\{ (.*) \}\}$/);
        return [
          name!,
          expression === null ? value!.replace(/^"(.*)"$/, "$1") : evaluate(expression[1]!, needs),
        ];
      }),
  );
