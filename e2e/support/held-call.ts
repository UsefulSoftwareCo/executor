/**
 * App tools that hold a program until the scenario releases it, so a scenario can change saved
 * state between two of the program's calls without guessing how long the first takes.
 */
import { Effect, Schedule } from "effect";

/**
 * Router entries for an app that imports `query`, `mutation`, `object` and `boolean`. A program
 * calls `enter` and then `hold`, which waits until `release` is called and returns `"released"`;
 * after 30 seconds without a release it fails. `entered` reads whether `enter` was called. They
 * share the app cache, not a database, whose writes would wait for a running call.
 */
export const holdTools = `enter: mutation({ description: "Record that the program reached its hold", input: object({}) }, async (ctx) => {
    await ctx.cache.write([{ key: "entered", value: true }], "10 minutes");
    return "entered";
  }),
  hold: query({ description: "Wait until released", input: object({}) }, async (ctx) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await ctx.cache.read("released", boolean())) === true) return "released";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The held call was not released");
  }),
  entered: query({ description: "Whether the program reached its hold", input: object({}) }, async (ctx) =>
    (await ctx.cache.read("entered", boolean())) === true),
  release: mutation({ description: "Release the held call", input: object({}) }, async (ctx) => {
    await ctx.cache.write([{ key: "released", value: true }], "10 minutes");
    return "released";
  }),`;

/** Read `entered` until the program called `enter`; fails after 30 seconds. */
export const untilHeld = <E, R>(entered: Effect.Effect<boolean, E, R>) =>
  entered.pipe(
    Effect.flatMap((held) =>
      held ? Effect.void : Effect.fail(new Error("The program has not reached its hold")),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
  );
