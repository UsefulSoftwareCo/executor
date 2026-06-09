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
    const mark = cell.ok ? "✓ passed" : "✗ FAILED";
    const cls = cell.ok ? "ok" : "no";
    const meta =
      cell.durationMs != null
        ? ` <span class=d>${(cell.durationMs / 1000).toFixed(1)}s</span>`
        : "";
    return `<td class=${cls}><a class=watch href="${cell.href}">${mark}${meta} <span class=play>▶ watch</span></a></td>`;
  };

  // A scenario row's name links to its most recent run, so the whole row is
  // an affordance — not just the result marks.
  const rowHref = (s: string): string | undefined => {
    const cells = [...(rows.get(s)?.values() ?? [])].filter((c) => c.href);
    cells.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return cells[0]?.href;
  };

  const html = `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>e2e runs</title>
  <script>if(!location.pathname.endsWith("/")&&!location.pathname.endsWith(".html"))location.replace(location.pathname+"/"+location.search)</script>
  <style>
  body{font:15px/1.5 ui-sans-serif,system-ui;max-width:920px;margin:0 auto;padding:24px;color:#d7dce5;background:#0b0f17}
  h1{font-size:17px;color:#d7dce5;margin-bottom:2px}
  .hint{color:#6b7785;font-size:13px}
  table{border-collapse:collapse;width:100%;margin-top:1rem}
  th,td{padding:.5rem .7rem;border-bottom:1px solid #161b22;text-align:left;font-size:14px}
  th{color:#6b7785;font-weight:600}
  td a{text-decoration:none}
  td.ok a{color:#7ee787;font-weight:600}td.no a{color:#ff7b72;font-weight:700}
  td.skip{color:#3d4651}td.miss{color:#262d36}
  a.watch{display:inline-block;padding:.2rem .55rem;border:1px solid #21262d;border-radius:7px;background:#0f1620;white-space:nowrap}
  a.watch:hover{border-color:#388bfd;background:#101a2a}
  a.watch .play{color:#58a6ff;font-weight:400;font-size:12px}
  a.scn{color:#d7dce5;text-decoration:none}
  a.scn:hover{color:#58a6ff}
  .d{color:#6b7785;font-weight:400;font-size:12px}
  .stamp{color:#3d4651;font-size:12px;margin-top:1.2rem}
  </style>
  <h1>Executor e2e — every scenario, on every deployment</h1>
  <div class=hint>Rows are scenarios, columns are deployments. <b>Click any result to watch that run replay</b> — the steps, screenshots, video and assertions. Add <code>?instant</code> to a run URL to skip the animation. “—” = capability not on that target.</div>
  <table><tr><th>scenario</th>${targets.map((t) => `<th>${esc(t)}</th>`).join("")}</tr>
  ${scenarios
    .map((s) => {
      const href = rowHref(s);
      const name = href ? `<a class=scn href="${href}">${esc(s)}</a>` : esc(s);
      return `<tr><td>${name}</td>${targets.map((t) => cellHtml(rows.get(s)?.get(t))).join("")}</tr>`;
    })
    .join("\n")}
  </table>
  <div class=stamp>generated ${new Date().toISOString()}</div>`;

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
