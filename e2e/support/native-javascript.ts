/**
 * Runs an execute program's source in Node itself, for scenarios that compare execute with
 * standard JavaScript. The program may await but gets no tools.
 */
import { Effect } from "effect";

/** Node's result for a program, as the plain data execute returns: `undefined` becomes `null`. */
export const runInNode = (code: string) =>
  Effect.promise((): Promise<unknown> => {
    const program = new Function(`return (async () => {\n${code}\n})();`);
    return Promise.resolve(program()).then((value) =>
      JSON.parse(JSON.stringify(value, (_, item) => (item === undefined ? null : item))),
    );
  });
