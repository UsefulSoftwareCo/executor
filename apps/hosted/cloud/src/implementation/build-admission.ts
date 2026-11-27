import { Duration, Effect } from "effect";

interface Slot {
  readonly released: Promise<void>;
  readonly expires: number;
}

export const makeBuildAdmission = (slots: number, lease: Duration.Input) => {
  const leaseMillis = Duration.toMillis(lease);
  const held = new Set<Slot>();
  const acquire = async (): Promise<() => void> => {
    for (;;) {
      const now = Date.now();
      for (const slot of held) if (slot.expires <= now) held.delete(slot);
      if (held.size < slots) {
        let release = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const slot = { released, expires: now + leaseMillis };
        held.add(slot);
        return () => {
          held.delete(slot);
          release();
        };
      }
      const first = Math.min(...Array.from(held, (slot) => slot.expires));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ...Array.from(held, (slot) => slot.released),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, first - now));
        }),
      ]);
      clearTimeout(timer);
    }
  };
  return <A, E, R>(build: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.promise(acquire).pipe(Effect.withSpan("compiler.admission")),
      () => build,
      (release) => Effect.sync(release),
    );
};
