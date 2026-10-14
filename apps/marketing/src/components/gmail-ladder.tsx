import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { gmailLadder } from "../content/site-copy";
import { cn } from "../lib/utils";
import gmailLogo from "../assets/logos/gmail.svg?url";

const STEP_MS = 6000;

// Example data only. Names and addresses are placeholders.
function ToolsPreview() {
  const tools = [
    ["search_threads", "query, limit"],
    ["read_thread", "id"],
    ["add_label", "id, label"],
    ["send", "to, subject, body"],
  ];
  return (
    <div className="grid gap-px overflow-hidden rounded-[8px] border border-tone-91 bg-tone-91">
      {tools.map(([name, args]) => (
        <div key={name} className="truncate bg-tone-100 px-4 py-2.5 font-mono text-[12px]">
          <span className="text-tone-60">gmail.</span>
          <span className="text-tone-20">{name}</span>
          <span className="text-tone-67">({args})</span>
        </div>
      ))}
    </div>
  );
}

function UndoPreview() {
  return (
    <div className="grid gap-3">
      <div className="rounded-[8px] border border-tone-91 bg-tone-100 p-4">
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-tone-40">To: sam@example.com</span>
          <span className="font-mono text-tone-60">4:12</span>
        </div>
        <p className="mt-1.5 text-[13.5px] font-medium text-tone-20">Q3 numbers, final</p>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-tone-93">
          <motion.div
            className="h-full rounded-full bg-sage"
            initial={{ width: "100%" }}
            animate={{ width: "82%" }}
            transition={{ duration: STEP_MS / 1000, ease: "linear" }}
          />
        </div>
        <div className="mt-3 flex items-center justify-between text-[11.5px]">
          <span className="text-tone-60">Sends at 10:07</span>
          <span className="rounded-[5px] border border-tone-87 px-2 py-0.5 font-medium text-tone-27">
            Cancel send
          </span>
        </div>
      </div>
      <p className="font-mono text-[11.5px] text-tone-60">
        send → wait 5m → deliver <span className="text-tone-73">· durable workflow</span>
      </p>
    </div>
  );
}

function NotesPreview() {
  const rows = [
    ["Invoice #2041", "Pay by Friday"],
    ["Intro: Priya ↔ Sam", "Follow up next week"],
    ["Offsite venue", "Prefers the second option"],
  ];
  return (
    <div className="overflow-hidden rounded-[8px] border border-tone-91 bg-tone-100">
      <div className="grid grid-cols-[1fr_1.2fr] border-b border-tone-93 bg-tone-98 px-4 py-2 font-mono text-[10.5px] text-tone-60">
        <span>thread</span>
        <span>note</span>
      </div>
      {rows.map(([thread, note]) => (
        <div
          key={thread}
          className="grid grid-cols-[1fr_1.2fr] gap-3 border-b border-tone-94 px-4 py-2.5 text-[12px] last:border-b-0"
        >
          <span className="truncate text-tone-33">{thread}</span>
          <span className="truncate text-tone-53">{note}</span>
        </div>
      ))}
      <div className="border-t border-tone-93 px-4 py-2 font-mono text-[10.5px] text-tone-67">
        notes.sqlite · 3 rows
      </div>
    </div>
  );
}

function WebhookPreview() {
  const events = [
    ["09:14", "news@weekly.example", "Archived"],
    ["09:20", "digest@launches.example", "Archived"],
    ["09:31", "sam@example.com", "Kept"],
    ["09:46", "hello@letters.example", "Archived"],
  ];
  return (
    <div className="overflow-hidden rounded-[8px] border border-tone-91 bg-tone-100">
      <div className="flex items-center gap-2 border-b border-tone-93 px-4 py-2 font-mono text-[10.5px] text-tone-60">
        <span className="size-1.5 rounded-full bg-sage" />
        POST /webhooks/gmail
      </div>
      {events.map(([time, from, action], i) => (
        <motion.div
          key={time}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 + i * 0.35 }}
          className="grid grid-cols-[auto_1fr_auto] gap-3 border-b border-tone-94 px-4 py-2.5 text-[12px] last:border-b-0"
        >
          <span className="font-mono text-tone-67">{time}</span>
          <span className="truncate text-tone-33">{from}</span>
          <span className={action === "Kept" ? "text-tone-60" : "text-sage-text"}>{action}</span>
        </motion.div>
      ))}
    </div>
  );
}

function InboxPreview() {
  const rows = [
    ["Sam Lee", "Q3 numbers, final", "10:02", true],
    ["Priya", "Intro: Priya ↔ Sam", "9:41", false],
    ["Billing", "Invoice #2041", "Yesterday", false],
  ] as const;
  return (
    <div className="overflow-hidden rounded-[8px] border border-tone-91 bg-tone-100">
      <div className="flex items-center justify-between border-b border-tone-93 px-4 py-2">
        <span className="text-[12px] font-medium text-tone-20">Inbox</span>
        <span className="font-mono text-[10.5px] text-tone-67">3 unread</span>
      </div>
      {rows.map(([from, subject, time, active]) => (
        <div
          key={subject}
          className={cn(
            "relative grid grid-cols-[5.5rem_1fr_auto] gap-3 border-b border-tone-94 px-4 py-2.5 text-[12px] last:border-b-0",
            active && "bg-tone-97",
          )}
        >
          {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-ink" />}
          <span className="truncate font-medium text-tone-20">{from}</span>
          <span className="truncate text-tone-47">{subject}</span>
          <span className="text-tone-67">{time}</span>
        </div>
      ))}
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-tone-93 px-4 py-2 font-mono text-[10.5px] text-tone-60">
        {[
          ["J/K", "move"],
          ["E", "archive"],
          ["N", "note"],
          ["Z", "undo send"],
        ].map(([key, label]) => (
          <span key={key}>
            <kbd className="rounded-[3px] border border-tone-87 px-1 text-tone-33">{key}</kbd>{" "}
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

const previews: ReadonlyArray<() => ReactNode> = [
  ToolsPreview,
  UndoPreview,
  NotesPreview,
  WebhookPreview,
  InboxPreview,
];

export function GmailLadder() {
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root, { amount: 0.4 });
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!inView || pinned || reduced) return;
    const timer = setTimeout(() => setStep((s) => (s + 1) % gmailLadder.length), STEP_MS);
    return () => clearTimeout(timer);
  }, [inView, pinned, reduced, step]);

  const current = gmailLadder[step]!;
  const Preview = previews[step]!;

  return (
    <div
      ref={root}
      className="@container mt-7 max-w-225 overflow-hidden rounded-[10px] border border-tone-90 bg-tone-98"
    >
      <div
        role="tablist"
        aria-label="Gmail app, step by step"
        className="grid grid-cols-5 border-b border-tone-90 bg-tone-100"
      >
        {gmailLadder.map((item, i) => (
          <button
            key={item.title}
            role="tab"
            type="button"
            aria-selected={i === step}
            onClick={() => {
              setStep(i);
              setPinned(true);
            }}
            className={cn(
              "relative flex cursor-pointer flex-col items-start gap-0.5 border-r border-tone-93 px-3 py-3 text-left last:border-r-0 @min-[640px]:px-4",
              i === step ? "text-ink" : "text-tone-60 hover:text-tone-33",
            )}
          >
            <span className="text-[12.5px] font-medium">{item.title}</span>
            <span
              className={cn(
                "absolute inset-x-0 bottom-0 h-0.5 origin-left bg-ink",
                i === step ? "opacity-100" : "opacity-0",
              )}
            />
            {i === step && inView && !pinned && !reduced && (
              <motion.span
                key={`progress-${step}`}
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-tone-73"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: STEP_MS / 1000, ease: "linear" }}
              />
            )}
          </button>
        ))}
      </div>

      <div className="grid gap-6 p-5 @min-[640px]:grid-cols-[1fr_1.1fr] @min-[640px]:gap-9 @min-[640px]:p-8">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
            className="flex flex-col"
          >
            <blockquote className="max-w-[30ch] text-[18px] leading-[1.55] tracking-[-0.02em] text-tone-20">
              “{current.prompt}”
            </blockquote>
            <p className="mt-4 max-w-[38ch] text-[13px] leading-relaxed text-tone-47">
              {current.result}
            </p>

            <div className="mt-auto pt-6">
              <div className="flex flex-wrap items-center gap-1.5">
                <img
                  src={gmailLogo}
                  alt=""
                  width="16"
                  height="16"
                  className="mr-1 size-4 object-contain"
                />
                {gmailLadder.map((item, i) => (
                  <span
                    key={item.piece}
                    className={cn(
                      "rounded-[5px] border px-2 py-0.5 font-mono text-[11px] transition-colors duration-300",
                      i < step && "border-tone-87 bg-tone-100 text-tone-40",
                      i === step && "border-sage-bar-strong bg-sage-wash text-sage-text",
                      i > step && "border-dashed border-tone-89 text-tone-77",
                    )}
                  >
                    {i === step ? "+ " : ""}
                    {item.piece}
                  </span>
                ))}
              </div>
            </div>
          </motion.div>
        </AnimatePresence>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="min-h-[13.5rem] self-center"
          >
            <Preview />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
