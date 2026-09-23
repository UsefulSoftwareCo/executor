import { useState } from "react";
import { homepageStory } from "../content/site-copy";

const reports = [
  {
    day: "Monday",
    date: "Latest report",
    signups: "1,284",
    change: "+12%",
    openIssues: 26,
    fewerIssues: 4,
    headline: "A strong start to the week.",
    summary:
      "Signups are up 12%, and there are four fewer open issues. Organic search brought in the most new users.",
    bars: [32, 41, 38, 54, 63, 59, 82],
  },
  {
    day: "Friday",
    date: "Previous report",
    signups: "1,145",
    change: "+8%",
    openIssues: 30,
    fewerIssues: 4,
    headline: "More visitors are signing up.",
    summary:
      "Signups grew 8%. Four issues were resolved, including the onboarding fix. The new page is converting more visitors.",
    bars: [28, 37, 35, 48, 57, 52, 68],
  },
  {
    day: "Thursday",
    date: "Earlier report",
    signups: "1,060",
    change: "+4%",
    openIssues: 34,
    fewerIssues: 2,
    headline: "Steady growth, no surprises.",
    summary:
      "Signups rose 4%, and two issues were resolved. Traffic and activation stayed close to their usual levels.",
    bars: [29, 34, 36, 42, 47, 49, 56],
  },
] as const;

/** Illustrative scheduled reports; selecting a day shows how an app keeps its results. */
export function DailyBriefDemo() {
  const [report, setReport] = useState<(typeof reports)[number]>(reports[0]);

  return (
    <figure className="doc__fig--wide @container mt-7 max-w-225">
      <div className="mb-5 flex items-start gap-3 text-[14px] leading-[1.7] text-[#555]">
        <span className="mt-1 shrink-0 font-mono text-[10px] text-[#aaa]">You</span>
        <p className="max-w-[60ch]">“{homepageStory.automate.prompt}”</p>
      </div>
      <div className="overflow-hidden rounded-[10px] border border-[#e3e3e3] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e8e8e8] bg-[#fafafa] px-5 py-4 @min-[620px]:px-6">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid size-7 place-items-center rounded-[6px] bg-[#eef0ec] font-mono text-[15px] text-[#7d8978]"
            >
              ↗
            </span>
            <span className="text-[13px] font-medium text-[#333]">Daily brief</span>
            <span className="text-[11px] text-[#aaa]">Your app</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-[#888]">
            <span className="size-1.5 rounded-full bg-[#78917f]" aria-hidden="true" />
            Weekdays at 09:00
          </div>
        </div>
        <div className="grid @min-[620px]:grid-cols-[150px_minmax(0,1fr)]">
          <nav
            aria-label="Example saved reports"
            className="border-b border-[#ededed] px-3 py-4 @min-[620px]:border-r @min-[620px]:border-b-0 @min-[620px]:py-6"
          >
            <p className="mb-2 px-3 text-[11px] text-[#aaa]">Saved reports</p>
            <div className="flex gap-1 @min-[620px]:flex-col">
              {reports.map((item) => (
                <button
                  key={item.day}
                  type="button"
                  aria-pressed={item.day === report.day}
                  onClick={() => setReport(item)}
                  className="flex flex-1 cursor-pointer items-center gap-2 rounded-[5px] px-3 py-2.5 text-left text-[12px] text-[#999] hover:bg-[#f7f7f7] hover:text-[#444] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#888] aria-pressed:bg-[#f0f0ee] aria-pressed:text-[#333] @min-[620px]:flex-none"
                >
                  <svg
                    aria-hidden="true"
                    className="hidden size-3 shrink-0 @min-[620px]:block"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.1"
                  >
                    <path d="M4 2h5l3 3v9H4V2Zm5 0v3h3M6 8h4M6 10h4" />
                  </svg>
                  {item.day}
                </button>
              ))}
            </div>
          </nav>
          <div
            className="min-w-0 p-5 @min-[620px]:px-8 @min-[620px]:py-7"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="flex items-center justify-between gap-4 text-[11px] text-[#aaa]">
              <span>{report.day} · 09:01</span>
              <span>{report.date}</span>
            </div>
            <h3 className="mt-5 text-[21px] font-medium leading-[1.3] tracking-[-0.035em] text-[#333]">
              {report.headline}
            </h3>
            <div className="mt-7 grid grid-cols-[110px_1fr] items-end gap-7 @min-[620px]:grid-cols-[135px_1fr]">
              <div>
                <p className="text-[11px] text-[#999]">New signups</p>
                <p className="mt-1 font-mono text-[30px] tracking-[-0.06em] text-[#333] @min-[620px]:text-[34px]">
                  {report.signups}
                </p>
                <p className="mt-1 text-[11px] text-[#6f8978]">{report.change} from last report</p>
              </div>
              <div
                aria-hidden="true"
                className="flex h-22 items-end gap-2 border-b border-[#e5e5e5]"
              >
                {report.bars.map((height, index) => (
                  <div
                    key={index}
                    className="flex-1 rounded-t-[2px] bg-[#deded9] last:bg-[#818d80]"
                    style={{ height: `${height}%` }}
                  />
                ))}
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
              <span className="text-[#999]">Open issues</span>
              <span className="font-mono text-[16px] text-[#555]">{report.openIssues}</span>
              <span className="text-[11px] text-[#6f8978]">
                {report.fewerIssues} fewer than last time
              </span>
            </div>
            <p className="mt-6 max-w-[54ch] text-[13px] leading-[1.75] text-[#888]">
              {report.summary}
            </p>
            <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 border-t border-[#efefef] pt-4 text-[10px] text-[#aaa]">
              <span>✓ Read PostHog + GitHub</span>
              <span>✓ Write brief</span>
              <span>✓ Save report</span>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-3.5 flex flex-wrap justify-between gap-2 text-[12px] leading-relaxed text-[#999]">
        <span>Your app keeps running. Your data stays with it.</span>
        <span>Example data</span>
      </figcaption>
    </figure>
  );
}
