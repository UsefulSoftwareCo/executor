import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { EvidenceReport } from "../report-model.ts";
import { RecordingPlayer } from "./recording-player.tsx";
import { StateStoryboard } from "./state-storyboard.tsx";
import "./.local/storyboard.css";

const container = document.getElementById("root");
const payload = document.getElementById("evidence-data");
if (!container || !payload?.textContent) throw new Error("Evidence report data is missing");
const report = Schema.decodeUnknownSync(EvidenceReport)(JSON.parse(payload.textContent));
type Entry = EvidenceReport["entries"][number];
const targetNames = { "self-host": "Self-host", local: "Local", cloud: "Cloud" };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const selectedId = () => new URLSearchParams(location.hash.slice(1)).get("test");
// A scenario is authored once; target runs retain their own IDs, media and outcomes.
type TestGroup = { key: string; title: string; file: string; entries: Entry[] };
const groupKey = (entry: Entry) => JSON.stringify([entry.file, entry.title]);
const grouped = new Map<string, TestGroup>();
for (const entry of report.entries) {
  const key = groupKey(entry);
  const group = grouped.get(key);
  if (group) group.entries.push(entry);
  else grouped.set(key, { key, title: entry.title, file: entry.file, entries: [entry] });
}
const groups = [...grouped.values()];
const failed = (entry: Entry) => entry.status !== "passed" && entry.status !== "skipped";

const RequestRows = Schema.Array(
  Schema.Struct({
    method: Schema.String,
    path: Schema.String,
    status: Schema.Number,
    durationMs: Schema.Number,
  }),
);

function Evidence({ entry, diagnostics }: { entry: Entry; diagnostics: string }) {
  const videos = entry.attachments.filter((item) => item.contentType.startsWith("video/"));
  const screenshots = entry.attachments.filter((item) => item.contentType.startsWith("image/"));
  const [requests, setRequests] = useState<typeof RequestRows.Type | null>(null);
  const [loadError, setLoadError] = useState(false);
  const requestFile = entry.attachments.find((item) => item.name === "requests.json");
  useEffect(() => {
    if (videos.length || !requestFile) return;
    const load = Effect.scoped(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(new URL(requestFile.href, location.href));
        if (response.status !== 200)
          return yield* Effect.fail(new Error("Request evidence unavailable"));
        return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(RequestRows)));
      }),
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.match({
        onFailure: () => setLoadError(true),
        onSuccess: setRequests,
      }),
    );
    // React owns this Effect fiber; unmount interrupts its HTTP scope.
    return Effect.runCallback(load);
  }, [requestFile, videos.length]);
  const video = videos[0];
  const filmstrip = entry.attachments.find((item) => item.name === "Recording filmstrip");
  const states = entry.attachments.find((item) => item.name === "Observed UI states");
  const [showRecording, setShowRecording] = useState(false);
  return (
    <>
      {entry.annotations.some((item) => item.type === "manual intervention") && (
        <p className="notice">Manual intervention recorded. This is not an unattended pass.</p>
      )}
      {states && (
        <div className="mb-3 flex gap-2">
          <button
            type="button"
            className="rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs aria-pressed:bg-[var(--selected)]"
            aria-pressed={!showRecording}
            onClick={() => setShowRecording(false)}
          >
            Storyboard
          </button>
          <button
            type="button"
            className="rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs aria-pressed:bg-[var(--selected)]"
            aria-pressed={showRecording}
            onClick={() => setShowRecording(true)}
          >
            Recording
          </button>
        </div>
      )}
      <section className="evidence" aria-label="Primary test evidence">
        {states && !showRecording ? (
          <StateStoryboard
            key={states.href}
            href={states.href}
            journey={entry.id}
            journeys={report.entries
              .filter((item) =>
                item.attachments.some((attachment) => attachment.name === "Observed UI states"),
              )
              .map((item) => ({ id: item.id, title: item.title }))}
          />
        ) : video ? (
          <>
            <RecordingPlayer
              key={video.href}
              poster={
                screenshots.find((item) => item.name === "Recording poster")?.href ??
                screenshots[0]?.href
              }
              src={video.href}
              filmstrip={filmstrip?.href}
            />
            <div className="caption">
              <span>
                {video.name}
                {video.name === "Test recording" ? " · idle time trimmed" : ""}
              </span>
              <a href={video.href}>Open recording ↗</a>
            </div>
          </>
        ) : screenshots[0] ? (
          <img src={screenshots[0].href} alt={screenshots[0].name} />
        ) : (
          <div className="request-evidence">
            <h2>Request evidence</h2>
            {entry.errors[0] && <pre className="error">{entry.errors[0]}</pre>}
            {loadError ? (
              <p>Request evidence could not be loaded.</p>
            ) : requests ? (
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Request</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((row, i) => (
                    <tr key={i}>
                      <td>{row.method}</td>
                      <td>{row.path}</td>
                      <td>{row.status}</td>
                      <td>{Math.round(row.durationMs)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>{requestFile ? "Loading requests…" : "No request attachment was saved."}</p>
            )}
          </div>
        )}
      </section>
      <section className="support">
        <h2>Supporting evidence</h2>
        <div className="links">
          <a href={diagnostics}>Vitest diagnostics ↗</a>
          {entry.attachments
            .filter((item) => item !== video && !item.contentType.startsWith("image/"))
            .map((item) => (
              <a key={item.href} href={item.href}>
                {item.name}
              </a>
            ))}
        </div>
      </section>
      {videos.length > 0 && entry.errors.length > 0 && (
        <details>
          <summary>Failure details</summary>
          <pre>{entry.errors.join("\n\n")}</pre>
        </details>
      )}
    </>
  );
}
function App() {
  const [selected, setSelected] = useState(selectedId);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [target, setTarget] = useState("all");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const changed = () => setSelected(selectedId());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const matches = (entry: Entry) =>
    (status === "all" || entry.status === status) && (target === "all" || entry.target === target);
  const filtered = useMemo(
    () =>
      groups.filter(
        (group) =>
          `${group.title} ${group.file}`.toLowerCase().includes(query.toLowerCase()) &&
          group.entries.some(
            (entry) =>
              (status === "all" || entry.status === status) &&
              (target === "all" || entry.target === target),
          ),
      ),
    [query, status, target],
  );
  const firstResult = (group: TestGroup) => {
    const matching = group.entries.filter(matches);
    const entry = matching.find(failed) ?? matching[0];
    if (!entry) throw new Error("Visible test has no matching target result");
    return entry;
  };
  const active = report.entries.find((entry) => entry.id === selected);
  const activeGroup = active ? grouped.get(groupKey(active)) : undefined;
  const activeRun = report.runs.find((run) => run.target === active?.target);
  if (active && !activeRun) throw new Error("Test target metadata is missing");
  const visible = filtered.slice(page * 50, (page + 1) * 50);
  const filter = (
    <div className="filters">
      <input
        aria-label="Search tests"
        placeholder="Search tests or files…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setPage(0);
        }}
      />
      <select
        aria-label="Filter by status"
        value={status}
        onChange={(event) => {
          setStatus(event.target.value);
          setPage(0);
        }}
      >
        <option value="all">All results</option>
        {[...new Set(report.entries.map((entry) => entry.status))].map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by target"
        value={target}
        onChange={(event) => {
          setTarget(event.target.value);
          setPage(0);
        }}
      >
        <option value="all">All targets</option>
        {[...new Set(report.entries.map((entry) => entry.target))].map((value) => (
          <option key={value} value={value}>
            {targetNames[value]}
          </option>
        ))}
      </select>
    </div>
  );
  const paging = (
    <div className="paging">
      <span>
        {filtered.length === 0
          ? "No matches"
          : `${page * 50 + 1}–${Math.min((page + 1) * 50, filtered.length)} of ${filtered.length}`}
      </span>
      <div>
        <button disabled={page === 0} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <button disabled={(page + 1) * 50 >= filtered.length} onClick={() => setPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
  return (
    <>
      <header>
        <a className="brand" href="#">
          Executor <span>/ Test evidence</span>
        </a>
        <div className="diagnostics-links">
          {report.runs.map((run) => (
            <a key={run.target} href={run.diagnostics}>
              {targetNames[run.target]} diagnostics ↗
            </a>
          ))}
        </div>
      </header>
      {activeRun ? (
        <div className="run">
          <span className="target">{targetNames[activeRun.target]}</span>
          <span>{activeRun.mode === "managed" ? "Started for this run" : "Attached server"}</span>
          <code>{activeRun.origin}</code>
          <span>{activeRun.runtime}</span>
          <span className="revision">
            Test code {activeRun.commit.slice(0, 7)}
            {activeRun.dirty ? " + edits" : ""}
          </span>
        </div>
      ) : (
        <div className="run-matrix">
          {report.runs.map((run) => {
            const results = report.entries.filter((entry) => entry.target === run.target);
            const failed = results.filter(
              (entry) => entry.status !== "passed" && entry.status !== "skipped",
            ).length;
            return (
              <button
                key={run.target}
                className="target-summary"
                onClick={() => {
                  setTarget(run.target);
                  setPage(0);
                }}
              >
                <strong>{targetNames[run.target]}</strong>
                <span className={failed ? "failed" : ""}>
                  {results.filter((entry) => entry.status === "passed").length} passed · {failed}{" "}
                  failed
                </span>
                <code>{run.origin}</code>
                <small>
                  {run.mode === "managed" ? "Started for this run" : "Attached server"} ·{" "}
                  {run.runtime}
                </small>
              </button>
            );
          })}
        </div>
      )}
      <div className={active ? "layout detail" : "layout"}>
        {active ? (
          <aside>
            <a className="back" href="#">
              ← All {groups.length} tests
            </a>
            {filter}
            <nav aria-label="Tests">
              {visible.map((group) => (
                <a
                  className="test-row"
                  aria-current={group.key === activeGroup?.key ? "page" : undefined}
                  key={group.key}
                  href={`#test=${encodeURIComponent(firstResult(group).id)}`}
                >
                  <span>{group.title}</span>
                  <small className="group-targets">
                    {group.entries.map((entry) => (
                      <span key={entry.id} className={failed(entry) ? "failed" : ""}>
                        {targetNames[entry.target]} · {entry.status}
                      </span>
                    ))}
                  </small>
                </a>
              ))}
            </nav>
            {paging}
          </aside>
        ) : (
          <section className="test-list">
            <div className="list-heading">
              <div>
                <h1>Tests</h1>
                <p>
                  {groups.length} tests · {report.entries.length} runs ·{" "}
                  {report.entries.filter(failed).length} failed
                </p>
              </div>
              <span>
                {report.runs.length} {report.runs.length === 1 ? "target" : "targets"}
              </span>
            </div>
            {filter}
            <table className="grouped-tests">
              <thead>
                <tr>
                  <th>Test</th>
                  {report.runs.map((run) => (
                    <th key={run.target}>{targetNames[run.target]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((group) => (
                  <tr key={group.key}>
                    <td>
                      <a href={`#test=${encodeURIComponent(firstResult(group).id)}`}>
                        {group.title}
                      </a>
                      <small>{group.file}</small>
                    </td>
                    {report.runs.map((run) => {
                      const entry = group.entries.find((entry) => entry.target === run.target);
                      const planned = report.plan.find(
                        (test) => test.file === group.file && test.title === group.title,
                      )?.targets[run.target];
                      const notApplicable = planned?.status === "not-applicable";
                      const reason =
                        planned && planned.status !== "scheduled"
                          ? planned.reason
                          : "No result was recorded for this target.";
                      return (
                        <td key={run.target}>
                          {entry ? (
                            <a
                              className={`target-result ${failed(entry) ? "failed" : ""}`}
                              href={`#test=${encodeURIComponent(entry.id)}`}
                              aria-label={`${targetNames[entry.target]}: ${entry.status}, ${seconds(entry.duration)}`}
                            >
                              <span>{entry.status}</span>
                              <small>{seconds(entry.duration)}</small>
                            </a>
                          ) : (
                            <span
                              className={notApplicable ? "not-applicable" : "not-run"}
                              title={reason}
                              aria-label={`${notApplicable ? "N/A" : "Not run"}: ${reason}`}
                            >
                              {notApplicable ? "N/A" : "Not run"}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {paging}
          </section>
        )}
        {active && activeRun && (
          <main>
            <div className="test-heading">
              <div>
                <small>
                  {targetNames[active.target]} / {active.file}
                </small>
                <h1>{active.title}</h1>
              </div>
              <span className={`status ${active.status === "failed" ? "failed" : ""}`}>
                {active.status} · {seconds(active.duration)}
              </span>
            </div>
            {activeGroup && activeGroup.entries.length > 1 && (
              <nav className="target-results" aria-label="Target results">
                {activeGroup.entries.map((entry) => (
                  <a
                    key={entry.id}
                    href={`#test=${encodeURIComponent(entry.id)}`}
                    aria-current={entry.id === active.id ? "page" : undefined}
                    className={failed(entry) ? "failed" : ""}
                  >
                    <strong>{targetNames[entry.target]}</strong>
                    <span>
                      {entry.status} · {seconds(entry.duration)}
                    </span>
                  </a>
                ))}
              </nav>
            )}
            <Evidence key={active.id} entry={active} diagnostics={activeRun.diagnostics} />
          </main>
        )}
      </div>
    </>
  );
}
createRoot(container).render(<App />);
