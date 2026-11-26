import { Effect, Schedule } from "effect";

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

export const untilHeld = <E, R>(holding: Effect.Effect<boolean, E, R>) =>
  holding.pipe(
    Effect.flatMap((held) =>
      held ? Effect.void : Effect.fail(new Error("The program has not reached its hold")),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
  );
