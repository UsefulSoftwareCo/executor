import type { Scheduler } from "effect";

export function programScheduler(parent: Scheduler.Scheduler) {
  let paused = false;
  const held: Array<() => void> = [];
  const scheduler: Scheduler.Scheduler = {
    executionMode: parent.executionMode,
    shouldYield: (fiber) => paused || parent.shouldYield(fiber),
    makeDispatcher: () => {
      const dispatcher = parent.makeDispatcher();
      const scheduleTask = (task: () => void, priority: number) =>
        dispatcher.scheduleTask(() => {
          if (paused) held.push(() => scheduleTask(task, priority));
          else task();
        }, priority);
      return {
        scheduleTask,
        flush: () => {
          if (!paused) dispatcher.flush();
        },
      };
    },
  };
  return {
    scheduler,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const schedule of held.splice(0)) schedule();
    },
  };
}
