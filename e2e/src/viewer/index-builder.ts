// The matrix gallery: scenario rows × target columns, green/red/skipped cells
// linking into each run's player. This page is the five-second answer to
// "does the whole product work" — rebuilt after every scenario, served
// statically from runs/.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Cell {
  readonly ok?: boolean;
  readonly skipped?: boolean;
  readonly href?: string;
  readonly durationMs?: number;
  readonly endedAt?: number;
}

export const buildIndex = (runsDir: string): void => {
  const targets: string[] = [];
  // rows keyed by scenario name; cells keyed by target
  const rows = new Map<string, Map<string, Cell>>();

  for (const target of readdirSync(runsDir, { withFileTypes: true })) {
    if (!target.isDirectory()) continue;
    targets.push(target.name);
    for (const slug of readdirSync(join(runsDir, target.name), { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const dir = join(runsDir, target.name, slug.name);
      const href = `${target.name}/${slug.name}/player.html`;
      const runPath = join(dir, "run.json");
      if (existsSync(runPath)) {
        try {
          const run = JSON.parse(readFileSync(runPath, "utf8"));
          cellFor(rows, run.scenario, target.name, {
            ok: run.ok,
            href,
            durationMs: run.durationMs,
            endedAt: run.endedAt,
          });
          continue;
        } catch {
          // unreadable run — fall through to skip marker handling
        }
      }
      const skipPath = join(dir, "skipped.json");
      if (existsSync(skipPath)) {
        try {
          const skip = JSON.parse(readFileSync(skipPath, "utf8"));
          cellFor(rows, skip.scenario, target.name, { skipped: true });
        } catch {
          // ignore
        }
      }
    }
  }

  targets.sort();
  const scenarios = [...rows.keys()].sort();
  const esc = (s: string) =>
    s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

  const cellHtml = (cell: Cell | undefined): string => {
    if (!cell) return `<td class=miss>·</td>`;
    if (cell.skipped) return `<td class=skip title="capability not on this target">—</td>`;
    const mark = cell.ok ? "✓" : "✗";
    const cls = cell.ok ? "ok" : "no";
    const meta =
      cell.durationMs != null
        ? ` <span class=d>${(cell.durationMs / 1000).toFixed(1)}s</span>`
        : "";
    return `<td class=${cls}><a href="${cell.href}">${mark}${meta}</a></td>`;
  };

  const html = `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>e2e runs</title><style>
  body{font:15px/1.5 ui-sans-serif,system-ui;max-width:880px;margin:0 auto;padding:24px;color:#d7dce5;background:#0b0f17}
  h1{font-size:17px;color:#8b98a9}
  table{border-collapse:collapse;width:100%;margin-top:1rem}
  th,td{padding:.45rem .7rem;border-bottom:1px solid #161b22;text-align:left;font-size:14px}
  th{color:#6b7785;font-weight:600}
  td.ok a{color:#7ee787;font-weight:700}td.no a{color:#ff7b72;font-weight:700}
  td.skip{color:#3d4651}td.miss{color:#262d36}
  td a{text-decoration:none}
  .d{color:#6b7785;font-weight:400;font-size:12px}
  .stamp{color:#3d4651;font-size:12px;margin-top:1.2rem}
  </style>
  <h1>Executor e2e — scenario × target</h1>
  <table><tr><th>scenario</th>${targets.map((t) => `<th>${esc(t)}</th>`).join("")}</tr>
  ${scenarios
    .map(
      (s) =>
        `<tr><td>${esc(s)}</td>${targets.map((t) => cellHtml(rows.get(s)?.get(t))).join("")}</tr>`,
    )
    .join("\n")}
  </table>
  <div class=stamp>generated ${new Date().toISOString()} · ✓/✗ link to the run's player · — = capability not on that target</div>`;

  writeFileSync(join(runsDir, "index.html"), html);
};

const cellFor = (
  rows: Map<string, Map<string, Cell>>,
  scenario: string,
  target: string,
  cell: Cell,
): void => {
  let row = rows.get(scenario);
  if (!row) rows.set(scenario, (row = new Map()));
  const existing = row.get(target);
  // newest run wins; a real run beats a skip marker
  if (!existing || existing.skipped || (cell.endedAt ?? 0) >= (existing.endedAt ?? 0)) {
    row.set(target, cell);
  }
};
