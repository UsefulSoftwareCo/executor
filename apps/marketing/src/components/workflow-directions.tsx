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
import githubLogo from "../assets/logos/github.svg?url";
import linearLogo from "../assets/logos/linear.svg?url";
import slackLogo from "../assets/logos/slack.svg?url";
import { TimeWorkflow } from "./workflow-time";

type DemoProps = { readonly clock: MotionValue<number> };

function usePhase(clock: MotionValue<number>, duration: number) {
  return useTransform(clock, (time) => (time % duration) / duration);
}

function Direction({
  number,
  title,
  children,
}: {
  readonly number: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section id={`direction-${number}`}>
      <h2 className="mb-3 flex items-center gap-2.5 text-[13px] font-medium">
        <span className="font-mono text-[10px] text-[#aaa]">{number}</span>
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
    </section>
  );
}

function FlipTile({
  phase,
  index,
  label,
  result,
  symbol,
}: {
  readonly phase: MotionValue<number>;
  readonly index: number;
  readonly label: string;
  readonly result: string;
  readonly symbol: string;
}) {
  const start = 0.06 + index * 0.22;
  const rotateY = useTransform(phase, [0, start, start + 0.13, 0.85, 1], [0, 0, 180, 180, 360]);
  const y = useTransform(
    phase,
    [0, start, start + 0.065, start + 0.13, 0.85, 1],
    [0, 0, -5, 0, 0, 0],
  );
  return (
    <motion.div className="relative h-17 w-15 [transform-style:preserve-3d]" style={{ rotateY, y }}>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[6px] border border-[#ddd] bg-white [backface-visibility:hidden]">
        <span className="font-mono text-[21px] text-[#555]">{symbol}</span>
        <span className="font-mono text-[9px] text-[#777]">{label}</span>
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-[6px] border border-[#333] bg-[#333] text-white [backface-visibility:hidden] [transform:rotateY(180deg)]">
        <span className="text-[16px]">✓</span>
        <span className="font-mono text-[8px]">{result}</span>
      </div>
    </motion.div>
  );
}

function ChainReaction({ clock }: DemoProps) {
  const phase = usePhase(clock, 8);
  return (
    <div className="flex items-center gap-3 [perspective:600px]">
      <FlipTile phase={phase} index={0} label="Clone" result="repo/" symbol="↓" />
      <span className="text-[12px] text-[#bbb]">›</span>
      <FlipTile phase={phase} index={1} label="Test" result="18 passed" symbol="{ }" />
      <span className="text-[12px] text-[#bbb]">›</span>
      <FlipTile phase={phase} index={2} label="Deploy" result="v1.2 live" symbol="↗" />
    </div>
  );
}

function ItineraryRow({
  phase,
  start,
  symbol,
  label,
  detail,
}: {
  readonly phase: MotionValue<number>;
  readonly start: number;
  readonly symbol: string;
  readonly label: string;
  readonly detail: string;
}) {
  const opacity = useTransform(phase, [0, start, start + 0.1, 0.86, 1], [0, 0, 1, 1, 0]);
  const x = useTransform(phase, [0, start, start + 0.1, 1], [4, 4, 0, 0]);
  return (
    <div className="flex h-5 items-center gap-2">
      <span className="w-3 text-center text-[10px] text-[#aaa]">{symbol}</span>
      <span className="text-[8px] text-[#777]">{label}</span>
      <motion.span className="ml-auto font-mono text-[7px] text-[#777]" style={{ opacity, x }}>
        {detail} ✓
      </motion.span>
    </div>
  );
}

function Itinerary({ clock }: DemoProps) {
  const phase = usePhase(clock, 9.5);
  return (
    <div className="relative w-60 overflow-hidden rounded-[6px] border border-[#ddd] bg-white px-3 py-2 text-left">
      <div className="flex items-center justify-between border-b border-dashed border-[#ddd] pb-1.5">
        <span className="font-mono text-[12px] text-[#333]">
          SFO <span className="text-[#aaa]">→</span> JFK
        </span>
        <span className="font-mono text-[7px] text-[#aaa]">THU — SUN</span>
      </div>
      <div className="mt-1">
        <ItineraryRow phase={phase} start={0.08} symbol="↗" label="Find a flight" detail="08:30" />
        <ItineraryRow
          phase={phase}
          start={0.31}
          symbol="⌂"
          label="Reserve a room"
          detail="3 nights"
        />
        <ItineraryRow
          phase={phase}
          start={0.55}
          symbol="▦"
          label="Add to calendar"
          detail="Trip saved"
        />
      </div>
    </div>
  );
}

function ApprovalGate({ clock }: DemoProps) {
  const phase = usePhase(clock, 8.5);
  const x = useTransform(phase, [0, 0.12, 0.38, 0.64, 1], [185, 185, 72, 72, 185]);
  const y = useTransform(phase, [0, 0.12, 0.38, 0.64, 1], [99, 99, 72, 72, 99]);
  const cursorOpacity = useTransform(phase, [0, 0.08, 0.16, 0.48, 0.58, 1], [0, 0, 1, 1, 0, 0]);
  const scale = useTransform(phase, [0, 0.38, 0.42, 0.47, 1], [1, 1, 0.95, 1, 1]);
  const approved = useTransform(phase, [0, 0.45, 0.53, 0.86, 1], [0, 0, 1, 1, 0]);
  const awaiting = useTransform(approved, (value) => 1 - value);
  return (
    <div className="relative w-60 rounded-[7px] border border-[#ddd] bg-white p-3 text-left">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-[#444]">Publish release notes?</span>
        <span className="rounded border border-[#eee] px-1 font-mono text-[7px] text-[#aaa]">
          You
        </span>
      </div>
      <div className="mt-2 font-mono text-[8px] text-[#999]">▤ release-notes.md</div>
      <div className="mt-3 flex items-center gap-2">
        <motion.span
          className="relative grid h-6 w-24 place-items-center rounded bg-[#333] text-[8px] text-white"
          style={{ scale }}
        >
          <motion.span className="absolute" style={{ opacity: awaiting }}>
            Approve
          </motion.span>
          <motion.span className="absolute" style={{ opacity: approved }}>
            ✓ Approved
          </motion.span>
        </motion.span>
        <motion.span className="text-[8px] text-[#aaa]" style={{ opacity: awaiting }}>
          Not now
        </motion.span>
        <motion.span className="text-[8px] text-[#888]" style={{ opacity: approved }}>
          Continuing →
        </motion.span>
      </div>
      <motion.svg
        viewBox="0 0 18 22"
        className="absolute top-0 left-0 h-5 w-4"
        style={{ x, y, opacity: cursorOpacity }}
      >
        <path
          d="M2 1L15 13L9 14L6 20L2 1Z"
          fill="#333"
          stroke="white"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </motion.svg>
    </div>
  );
}

function BatchRow({
  phase,
  index,
  amount,
}: {
  readonly phase: MotionValue<number>;
  readonly index: number;
  readonly amount: string;
}) {
  const start = 0.05 + index * 0.2;
  const scan = useTransform(phase, [0, start, start + 0.18, 1], [0, 0, 206, 206]);
  const scanOpacity = useTransform(
    phase,
    [0, start, start + 0.02, start + 0.16, start + 0.2, 1],
    [0, 0, 1, 1, 0, 0],
  );
  const done = useTransform(phase, [0, start + 0.18, start + 0.24, 0.87, 1], [0, 0, 1, 1, 0]);
  return (
    <div className="relative flex h-6 items-center overflow-hidden border-t border-[#eee] px-2.5">
      <span className="mr-2 text-[10px] text-[#aaa]">▤</span>
      <span className="font-mono text-[8px] text-[#888]">receipt-0{index + 1}.pdf</span>
      <motion.span className="ml-auto font-mono text-[8px] text-[#555]" style={{ opacity: done }}>
        {amount} ✓
      </motion.span>
      <motion.span
        className="absolute top-0 bottom-0 left-0 w-6 border-r border-[#aaa] bg-gradient-to-r from-transparent to-[#eeeeee]"
        style={{ x: scan, opacity: scanOpacity }}
      />
    </div>
  );
}

function BatchProcessing({ clock }: DemoProps) {
  const phase = usePhase(clock, 9);
  const count = useTransform(phase, (value) =>
    value < 0.24 ? 0 : value < 0.44 ? 1 : value < 0.64 ? 2 : value < 0.95 ? 3 : 0,
  );
  const countText = useTransform(count, (value) => `${value} / 3`);
  const opacity = useTransform(phase, [0, 0.02, 0.9, 1], [0, 1, 1, 0]);
  return (
    <div className="w-60 overflow-hidden rounded-[6px] border border-[#ddd] bg-white text-left">
      <div className="flex h-6 items-center justify-between px-2.5 text-[8px] text-[#777]">
        <span>Extract receipts</span>
        <motion.span className="font-mono text-[#aaa]" style={{ opacity }}>
          {countText}
        </motion.span>
      </div>
      <BatchRow phase={phase} index={0} amount="$24.00" />
      <BatchRow phase={phase} index={1} amount="$38.50" />
      <BatchRow phase={phase} index={2} amount="$12.80" />
    </div>
  );
}

function BranchPath({
  phase,
  start,
  d,
}: {
  readonly phase: MotionValue<number>;
  readonly start: number;
  readonly d: string;
}) {
  const pathLength = useTransform(phase, [0, start, start + 0.2, 1], [0, 0, 1, 1]);
  const opacity = useTransform(
    phase,
    [0, start, start + 0.03, start + 0.29, start + 0.37, 1],
    [0, 0, 1, 1, 0, 0],
  );
  return (
    <>
      <path d={d} stroke="#ddd" />
      <motion.path d={d} stroke="#444" strokeWidth="1.5" style={{ pathLength, opacity }} />
    </>
  );
}

function Branching({ clock }: DemoProps) {
  const phase = usePhase(clock, 11);
  const amount = useTransform(phase, (value): string => (value < 0.5 ? "$240" : "$48"));
  const amountOpacity = useTransform(
    phase,
    [0, 0.04, 0.43, 0.48, 0.52, 0.57, 0.93, 1],
    [0, 1, 1, 0, 0, 1, 1, 0],
  );
  const review = useTransform(
    phase,
    [0, 0.2, 0.28, 0.38, 0.46, 1],
    ["#ddd", "#ddd", "#555", "#555", "#ddd", "#ddd"],
  );
  const file = useTransform(
    phase,
    [0, 0.72, 0.8, 0.89, 0.97, 1],
    ["#ddd", "#ddd", "#555", "#555", "#ddd", "#ddd"],
  );
  return (
    <div className="relative h-24 w-65">
      <svg viewBox="0 0 260 96" className="absolute inset-0 size-full" fill="none">
        <path d="M64 48H112" stroke="#ddd" />
        <BranchPath phase={phase} start={0.05} d="M112 48H130Q144 48 144 30V21H184" />
        <BranchPath phase={phase} start={0.57} d="M112 48H130Q144 48 144 66V75H184" />
      </svg>
      <div className="absolute top-7 left-0 grid h-10 w-16 content-center gap-1 rounded-[5px] border border-[#ddd] bg-white text-center">
        <span className="font-mono text-[6px] text-[#aaa]">RECEIPT</span>
        <motion.span
          className="font-mono text-[13px] text-[#555]"
          style={{ opacity: amountOpacity }}
        >
          {amount}
        </motion.span>
      </div>
      <div className="absolute top-[37px] left-[101px] size-5.5 rotate-45 rounded-[3px] border border-[#bbb] bg-white" />
      <span className="absolute top-[40px] left-[101px] w-5.5 text-center font-mono text-[10px] text-[#777]">
        ?
      </span>
      <span className="absolute top-[65px] left-[87px] font-mono text-[7px] text-[#999]">
        over $100
      </span>
      <motion.div
        className="absolute top-2 left-46 grid h-6.5 w-18 place-items-center rounded-[5px] border border-[#ddd] bg-white text-[9px] text-[#666]"
        style={{ borderColor: review }}
      >
        Ask for review
      </motion.div>
      <motion.div
        className="absolute top-15.5 left-46 grid h-6.5 w-18 place-items-center rounded-[5px] border border-[#ddd] bg-white text-[9px] text-[#666]"
        style={{ borderColor: file }}
      >
        File expense
      </motion.div>
    </div>
  );
}

function ImagePipeline({ clock }: DemoProps) {
  const phase = usePhase(clock, 9);
  const inset = useTransform(phase, [0, 0.17, 0.4, 0.85, 0.94, 1], [0, 0, 9, 9, 0, 0]);
  const clipPath = useTransform(inset, (value) => `inset(${value}% ${value}%)`);
  const scale = useTransform(phase, [0, 0.17, 0.4, 0.85, 0.94, 1], [1, 1, 1.06, 1.06, 1, 1]);
  const guideOpacity = useTransform(phase, [0, 0.08, 0.17, 0.45, 0.54, 1], [0, 0, 1, 1, 0, 0]);
  const badgeOpacity = useTransform(phase, [0, 0.57, 0.65, 0.85, 0.94, 1], [0, 0, 1, 1, 0, 0]);
  const photoOpacity = useTransform(phase, [0, 0.06, 0.85, 0.9, 0.98, 1], [1, 1, 1, 0, 0, 1]);
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-22 w-36 overflow-hidden rounded-[5px] border border-[#ddd] bg-white">
        <motion.div className="absolute inset-0" style={{ clipPath, scale, opacity: photoOpacity }}>
          <svg viewBox="0 0 144 88" className="size-full" fill="none">
            <path fill="#f0f0ee" d="M0 0H144V88H0Z" />
            <circle cx="105" cy="24" r="9" fill="#c8c8c3" />
            <path d="M-5 88L48 26L98 88Z" fill="#a7aaa6" />
            <path d="M43 88L100 39L151 88Z" fill="#c2c4bf" />
            <path d="M32 45L48 26L64 46L50 40L43 44L39 40Z" fill="#e3e5df" />
          </svg>
        </motion.div>
        <motion.svg
          viewBox="0 0 144 88"
          className="absolute inset-0 size-full"
          fill="none"
          style={{ opacity: guideOpacity }}
        >
          <path
            d="M13 27V9H31M113 9H131V27M131 61V79H113M31 79H13V61"
            stroke="#555"
            strokeWidth="1.25"
          />
          <path d="M48 9V79M96 9V79M13 32H131M13 56H131" stroke="#777" strokeOpacity=".25" />
        </motion.svg>
      </div>
      <div className="flex h-20 flex-col justify-center gap-2.5">
        <span className="font-mono text-[8px] text-[#999]">Resize</span>
        <span className="font-mono text-[8px] text-[#999]">Compress</span>
        <motion.span
          className="rounded border border-[#ddd] bg-white px-2 py-1 font-mono text-[8px] text-[#555]"
          style={{ opacity: badgeOpacity }}
        >
          ✓ cover.webp
        </motion.span>
      </div>
    </div>
  );
}

function HandoffBubble({
  phase,
  index,
  logo,
  title,
  detail,
}: {
  readonly phase: MotionValue<number>;
  readonly index: number;
  readonly logo: string;
  readonly title: string;
  readonly detail: string;
}) {
  const start = 0.04 + index * 0.23;
  const opacity = useTransform(phase, [0, start, start + 0.12, 0.86, 1], [0.22, 0.22, 1, 1, 0.22]);
  const y = useTransform(phase, [0, start, start + 0.12, 0.86, 1], [4, 4, 0, 0, 4]);
  return (
    <motion.div
      className="absolute flex items-center gap-2"
      style={{ top: index * 31, left: index * 19, opacity, y }}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-full border border-[#e2e2e2] bg-white">
        <img src={logo} alt="" className="size-3.5 object-contain grayscale" />
      </span>
      <span className="flex h-7 w-43 items-center justify-between rounded-[5px] border border-[#ddd] bg-white px-2.5">
        <span className="text-[8px] text-[#666]">{title}</span>
        <span className="font-mono text-[7px] text-[#aaa]">{detail}</span>
      </span>
    </motion.div>
  );
}

function AppHandoff({ clock }: DemoProps) {
  const phase = usePhase(clock, 9.5);
  return (
    <div className="relative h-23 w-64">
      <svg viewBox="0 0 256 92" className="absolute inset-0 size-full" fill="none">
        <path d="M12 18V30H31V61H50V77" stroke="#ddd" />
      </svg>
      <HandoffBubble
        phase={phase}
        index={0}
        logo={githubLogo}
        title="Login button fails"
        detail="#42"
      />
      <HandoffBubble
        phase={phase}
        index={1}
        logo={linearLogo}
        title="Added to triage"
        detail="ENG-42"
      />
      <HandoffBubble
        phase={phase}
        index={2}
        logo={slackLogo}
        title="Team notified"
        detail="#build"
      />
    </div>
  );
}

function PageResult({
  phase,
  index,
}: {
  readonly phase: MotionValue<number>;
  readonly index: number;
}) {
  const start = 0.2 + index * 0.22;
  const opacity = useTransform(phase, [0, start, start + 0.08, 0.87, 1], [0.25, 0.25, 1, 1, 0.25]);
  const done = useTransform(phase, [0, start, start + 0.08, 0.87, 1], [0, 0, 1, 1, 0]);
  return (
    <motion.div
      className="flex h-5.5 items-center justify-between border-b border-[#eee] px-2.5 font-mono text-[8px] text-[#888]"
      style={{ opacity }}
    >
      <span>Page {index + 1}</span>
      <motion.span style={{ opacity: done }}>24 rows ✓</motion.span>
    </motion.div>
  );
}

function Pagination({ clock }: DemoProps) {
  const phase = usePhase(clock, 10);
  const rotate = useTransform(phase, [0, 0.06, 0.74, 1], [0, 0, 1080, 1080]);
  const page = useTransform(phase, (value): string =>
    value < 0.28 ? "1 / 3" : value < 0.5 ? "2 / 3" : "3 / 3",
  );
  const loopOpacity = useTransform(phase, [0, 0.05, 0.82, 0.91, 1], [0, 1, 1, 0, 0]);
  const complete = useTransform(phase, [0, 0.73, 0.8, 0.89, 1], [0, 0, 1, 1, 0]);
  return (
    <div className="flex items-center gap-6">
      <div className="flex flex-col items-center gap-2">
        <span className="font-mono text-[7px] text-[#aaa]">NEXT PAGE</span>
        <div className="relative grid size-14 place-items-center">
          <svg viewBox="0 0 56 56" className="absolute inset-0 size-full" fill="none">
            <circle cx="28" cy="28" r="23" stroke="#ddd" strokeDasharray="2 3" />
            <path d="M40 7L47 7L47 14" stroke="#aaa" strokeWidth="1.25" />
          </svg>
          <motion.svg
            viewBox="0 0 56 56"
            className="absolute inset-0 size-full"
            style={{ rotate, opacity: loopOpacity }}
          >
            <circle cx="28" cy="5" r="2.5" fill="#555" />
          </motion.svg>
          <motion.span
            className="font-mono text-[10px] text-[#888]"
            style={{ opacity: loopOpacity }}
          >
            {page}
          </motion.span>
        </div>
      </div>
      <div className="w-34 overflow-hidden rounded-[5px] border border-[#ddd] bg-white">
        <PageResult phase={phase} index={0} />
        <PageResult phase={phase} index={1} />
        <PageResult phase={phase} index={2} />
        <motion.div
          className="py-1.5 text-center font-mono text-[7px] text-[#777]"
          style={{ opacity: complete }}
        >
          ✓ 72 rows saved
        </motion.div>
      </div>
    </div>
  );
}

/** Nine distinct workflow illustrations share a continuous clock for local visual comparison. */
export function WorkflowDirections() {
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
      className="grid gap-x-7 gap-y-9 min-[760px]:grid-cols-2 min-[1120px]:grid-cols-3"
    >
      <Direction number="01" title="A chain reaction">
        <ChainReaction clock={clock} />
      </Direction>
      <Direction number="02" title="A trip, put together">
        <Itinerary clock={clock} />
      </Direction>
      <Direction number="03" title="Wait for your approval">
        <ApprovalGate clock={clock} />
      </Direction>
      <Direction number="04" title="Work through a batch">
        <BatchProcessing clock={clock} />
      </Direction>
      <Direction number="05" title="Pick up two days later">
        <TimeWorkflow clock={clock} />
      </Direction>
      <Direction number="06" title="Choose the next step">
        <Branching clock={clock} />
      </Direction>
      <Direction number="07" title="Turn an image into an asset">
        <ImagePipeline clock={clock} />
      </Direction>
      <Direction number="08" title="Pass work between apps">
        <AppHandoff clock={clock} />
      </Direction>
      <Direction number="09" title="Keep going until it’s done">
        <Pagination clock={clock} />
      </Direction>
    </div>
  );
}
