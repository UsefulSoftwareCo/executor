/**
 * App tools that hold a program until the scenario releases it, so a scenario can change saved
 * state between two of the program's calls without guessing how long the first takes.
 */
import { Effect, Schedule } from "effect";

/**
 * Router entries for an app that imports `query`, `mutation`, `object` and `boolean`. A program
 * calls `hold`, which records that it is holding and waits until `release` is called, then
 * returns `"released"`; after 30 seconds without a release it fails. `holding` reads whether
 * `hold` is waiting. `hold` records it from its own body, so the call has passed every check
 * the product makes before running it: state changed after that cannot refuse `hold` itself,
 * only the program's later calls. They share the app cache, not a database, whose writes would
 * wait for a running call.
 */
export const holdTools = `hold: query({ description: "Wait until released", input: object({}) }, async (ctx) => {
    await ctx.cache.write([{ key: "holding", value: true }], "10 minutes");
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await ctx.cache.read("released", boolean())) === true) return "released";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("The held call was not released");
  }),
  holding: query({ description: "Whether the program is waiting in its hold", input: object({}) }, async (ctx) =>
    (await ctx.cache.read("holding", boolean())) === true),
  release: mutation({ description: "Release the held call", input: object({}) }, async (ctx) => {
    await ctx.cache.write([{ key: "released", value: true }], "10 minutes");
    return "released";
  }),`;

/** Read `holding` until the program's `hold` call is running; fails after 30 seconds. */
export const untilHeld = <E, R>(holding: Effect.Effect<boolean, E, R>) =>
  holding.pipe(
    Effect.flatMap((held) =>
      held ? Effect.void : Effect.fail(new Error("The program has not reached its hold")),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
  );
