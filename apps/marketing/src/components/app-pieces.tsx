import {
  animate,
  easeInOut,
  motion,
  useAnimationFrame,
  useInView,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { appParts } from "../content/site-copy";
import { DurableWorkflow } from "./workflow-durable";

type ClockProps = { readonly clock: MotionValue<number> };

// A short move followed by a reading pause. The count never rewinds.
function useStep(clock: MotionValue<number>, period: number) {
  return useTransform(clock, (time) => {
    const cycle = time / period;
    const fraction = cycle % 1;
    const progress = Math.max(0, (fraction - 0.72) / 0.28);
    const eased = progress * progress * (3 - 2 * progress);
    return Math.floor(cycle) + eased;
  });
}

function AppPiece({
  part,
  children,
}: {
  readonly part: (typeof appParts)[number];
  readonly children: ReactNode;
}) {
  return (
    <div className="app-piece @container min-w-0 overflow-hidden rounded-[12.5px] border border-rule bg-white">
      <div className="piece-picture relative flex h-40 w-full items-center justify-center overflow-hidden border-b border-[#eee] bg-[#fafafa] text-ink">
        <div className="flex h-32 w-full shrink-0 items-center justify-center @min-[330px]:w-4/5 @min-[330px]:scale-125">
          {children}
        </div>
      </div>
      <div className="px-[25px] pt-5 pb-[22.5px]">
        <h3 className="text-[17.5px] font-semibold max-[639px]:text-xl">{part.title}</h3>
        <p className="mt-1.25 text-[15px] leading-[1.5] text-[#777] max-[639px]:text-[17.5px] max-[639px]:leading-relaxed">
          {part.body}
        </p>
      </div>
    </div>
  );
}

function ToolLine({
  phase,
  index,
  width,
}: {
  readonly phase: MotionValue<number>;
  readonly index: number;
  readonly width: number;
}) {
  const start = 0.3 + index * 0.045;
  const scaleX = useTransform(
    phase,
    [0, 0.12, 0.25, start, start + 0.18, 1],
    [1, 1, 0.3, 0.3, 1, 1],
  );
  const opacity = useTransform(
    phase,
    [0, 0.12, 0.25, start, start + 0.18, 1],
    [0.7, 0.7, 0.2, 0.2, 0.7, 0.7],
  );
  return (
    <motion.i
      className="h-0.75 origin-left bg-[#888]"
      style={{ width: `${width}%`, scaleX, opacity }}
    />
  );
}

function ToolPicture({ clock }: ClockProps) {
  const phase = useTransform(clock, (time) => (time % 4.8) / 4.8);
  const backgroundColor = useTransform(
    phase,
    [0, 0.1, 0.22, 0.38, 0.5, 1],
    ["#fff", "#fff", "#ededed", "#ededed", "#fff", "#fff"],
  );
  const borderColor = useTransform(
    phase,
    [0, 0.1, 0.22, 0.4, 0.55, 1],
    ["#ddd", "#ddd", "#888", "#888", "#ddd", "#ddd"],
  );
  const arrowX = useTransform(phase, [0, 0.2, 0.35, 0.5, 1], [0, 0, 3, 0, 0]);
  const doneOpacity = useTransform(phase, [0, 0.52, 0.62, 0.84, 1], [0, 0, 1, 1, 0]);
  return (
    <div aria-hidden="true" className="flex items-center gap-4">
      <div className="relative">
        <motion.span
          className="block rounded-[6px] border border-[#ddd] bg-white p-3 font-mono text-[11px]"
          style={{ backgroundColor, borderColor }}
        >
          query_logs()
        </motion.span>
        <motion.small
          className="absolute inset-x-0 top-full mt-2 text-center font-mono text-[8px] text-[#888]"
          style={{ opacity: doneOpacity }}
        >
          ✓ Done
        </motion.small>
      </div>
      <motion.span className="text-[#aaa]" style={{ x: arrowX }}>
        →
      </motion.span>
      <span className="grid w-14.5 gap-1.75 rounded-[6px] border border-[#ddd] bg-white p-3">
        {[100, 70, 100].map((width, index) => (
          <ToolLine key={index} phase={phase} index={index} width={width} />
        ))}
      </span>
    </div>
  );
}

const skills = [
  { title: "Investigate an error", steps: ["Find recent failures", "Compare deployments"] },
  { title: "Write a daily digest", steps: ["Gather today’s updates", "Summarize what changed"] },
  { title: "Review a pull request", steps: ["Read the changes", "Flag bugs worth fixing"] },
] as const;

function SkillDocument({
  skill,
  index,
  step,
}: {
  readonly skill: (typeof skills)[number];
  readonly index: number;
  readonly step: MotionValue<number>;
}) {
  const depth = useTransform(step, (value) => (((index - value) % 3) + 3) % 3);
  // The front sheet fades as it slips aside, then returns behind the deck.
  // Both ends of the wrap are the same front pose; stacking changes only at zero opacity.
  const positions = [0, 1, 2, 2.35, 2.65, 3];
  const x = useTransform(depth, positions, [0, 4, 8, 12, -24, 0]);
  const y = useTransform(depth, positions, [0, -5, -10, -12, -4, 0]);
  const rotate = useTransform(depth, positions, [-3, 2, 7, 9, -9, -3]);
  const scale = useTransform(depth, positions, [1, 0.98, 0.96, 0.96, 0.99, 1]);
  const opacity = useTransform(depth, positions, [1, 1, 1, 0, 0, 1]);
  const zIndex = useTransform(depth, (value) => (value > 2.65 ? 4 : 3 - Math.round(value)));
  return (
    <motion.div
      className="absolute inset-0 grid content-center gap-2 rounded-[6px] border border-[#ddd] bg-white px-4.5 py-3 shadow-[0_2px_8px_#00000005]"
      style={{ x, y, rotate, scale, opacity, zIndex }}
    >
      <span className="flex items-center justify-between font-mono text-[8px] text-[#aaa]">
        <span>SKILL.md</span>
        <span>{index + 1} / 3</span>
      </span>
      <strong className="text-left font-mono text-[10px] font-normal"># {skill.title}</strong>
      <small className="text-left font-mono text-[9px] leading-[1.8] text-[#888]">
        1. {skill.steps[0]}
        <br />
        2. {skill.steps[1]}
      </small>
    </motion.div>
  );
}

function SkillsPicture({ clock }: ClockProps) {
  const automaticStep = useStep(clock, 3.6);
  const extraSteps = useMotionValue(0);
  const step = useTransform(() => automaticStep.get() + extraSteps.get());
  const reducedMotion = useReducedMotion();
  const shuffle = useRef<ReturnType<typeof animate> | null>(null);
  useEffect(() => () => shuffle.current?.stop(), []);
  const next = () => {
    // Continue from the current position even when clicks arrive during a shuffle.
    shuffle.current?.stop();
    const target = Math.floor(extraSteps.get()) + 1;
    if (reducedMotion) extraSteps.set(target);
    else shuffle.current = animate(extraSteps, target, { duration: 0.85, ease: [0.4, 0, 0.2, 1] });
  };
  return (
    <motion.button
      type="button"
      aria-label="Shuffle skills"
      onHoverStart={next}
      onClick={next}
      className="flex h-full w-full cursor-pointer items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#777]"
    >
      <div aria-hidden="true" className="relative h-25 w-51.25 translate-y-2">
        {skills.map((skill, index) => (
          <SkillDocument key={skill.title} skill={skill} index={index} step={step} />
        ))}
      </div>
    </motion.button>
  );
}

function ChartBar({
  phase,
  height,
  index,
}: {
  readonly phase: MotionValue<number>;
  readonly height: number;
  readonly index: number;
}) {
  const scaleY = useTransform(
    phase,
    [0, 0.22, 0.5, 0.78, 1],
    [1, 0.85 + index * 0.02, 1.12 - index * 0.025, 0.9 + index * 0.01, 1],
    { ease: easeInOut },
  );
  return (
    <motion.i
      className="flex-1 origin-bottom rounded-t-[1px] bg-[#777] last:bg-[#222]"
      style={{ height: `${height}%`, scaleY }}
    />
  );
}

function UiPicture({ clock }: ClockProps) {
  const phase = useTransform(clock, (time) => (time % 8) / 8);
  const count = useTransform(phase, [0, 0.22, 0.5, 0.78, 1], [1284, 1298, 1312, 1296, 1284], {
    ease: easeInOut,
  });
  const text = useTransform(count, (value) => Math.round(value).toLocaleString("en-US"));
  return (
    <div
      aria-hidden="true"
      className="w-52.5 translate-y-2 overflow-hidden rounded-[6px] border border-[#ddd] bg-white"
    >
      <div className="flex items-center gap-0.75 border-b border-[#eee] p-1.75">
        {[0, 1, 2].map((dot) => (
          <i key={dot} className="h-0.75 w-0.75 rounded-full bg-[#ccc]" />
        ))}
        <span className="pl-1.25 font-mono text-[6px] text-[#aaa]">
          app.demo-org.executor.website
        </span>
      </div>
      <div className="grid gap-1.25 p-3 text-left">
        <span className="text-[7px] text-[#999]">Active users</span>
        <motion.strong className="h-6 font-mono text-[16px] font-medium tabular-nums">
          {text}
        </motion.strong>
        <div className="flex h-8.5 items-end gap-1.25">
          {[30, 48, 38, 64, 57, 82, 94].map((height, index) => (
            <ChartBar key={index} phase={phase} height={height} index={index} />
          ))}
        </div>
      </div>
    </div>
  );
}

const storageEntries = [
  { key: "run_count", value: "42" },
  { key: "theme", value: '"light"' },
  { key: "last_sync", value: "12:00" },
  { key: "summary", value: '"saved"' },
  { key: "cursor", value: '"page_3"' },
] as const;

function StorageRow({
  row,
  index,
  step,
}: {
  readonly row: (typeof storageEntries)[number];
  readonly index: number;
  readonly step: MotionValue<number>;
}) {
  // Recycle below the clipped window, never while a row is visible.
  const y = useTransform(
    step,
    (value) => `${(((index + value) % storageEntries.length) - 1) * 100}%`,
  );
  return (
    <motion.div
      className="absolute inset-x-0 top-0 grid h-1/2 grid-cols-2 items-center border-b border-[#eee] bg-white px-2.5 text-[#666]"
      style={{ y }}
    >
      <span>{row.key}</span>
      <span>{row.value}</span>
    </motion.div>
  );
}

function StoragePicture({ clock }: ClockProps) {
  const step = useStep(clock, 2.7);
  return (
    <div
      aria-hidden="true"
      className="w-50 overflow-hidden rounded-[6px] border border-[#ddd] bg-white text-left font-mono text-[9px]"
    >
      <div className="grid h-6.5 grid-cols-2 items-center border-b border-[#eee] bg-[#fcfcfc] px-2.5 text-[8px] text-[#aaa]">
        <span>key</span>
        <span>value</span>
      </div>
      <div className="relative h-14.5 overflow-hidden">
        {storageEntries.map((row, index) => (
          <StorageRow key={row.key} row={row} index={index} step={step} />
        ))}
      </div>
      <div className="flex h-6.5 items-center px-2.5 text-[8px] text-[#888]">
        ✓ Saved between runs
      </div>
    </div>
  );
}

function useTriggerPhase(phase: MotionValue<number>, index: number) {
  return useTransform(phase, (value) => (value * 2 - index + 2) % 2);
}

function TriggerSource({
  phase,
  index,
  label,
}: {
  readonly phase: MotionValue<number>;
  readonly index: number;
  readonly label: string;
}) {
  const local = useTriggerPhase(phase, index);
  const backgroundColor = useTransform(
    local,
    [0, 0.08, 0.18, 0.35, 0.52, 2],
    ["#fff", "#fff", "#ededed", "#ededed", "#fff", "#fff"],
  );
  const borderColor = useTransform(
    local,
    [0, 0.08, 0.18, 0.35, 0.52, 2],
    ["#ddd", "#ddd", "#999", "#999", "#ddd", "#ddd"],
  );
  return (
    <motion.span
      className="rounded-md border border-[#ddd] bg-white px-3 py-1.5"
      style={{ backgroundColor, borderColor }}
    >
      {label}
    </motion.span>
  );
}

function triggerPoint(progress: number) {
  if (progress < 0.2) return { x: (progress / 0.2) * 16, y: 17 };
  if (progress > 0.7) return { x: 40 + ((progress - 0.7) / 0.3) * 24, y: 35 };
  const t = (progress - 0.2) / 0.5;
  const u = 1 - t;
  return {
    x: u ** 3 * 16 + 3 * u ** 2 * t * 32 + 3 * u * t ** 2 * 24 + t ** 3 * 40,
    y: 17 + 18 * (3 * t ** 2 - 2 * t ** 3),
  };
}

function TriggerPulse({
  phase,
  index,
}: {
  readonly phase: MotionValue<number>;
  readonly index: number;
}) {
  const local = useTriggerPhase(phase, index);
  const travel = useTransform(local, [0, 0.14, 0.58, 2], [0, 0, 1, 1]);
  const cx = useTransform(travel, (value) => triggerPoint(value).x);
  const cy = useTransform(travel, (value) =>
    index === 0 ? triggerPoint(value).y : 70 - triggerPoint(value).y,
  );
  const opacity = useTransform(local, [0, 0.12, 0.17, 0.54, 0.62, 2], [0, 0, 1, 1, 0, 0]);
  return <motion.circle r="2.5" cx={cx} cy={cy} fill="#333" style={{ opacity }} />;
}

function TriggersPicture({ clock }: ClockProps) {
  const phase = useTransform(clock, (time) => (time % 8.4) / 8.4);
  const arrival = useTransform(clock, (time) => (time % 4.2) / 4.2);
  const scale = useTransform(arrival, [0, 0.55, 0.63, 0.76, 1], [1, 1, 1.06, 1, 1]);
  const opacity = useTransform(arrival, [0, 0.59, 0.68, 0.86, 1], [0, 0, 1, 1, 0]);
  return (
    <div aria-hidden="true" className="grid grid-cols-[auto_64px_auto] items-center">
      <div className="grid gap-2 font-mono text-[10px]">
        <TriggerSource phase={phase} index={0} label="↗ Webhook" />
        <TriggerSource phase={phase} index={1} label="◷ Schedule" />
      </div>
      <svg viewBox="0 0 64 70" className="h-17.5 w-full overflow-visible" fill="none">
        <path d="M0 17H16C32 17 24 35 40 35H64M0 53H16C32 53 24 35 40 35" stroke="#bbb" />
        <TriggerPulse phase={phase} index={0} />
        <TriggerPulse phase={phase} index={1} />
      </svg>
      <div className="relative">
        <motion.span
          className="grid size-11 place-items-center rounded-[10px] bg-[#222] font-mono text-xl text-white"
          style={{ scale }}
        >
          ƒ
        </motion.span>
        <motion.span
          className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full border border-[#ddd] bg-white text-[9px] text-[#555]"
          style={{ opacity }}
        >
          ✓
        </motion.span>
        <small className="absolute -inset-x-2 top-full mt-2 text-center font-mono text-[9px] text-[#888]">
          Your app
        </small>
      </div>
    </div>
  );
}

/** A persistent clock drives seamless capability loops and holds their positions while offscreen. */
export function AppPieces() {
  const [tools, skills, ui, storage, triggers, workflows] = appParts;
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref);
  const reducedMotion = useReducedMotion();
  const clock = useMotionValue(0);
  useAnimationFrame((_, delta) => {
    if (visible && reducedMotion === false) clock.set(clock.get() + Math.min(delta, 64) / 1000);
  });
  return (
    <div ref={ref} className="mt-7.5 max-w-225">
      <div className="app-pieces grid grid-cols-2 gap-[17.5px] max-[639px]:grid-cols-1 max-[639px]:gap-5">
        <AppPiece part={tools}>
          <ToolPicture clock={clock} />
        </AppPiece>
        <AppPiece part={skills}>
          <SkillsPicture clock={clock} />
        </AppPiece>
        <AppPiece part={ui}>
          <UiPicture clock={clock} />
        </AppPiece>
        <AppPiece part={storage}>
          <StoragePicture clock={clock} />
        </AppPiece>
        <AppPiece part={triggers}>
          <TriggersPicture clock={clock} />
        </AppPiece>
        <AppPiece part={workflows}>
          <DurableWorkflow clock={clock} />
        </AppPiece>
      </div>
    </div>
  );
}
