import { Effect } from "effect";

export const runInNode = (code: string) =>
  Effect.promise((): Promise<unknown> => {
    const program = new Function(`return (async () => {\n${code}\n})();`);
    return Promise.resolve(program()).then((value) =>
      JSON.parse(JSON.stringify(value, (_, item) => (item === undefined ? null : item))),
    );
  });
