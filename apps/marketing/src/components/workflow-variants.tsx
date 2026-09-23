import {
  motion,
  useAnimationFrame,
  useInView,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useRef, type ReactNode } from "react";
import { DurableWorkflow } from "./workflow-durable";

type IllustrationProps = { readonly clock: MotionValue<number> };

function Direction({
  letter,
  title,
  caption,
  children,
}: {
  readonly letter: string;
  readonly title: string;
  readonly caption: string;
  readonly children: ReactNode;
}) {
  return (
    <section id={letter.toLowerCase()}>
      <h2 className="mb-3 flex items-center gap-2.5 text-[13px] font-medium">
        <span className="grid size-5 place-items-center rounded border border-[#ddd] font-mono text-[10px] text-[#999]">
          {letter}
        </span>
        {title}
      </h2>
      <div className="overflow-hidden rounded-[10px] border border-[#e7e7e7] bg-white">
        <div
          aria-hidden="true"
          className="relative flex h-32 items-center justify-center overflow-hidden border-b border-[#eee] bg-[#fafafa]"
        >
          {children}
        </div>
        <div className="px-5 pt-4 pb-4.5">
          <h3 className="text-[14px] font-semibold">Workflows</h3>
          <p className="mt-1 text-[12px] leading-[1.5] text-[#777]">
            Durable work across multiple steps.
          </p>
        </div>
      </div>
      <p className="mt-3 max-w-[40ch] text-[12px] leading-relaxed text-[#888]">{caption}</p>
    </section>
  );
}

function BriefSource({
  phase,
  title,
  text,
  start,
}: {
  readonly phase: MotionValue<number>;
  readonly title: string;
  readonly text: string;
  readonly start: number;
}) {
  const x = useTransform(phase, [0, start, start + 0.07, 0.85, 1], [-5, -5, 0, 0, -5]);
  const opacity = useTransform(phase, [0, start, start + 0.07, 0.85, 1], [0.35, 0.35, 1, 1, 0.35]);
  const check = useTransform(phase, [0, start + 0.12, start + 0.19, 0.85, 1], [0, 0, 1, 1, 0]);
  return (
    <motion.div
      className="relative w-28 rounded-[5px] border border-[#ddd] bg-white px-2.5 py-1.5 text-left"
      style={{ x, opacity }}
    >
      <div className="font-mono text-[8px] text-[#333]">{title}</div>
      <div className="mt-0.5 text-[7px] text-[#999]">{text}</div>
      <motion.span
        className="absolute top-1.5 right-2 text-[8px] text-[#777]"
        style={{ opacity: check }}
      >
        ✓
      </motion.span>
    </motion.div>
  );
}

function BriefLine({
  phase,
  start,
  children,
}: {
  readonly phase: MotionValue<number>;
  readonly start: number;
  readonly children: ReactNode;
}) {
  const opacity = useTransform(phase, [0, start, start + 0.07, 0.86, 1], [0, 0, 1, 1, 0]);
  const y = useTransform(phase, [0, start, start + 0.07, 1], [3, 3, 0, 0]);
  return (
    <motion.div className="flex items-center gap-1.5 text-[7px] text-[#777]" style={{ opacity, y }}>
      <span className="size-0.5 rounded-full bg-[#aaa]" />
      {children}
    </motion.div>
  );
}

function MorningBrief({ clock }: IllustrationProps) {
  const phase = useTransform(clock, (time) => (time % 9) / 9);
  const x = useTransform(phase, [0, 0.27, 0.49, 1], [0, 0, 30, 30]);
  const opacity = useTransform(phase, [0, 0.25, 0.31, 0.46, 0.52, 1], [0, 0, 1, 1, 0, 0]);
  const saved = useTransform(phase, [0, 0.71, 0.78, 0.89, 1], [0, 0, 1, 1, 0]);
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid gap-1.5">
        <BriefSource phase={phase} title="3 issues closed" text="Project updates" start={0.04} />
        <BriefSource
          phase={phase}
          title="2 meeting notes"
          text="Decisions & next steps"
          start={0.14}
        />
      </div>
      <div className="relative h-px w-7.5 bg-[#ddd]">
        <motion.span
          className="absolute -top-0.75 -left-0.75 size-1.5 rounded-full bg-[#444]"
          style={{ x, opacity }}
        />
      </div>
      <div className="relative w-30 -rotate-2 rounded-[5px] border border-[#ddd] bg-white px-3 py-2.5 text-left shadow-[0_2px_6px_#00000004]">
        <div className="font-mono text-[7px] text-[#aaa]">brief.md</div>
        <div className="mt-1.5 text-[10px] font-medium text-[#333]">Morning brief</div>
        <div className="mt-2 grid gap-1.5">
          <BriefLine phase={phase} start={0.46}>
            Search shipped
          </BriefLine>
          <BriefLine phase={phase} start={0.54}>
            Docs reviewed
          </BriefLine>
          <BriefLine phase={phase} start={0.62}>
            Next: invite testers
          </BriefLine>
        </div>
        <motion.span
          className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full border border-[#ddd] bg-white text-[9px] text-[#555]"
          style={{ opacity: saved }}
        >
          ✓
        </motion.span>
      </div>
    </div>
  );
}

function SavedStep({
  phase,
  label,
  start,
}: {
  readonly phase: MotionValue<number>;
  readonly label: string;
  readonly start: number;
}) {
  const opacity = useTransform(phase, [0, start, start + 0.07, 0.88, 1], [0, 0, 1, 1, 0]);
  const pending = useTransform(opacity, (value) => 1 - value);
  return (
    <div className="flex items-center gap-2.5">
      <span className="relative grid size-3 place-items-center text-[8px]">
        <motion.span
          className="absolute size-1 rounded-full bg-[#ccc]"
          style={{ opacity: pending }}
        />
        <motion.span className="absolute text-[#555]" style={{ opacity }}>
          ✓
        </motion.span>
      </span>
      <span className="text-[9px] text-[#666]">{label}</span>
      <motion.span className="ml-auto font-mono text-[7px] text-[#aaa]" style={{ opacity }}>
        saved
      </motion.span>
    </div>
  );
}

function ResumableRun({ clock }: IllustrationProps) {
  const phase = useTransform(clock, (time) => (time % 11) / 11);
  const failed = useTransform(phase, [0, 0.37, 0.41, 0.5, 0.55, 1], [0, 0, 1, 1, 0, 0]);
  const retrying = useTransform(phase, [0, 0.52, 0.58, 0.67, 0.72, 1], [0, 0, 1, 1, 0, 0]);
  const done = useTransform(phase, [0, 0.7, 0.77, 0.88, 1], [0, 0, 1, 1, 0]);
  const idle = useTransform(() => 1 - Math.max(failed.get(), retrying.get(), done.get()));
  const borderColor = useTransform(failed, [0, 1], ["#eee", "#c9bda9"]);
  const backgroundColor = useTransform(failed, [0, 1], ["#fafafa", "#f4f0e9"]);
  const progress = useTransform(
    phase,
    [0, 0.08, 0.18, 0.27, 0.7, 0.78, 1],
    [0, 0, 0.33, 0.66, 0.66, 1, 1],
  );
  const progressOpacity = useTransform(phase, [0, 0.03, 0.9, 1], [0, 1, 1, 0]);
  return (
    <div className="w-62 overflow-hidden rounded-[6px] border border-[#ddd] bg-white text-left">
      <div className="flex items-center justify-between border-b border-[#eee] px-3 py-1.5">
        <span className="font-mono text-[8px] text-[#777]">weekly-report</span>
        <span className="relative h-2.5 w-18 text-right font-mono text-[7px] text-[#aaa]">
          <motion.span className="absolute inset-0" style={{ opacity: idle }}>
            Running
          </motion.span>
          <motion.span className="absolute inset-0 text-[#9a7847]" style={{ opacity: failed }}>
            Interrupted
          </motion.span>
          <motion.span className="absolute inset-0" style={{ opacity: retrying }}>
            Resuming
          </motion.span>
          <motion.span className="absolute inset-0 text-[#555]" style={{ opacity: done }}>
            Complete
          </motion.span>
        </span>
      </div>
      <div className="grid gap-1.5 px-3 py-2">
        <SavedStep phase={phase} label="Read 3 sources" start={0.1} />
        <SavedStep phase={phase} label="Write the report" start={0.2} />
        <motion.div
          className="-mx-1 flex items-center gap-2.5 rounded border border-[#eee] bg-[#fafafa] px-1 py-1"
          style={{ borderColor, backgroundColor }}
        >
          <span className="relative grid size-3 place-items-center text-[8px]">
            <motion.span
              className="absolute size-1 rounded-full bg-[#bbb]"
              style={{ opacity: idle }}
            />
            <motion.span className="absolute text-[#9a7847]" style={{ opacity: failed }}>
              !
            </motion.span>
            <motion.span className="absolute text-[#777]" style={{ opacity: retrying }}>
              ↻
            </motion.span>
            <motion.span className="absolute text-[#555]" style={{ opacity: done }}>
              ✓
            </motion.span>
          </span>
          <span className="text-[9px] text-[#555]">Deliver to inbox</span>
          <span className="relative ml-auto h-2.5 w-15 font-mono text-[7px] text-[#aaa]">
            <motion.span className="absolute inset-0 text-right" style={{ opacity: failed }}>
              retry in 1s
            </motion.span>
            <motion.span className="absolute inset-0 text-right" style={{ opacity: retrying }}>
              retrying…
            </motion.span>
            <motion.span className="absolute inset-0 text-right" style={{ opacity: done }}>
              delivered
            </motion.span>
          </span>
        </motion.div>
      </div>
      <div className="h-0.5 bg-[#f5f5f5]">
        <motion.div
          className="h-full w-full origin-left bg-[#999]"
          style={{ scaleX: progress, opacity: progressOpacity }}
        />
      </div>
    </div>
  );
}

/** Three isolated content directions for comparing the workflow illustration at its landing-page size. */
export function WorkflowVariants() {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useInView(ref);
  const reducedMotion = useReducedMotion();
  const clock = useMotionValue(0);
  useAnimationFrame((_, delta) => {
    if (visible && reducedMotion === false) clock.set(clock.get() + Math.min(delta, 64) / 1000);
  });
  return (
    <div
      ref={ref}
      className="grid gap-x-7 gap-y-10 min-[760px]:grid-cols-2 min-[1120px]:grid-cols-3"
    >
      <Direction
        letter="A"
        title="Make something useful"
        caption="Project updates and meeting notes become a morning brief."
      >
        <MorningBrief clock={clock} />
      </Direction>
      <Direction
        letter="B"
        title="One step leads to the next"
        caption="Run a step, save its result, sleep, then resume the next step."
      >
        <DurableWorkflow clock={clock} />
      </Direction>
      <Direction
        letter="C"
        title="Keep the work you did"
        caption="A delivery fails. The run resumes there, keeping the finished steps."
      >
        <ResumableRun clock={clock} />
      </Direction>
    </div>
  );
}
