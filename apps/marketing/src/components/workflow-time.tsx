import { easeInOut, motion, useTransform, type MotionValue } from "motion/react";

function WorkflowDay({
  phase,
  current,
  index,
  day,
  date,
}: {
  readonly phase: MotionValue<number>;
  readonly current: MotionValue<number>;
  readonly index: number;
  readonly day: string;
  readonly date: string;
}) {
  const distance = useTransform(current, (value) => Math.abs(value - index));
  const backgroundColor = useTransform(distance, [0, 0.85], ["#333", "#fff"]);
  const color = useTransform(distance, [0, 0.85], ["#fff", "#999"]);
  const y = useTransform(distance, [0, 0.85], [-2, 0]);
  const completed = useTransform(
    phase,
    index === 0 ? [0, 0.04, 0.1, 0.88, 0.93, 1] : [0, 0.68, 0.75, 0.88, 0.93, 1],
    [0, 0, 1, 1, 0, 0],
  );
  return (
    <motion.div
      className="relative grid h-14 w-11 content-center gap-1 rounded-[5px] border border-[#ddd] bg-white text-center font-mono"
      style={{ backgroundColor, color, y }}
    >
      <span className="text-[7px]">{day}</span>
      <span className="text-[19px] leading-none">{date}</span>
      {index !== 1 && (
        <motion.span
          className="absolute -top-1.5 -right-1.5 grid size-3.5 place-items-center rounded-full border border-[#ddd] bg-white text-[8px] text-[#555]"
          style={{ opacity: completed }}
        >
          ✓
        </motion.span>
      )}
    </motion.div>
  );
}

/** A workflow sends an email, waits two days, and resumes with a follow-up; time rewinds only while the calendar is hidden. */
export function TimeWorkflow({ clock }: { readonly clock: MotionValue<number> }) {
  const phase = useTransform(clock, (time) => (time % 11) / 11);
  const current = useTransform(
    phase,
    [0, 0.18, 0.35, 0.43, 0.64, 0.93, 0.97, 1],
    [0, 0, 1, 1, 2, 2, 0, 0],
    { ease: easeInOut },
  );
  const calendarOpacity = useTransform(phase, [0, 0.03, 0.88, 0.93, 0.97, 1], [1, 1, 1, 0, 0, 1]);
  const progress = useTransform(current, (value) => value / 2);
  const sent = useTransform(phase, [0, 0.1, 0.18, 0.93, 0.98, 1], [1, 1, 0, 0, 1, 1]);
  const waiting = useTransform(phase, [0, 0.18, 0.23, 0.63, 0.68, 1], [0, 0, 1, 1, 0, 0]);
  const resumed = useTransform(phase, [0, 0.68, 0.75, 0.88, 0.93, 1], [0, 0, 1, 1, 0, 0]);
  const rotate = useTransform(phase, [0, 0.2, 0.64, 1], [0, 0, 720, 720]);
  return (
    <div aria-hidden="true" className="flex flex-col items-center gap-3">
      <motion.div className="relative flex gap-3.5" style={{ opacity: calendarOpacity }}>
        <span className="absolute inset-x-5.5 top-7 h-px bg-[#e2e2e2]" />
        <motion.span
          className="absolute inset-x-5.5 top-7 h-px origin-left bg-[#777]"
          style={{ scaleX: progress }}
        />
        <WorkflowDay phase={phase} current={current} index={0} day="MON" date="14" />
        <WorkflowDay phase={phase} current={current} index={1} day="TUE" date="15" />
        <WorkflowDay phase={phase} current={current} index={2} day="WED" date="16" />
      </motion.div>
      <div className="relative h-3.5 w-48 text-center text-[9px] text-[#888]">
        <motion.span className="absolute inset-0" style={{ opacity: sent }}>
          Welcome email sent
        </motion.span>
        <motion.span
          className="absolute inset-0 flex items-center justify-center gap-1.5"
          style={{ opacity: waiting }}
        >
          <span className="relative size-3">
            <svg viewBox="0 0 16 16" className="absolute inset-0 size-full" fill="none">
              <circle cx="8" cy="8" r="6.5" stroke="#aaa" />
            </svg>
            <motion.svg
              viewBox="0 0 16 16"
              className="absolute inset-0 size-full"
              fill="none"
              style={{ rotate }}
            >
              <path d="M8 3.5V8L10.5 9" stroke="#888" strokeLinecap="round" />
            </motion.svg>
          </span>
          Wait two days
        </motion.span>
        <motion.span className="absolute inset-0 text-[#555]" style={{ opacity: resumed }}>
          Follow-up sent
        </motion.span>
      </div>
    </div>
  );
}
