import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Warnings shown before the list is opened. */
const PREVIEW_COUNT = 3;
const ROW_HEIGHT = 22;
/** The opened list's height in rows; it scrolls past that. */
const OPEN_ROWS = 12;

/**
 * A trace's warnings: the first few, cut to one line, how many there are, and all of them on
 * request. A trace can have tens of thousands (one per missing parent), so the opened list renders
 * only the rows in view, and its fixed height keeps the waterfall on the page.
 */
export function TraceWarnings({ warnings }: { warnings: ReadonlyArray<string> }) {
  const [open, setOpen] = useState(false);
  const count = warnings.length;
  const more = count > PREVIEW_COUNT;

  return (
    <section aria-label="Trace warnings" className="text-sm">
      <div className="flex items-center gap-3">
        <p className="text-zinc-500 font-medium">
          {count.toLocaleString()} warning{count === 1 ? "" : "s"}
        </p>
        {more && (
          <button
            type="button"
            className="text-sm px-2 py-0.5 rounded-md border border-white/10 text-zinc-400 hover:text-zinc-200 hover:border-white/20 bg-transparent cursor-pointer"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Show fewer" : `Show all ${count.toLocaleString()}`}
          </button>
        )}
      </div>
      {open ? (
        <WarningList warnings={warnings} />
      ) : (
        <ul className="mt-1">
          {warnings.slice(0, PREVIEW_COUNT).map((warning, index) => (
            // Warnings can repeat, so their position is their key.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={index} className="text-amber-400 truncate" title={warning}>
              {warning}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Every warning, one line each. The rows are in normal flow between two spacers, so the list is
 * as wide as its longest row in view and scrolls sideways to it; the list takes keyboard focus,
 * so the arrow keys scroll it both ways.
 */
function WarningList({ warnings }: { warnings: ReadonlyArray<string> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line react/incompatible-library -- this build does not run the React Compiler
  const virtualizer = useVirtualizer({
    count: warnings.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  const rows = virtualizer.getVirtualItems();
  const before = rows[0]?.start ?? 0;
  const after = virtualizer.getTotalSize() - (rows[rows.length - 1]?.end ?? 0);

  return (
    <div
      ref={scrollRef}
      // Focusable so that keyboard users can scroll a long warning into view.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="region"
      aria-label="All trace warnings"
      className="mt-1 overflow-auto rounded-md border border-white/5 outline-none focus-visible:border-white/30"
      style={{ maxHeight: OPEN_ROWS * ROW_HEIGHT }}
    >
      <ul className="w-max min-w-full" style={{ paddingTop: before, paddingBottom: after }}>
        {rows.map((row) => (
          <li
            key={row.index}
            className="px-2 text-amber-400 whitespace-nowrap"
            style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
          >
            {warnings[row.index]}
          </li>
        ))}
      </ul>
    </div>
  );
}
