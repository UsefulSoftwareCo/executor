import { motion, useTransform, type MotionValue } from "motion/react";

const stages = [
  {
    id: "fetch-first",
    stamp: "STEP 01",
    title: "fetch_data()",
    body: "24 records returned",
    completed: "Result saved",
    sleep: "2 days",
  },
  {
    id: "send-first",
    stamp: "STEP 02",
    title: "send_digest()",
    body: "Digest delivered",
    completed: "Result saved",
    sleep: "1 week",
  },
  {
    id: "fetch-next",
    stamp: "STEP 03",
    title: "fetch_data()",
    body: "26 records returned",
    completed: "Result saved",
    sleep: "2 days",
  },
  {
    id: "send-next",
    stamp: "STEP 04",
    title: "send_digest()",
    body: "Digest delivered",
    completed: "Result saved",
    sleep: "1 week",
  },
] as const;
type Stage = (typeof stages)[number];

const stageDuration = 5.6;
const stageStride = 160;

function useSlot(position: MotionValue<number>, index: number) {
  return useTransform(
    position,
    (value) => ((((index - value + 2) % stages.length) + stages.length) % stages.length) - 2,
  );
}

function TaskCard({
  stage,
  index,
  turn,
  position,
}: {
  readonly stage: Stage;
  readonly index: number;
  readonly turn: MotionValue<number>;
  readonly position: MotionValue<number>;
}) {
  const slot = useSlot(position, index);
  // A task finishes during the preceding connector, then becomes the left-hand card.
  const age = useTransform(
    turn,
    (value) => (((value - index + 1) % stages.length) + stages.length) % stages.length,
  );
  const x = useTransform(slot, (value) => value * stageStride);
  const opacity = useTransform(slot, [-2, -1, 0, 1, 2], [0, 0.2, 1, 1, 0]);
  const contentOpacity = useTransform(
    age,
    [0, 0.36, 0.5, 1.9, 2.1, stages.length],
    [0.35, 0.35, 1, 1, 0.35, 0.35],
  );
  const done = useTransform(age, [0, 0.57, 0.65, 1.9, 2.1, stages.length], [0, 0, 1, 1, 0, 0]);
  const borderColor = useTransform(done, [0, 1], ["#e4e4e4", "#ccc"]);
  const status = useTransform(age, (value): string => {
    if (value < 0.44) return "Waiting";
    if (value < 0.57) return "Running…";
    if (value < 1.9) return stage.body;
    return "Waiting";
  });
  return (
    <motion.div
      className="absolute top-1/2 left-1/2 -mt-10.5 -ml-33 flex h-21 w-26 flex-col overflow-hidden rounded-[5px] border border-[#ddd] bg-white text-left"
      style={{ x, opacity, borderColor }}
    >
      <div className="px-2.5 pt-2 font-mono text-[6.5px] text-[#aaa]">{stage.stamp}</div>
      <motion.div
        className="flex flex-1 flex-col justify-center px-2.5"
        style={{ opacity: contentOpacity }}
      >
        <div className="font-mono text-[9px] text-[#333]">{stage.title}</div>
        <motion.div className="mt-1 text-[8px] leading-[1.5] text-[#888]">{status}</motion.div>
      </motion.div>
      <motion.div className="px-2.5 pb-2 text-[7px] text-[#777]" style={{ opacity: done }}>
        ✓ {stage.completed}
      </motion.div>
    </motion.div>
  );
}

function SleepClock({ progress }: { readonly progress: MotionValue<number> }) {
  const rotate = useTransform(progress, [0, 1], [0, 360]);
  return (
    <motion.svg viewBox="0 0 28 28" className="size-full" fill="none" style={{ rotate }}>
      <path d="M14 7V14L18 16" stroke="#666" strokeWidth="1.25" strokeLinecap="round" />
    </motion.svg>
  );
}

function SleepStep({
  stage,
  index,
  turn,
  position,
}: {
  readonly stage: Stage;
  readonly index: number;
  readonly turn: MotionValue<number>;
  readonly position: MotionValue<number>;
}) {
  const slot = useSlot(position, index);
  const age = useTransform(
    turn,
    (value) => (((value - index) % stages.length) + stages.length) % stages.length,
  );
  const x = useTransform(slot, (value) => value * stageStride);
  const opacity = useTransform(slot, [-2, -1, 0, 1, 2], [0, 0.1, 1, 0.1, 0]);
  const progress = useTransform(age, [0, 0.08, 0.44, 1.9, 2.1, stages.length], [0, 0, 1, 1, 0, 0]);
  const dotX = useTransform(age, [0, 0.06, 0.5, stages.length], [0, 0, 56, 56]);
  const dotOpacity = useTransform(
    age,
    [0, 0.06, 0.12, 0.5, 0.56, stages.length],
    [0, 0, 1, 1, 0, 0],
  );
  return (
    <motion.div className="absolute top-1/2 left-1/2 -mt-3.5 -ml-7 h-7 w-14" style={{ x, opacity }}>
      <span className="absolute inset-x-0 -top-4 text-center font-mono text-[7px] text-[#aaa]">
        sleep
      </span>
      <span className="absolute inset-x-0 top-1/2 h-px bg-[#ddd]" />
      <motion.span
        className="absolute top-1/2 -mt-0.5 -ml-0.5 size-1 rounded-full bg-[#555]"
        style={{ x: dotX, opacity: dotOpacity }}
      />
      <div className="absolute inset-y-0 left-3.5 size-7 rounded-full bg-[#fafafa]">
        <svg viewBox="0 0 28 28" className="absolute inset-0 size-full -rotate-90" fill="none">
          <circle cx="14" cy="14" r="12" stroke="#ddd" />
          <motion.circle
            cx="14"
            cy="14"
            r="12"
            stroke="#888"
            strokeWidth="1.25"
            style={{ pathLength: progress }}
          />
        </svg>
        <SleepClock progress={progress} />
      </div>
      <span className="absolute -inset-x-1 top-full mt-1.5 text-center font-mono text-[7px] text-[#999]">
        {stage.sleep}
      </span>
    </motion.div>
  );
}

/** Checkpointed tasks alternate with durable sleeps; completed results stay saved while execution waits. */
export function DurableWorkflow({ clock }: { readonly clock: MotionValue<number> }) {
  const turn = useTransform(clock, (time) => time / stageDuration);
  const position = useTransform(turn, (value) => {
    const progress = Math.max(0, ((value % 1) - 0.8) / 0.2);
    return Math.floor(value) + progress * progress * (3 - 2 * progress);
  });
  return (
    <div
      aria-hidden="true"
      className="relative h-full w-full max-w-87.5 overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_3%,#000_97%,transparent)]"
    >
      {stages.map((stage, index) => (
        <SleepStep key={stage.id} stage={stage} index={index} turn={turn} position={position} />
      ))}
      {stages.map((stage, index) => (
        <TaskCard key={stage.id} stage={stage} index={index} turn={turn} position={position} />
      ))}
    </div>
  );
}
