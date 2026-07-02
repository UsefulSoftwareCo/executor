// Turn an e2e run's recording into PR-ready markdown.
//
// GitHub only renders media inline from URLs it can fetch, and there is no
// API for the drag-and-drop user-asset upload — so this converts the run's
// recording to a gif (the one format that renders inline from a raw repo
// URL), commits it to the orphan `e2e-media` branch through the git database
// API (never touching the local worktree), and prints markdown to paste into
// the PR description.
//
// Usage: bun e2e/scripts/pr-media.ts <run-dir-or-artifact> [...more]
//   run dir        e2e/runs/<target>/<scenario-slug> — picks film.mp4 (the
//                  whole session), else session.mp4, else terminal.cast;
//                  labels the gif from result.json
//   session.mp4    browser recording (ffmpeg -> gif)
//   terminal.cast  terminal recording (agg -> gif; brew install agg)
//   *.png          run screenshot, uploaded as-is
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { chromium } from "playwright";

const MEDIA_BRANCH = "e2e-media";
// Above this GitHub's image proxy stops rendering the gif inline.
const RENDER_LIMIT_BYTES = 10 * 1024 * 1024;
const GIF_WIDTH = 960;
const CHROME_HEIGHT = 40;

const run = (command: string, args: ReadonlyArray<string>): string =>
  execFileSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

const ghJson = (args: ReadonlyArray<string>): unknown => JSON.parse(run("gh", ["api", ...args]));

interface Artifact {
  readonly path: string;
  readonly label: string;
  readonly slug: string;
  readonly runDir?: string;
}

interface Timeline {
  readonly anchors: { readonly browser?: number };
  readonly nav?: ReadonlyArray<{ readonly at: number; readonly url: string }>;
}

interface UrlSegment {
  readonly from: number;
  readonly to: number;
  readonly url: string;
}

/** A run dir resolves to its recording; a file stands for itself. */
const resolveArtifact = (input: string): Artifact => {
  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`no such path: ${input}`);
  if (!statSync(path).isDirectory()) {
    return {
      path,
      label: basename(path),
      slug: basename(path).replace(/\.[^.]+$/, ""),
    };
  }
  // film.mp4 (scripts/film.ts) is the whole session — terminal chat AND the
  // browser hop, cut in time order; the bare browser session.mp4 is only the
  // hop, so it must never win when a film exists.
  const recording = ["film.mp4", "session.mp4", "terminal.cast"]
    .map((name) => join(path, name))
    .find(existsSync);
  if (!recording) throw new Error(`${input} has no film.mp4, session.mp4, or terminal.cast`);
  let label = basename(path);
  try {
    const result = JSON.parse(readFileSync(join(path, "result.json"), "utf8")) as {
      scenario?: string;
      target?: string;
    };
    if (result.scenario) label = `${result.scenario} (${result.target ?? "e2e"})`;
  } catch {
    // skipped/partial runs still have a recording worth showing
  }
  return { path: recording, label, slug: basename(path), runDir: path };
};

const videoDuration = (file: string): number =>
  Number(
    run("ffprobe", [
      ...["-v", "quiet", "-show_entries", "format=duration"],
      ...["-of", "csv=p=0", file],
    ]).trim(),
  );

const readTimeline = (artifact: Artifact): Timeline | null => {
  if (!artifact.runDir) return null;
  const timelinePath = join(artifact.runDir, "timeline.json");
  if (!existsSync(timelinePath)) return null;
  return JSON.parse(readFileSync(timelinePath, "utf8")) as Timeline;
};

const urlSegments = (artifact: Artifact, duration: number): ReadonlyArray<UrlSegment> => {
  if (basename(artifact.path) !== "session.mp4") return [];
  const timeline = readTimeline(artifact);
  const browserAnchor = timeline?.anchors.browser;
  if (!timeline || browserAnchor === undefined) return [];

  const nav = [...(timeline.nav ?? [])]
    .map((entry) => ({
      at: Math.max(0, (entry.at - browserAnchor) / 1000),
      url: entry.url,
    }))
    .filter((entry) => entry.at <= duration)
    .sort((a, b) => a.at - b.at);

  if (nav.length === 0) return [{ from: 0, to: duration, url: "about:blank" }];
  if ((nav[0]?.at ?? 0) <= 0.25) nav[0] = { ...nav[0], at: 0 };

  const segments: UrlSegment[] = [];
  let cursor = 0;
  let currentUrl = "about:blank";
  for (const entry of nav) {
    if (entry.at > cursor) segments.push({ from: cursor, to: entry.at, url: currentUrl });
    currentUrl = entry.url;
    cursor = entry.at;
  }
  segments.push({ from: cursor, to: duration, url: currentUrl });

  return segments
    .filter((segment) => segment.to - segment.from > 0.01)
    .reduce<UrlSegment[]>((merged, segment) => {
      const previous = merged.at(-1);
      if (previous?.url === segment.url && Math.abs(previous.to - segment.from) < 0.01) {
        merged[merged.length - 1] = { ...previous, to: segment.to };
      } else {
        merged.push(segment);
      }
      return merged;
    }, []);
};

const htmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const renderUrlBars = async (
  segments: ReadonlyArray<UrlSegment>,
  workDir: string,
): Promise<ReadonlyArray<{ readonly path: string; readonly segment: UrlSegment }>> => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: GIF_WIDTH, height: CHROME_HEIGHT },
      deviceScaleFactor: 1,
    });
    const bars: Array<{ path: string; segment: UrlSegment }> = [];
    for (const [index, segment] of segments.entries()) {
      const displayUrl = segment.url.replace(/^https?:\/\//, "") || "about:blank";
      await page.setContent(`<!doctype html>
<html>
  <head>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        width: ${GIF_WIDTH}px;
        height: ${CHROME_HEIGHT}px;
        background: #111318;
        color: #d7dde8;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .chrome {
        height: ${CHROME_HEIGHT}px;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 12px;
        border-bottom: 1px solid #272c36;
      }
      .lights {
        display: flex;
        gap: 6px;
        flex: 0 0 auto;
      }
      .lights i {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        display: block;
      }
      .lights i:nth-child(1) { background: #ff5f56; }
      .lights i:nth-child(2) { background: #ffbd2e; }
      .lights i:nth-child(3) { background: #27c93f; }
      .urlbar {
        min-width: 0;
        flex: 1 1 auto;
        height: 26px;
        display: flex;
        align-items: center;
        border: 1px solid #313846;
        border-radius: 6px;
        background: #0b0d12;
        padding: 0 10px;
        color: #d7dde8;
        font-size: 12px;
        line-height: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .lock {
        color: #8b95a7;
        margin-right: 7px;
        flex: 0 0 auto;
      }
    </style>
  </head>
  <body>
    <div class="chrome">
      <span class="lights"><i></i><i></i><i></i></span>
      <div class="urlbar"><span class="lock">url</span>${htmlEscape(displayUrl)}</div>
    </div>
  </body>
</html>`);
      const path = join(workDir, `urlbar-${index}.png`);
      await page.screenshot({ path, animations: "disabled" });
      bars.push({ path, segment });
    }
    return bars;
  } finally {
    await browser.close();
  }
};

const toGif = async (artifact: Artifact): Promise<string> => {
  if (artifact.path.endsWith(".png")) return artifact.path;
  const out = join(tmpdir(), `${artifact.slug}.gif`);
  if (artifact.path.endsWith(".cast")) {
    run("agg", ["--idle-time-limit", "2", "--font-size", "14", artifact.path, out]);
  } else {
    // Two-pass palette keeps UI text crisp at a size GitHub will render.
    const duration = videoDuration(artifact.path);
    const segments = urlSegments(artifact, duration);
    if (segments.length > 0) {
      const workDir = mkdtempSync(join(tmpdir(), "pr-media-urlbar-"));
      try {
        const bars = await renderUrlBars(segments, workDir);
        const scaled =
          `[0:v]fps=8,scale=${GIF_WIDTH}:-2:flags=lanczos,` +
          `pad=iw:ih+${CHROME_HEIGHT}:0:${CHROME_HEIGHT}:color=0x111318,setsar=1[v0]`;
        const overlays = bars.map(({ segment }, index) => {
          const input = index + 1;
          const previous = `v${index}`;
          const next = `v${index + 1}`;
          const from = segment.from.toFixed(3);
          const to = segment.to.toFixed(3);
          return `[${previous}][${input}:v]overlay=0:0:enable='between(t,${from},${to})'[${next}]`;
        });
        const finalVideo = `v${bars.length}`;
        const palette =
          `[${finalVideo}]split[a][b];` +
          "[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5[out]";
        run("ffmpeg", [
          "-y",
          "-loglevel",
          "error",
          "-i",
          artifact.path,
          ...bars.flatMap((bar) => ["-i", bar.path]),
          "-filter_complex",
          [scaled, ...overlays, palette].join(";"),
          "-map",
          "[out]",
          out,
        ]);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    } else {
      const filter =
        `fps=8,scale=${GIF_WIDTH}:-2:flags=lanczos,split[a][b];` +
        "[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5";
      run("ffmpeg", ["-y", "-loglevel", "error", "-i", artifact.path, "-vf", filter, out]);
    }
  }
  return out;
};

/** Commit a file to the media branch via the git database API; returns its raw URL. */
const upload = (repo: string, localPath: string, mediaPath: string): string => {
  const bytes = readFileSync(localPath);
  const request = join(tmpdir(), `pr-media-blob-${process.pid}.json`);
  writeFileSync(request, JSON.stringify({ content: bytes.toString("base64"), encoding: "base64" }));
  const blob = ghJson([`repos/${repo}/git/blobs`, "--method", "POST", "--input", request]) as {
    sha: string;
  };

  // Tip of the media branch, if it exists — the branch is orphan on first use.
  let parent: { commit: string; tree: string } | undefined;
  try {
    const ref = ghJson([`repos/${repo}/git/ref/heads/${MEDIA_BRANCH}`]) as {
      object: { sha: string };
    };
    const commit = ghJson([`repos/${repo}/git/commits/${ref.object.sha}`]) as {
      tree: { sha: string };
    };
    parent = { commit: ref.object.sha, tree: commit.tree.sha };
  } catch {
    parent = undefined;
  }

  writeFileSync(
    request,
    JSON.stringify({
      ...(parent ? { base_tree: parent.tree } : {}),
      tree: [{ path: mediaPath, mode: "100644", type: "blob", sha: blob.sha }],
    }),
  );
  const tree = ghJson([`repos/${repo}/git/trees`, "--method", "POST", "--input", request]) as {
    sha: string;
  };
  writeFileSync(
    request,
    JSON.stringify({
      message: `Add ${mediaPath}`,
      tree: tree.sha,
      parents: parent ? [parent.commit] : [],
    }),
  );
  const commit = ghJson([`repos/${repo}/git/commits`, "--method", "POST", "--input", request]) as {
    sha: string;
  };
  writeFileSync(
    request,
    parent
      ? JSON.stringify({ sha: commit.sha })
      : JSON.stringify({ ref: `refs/heads/${MEDIA_BRANCH}`, sha: commit.sha }),
  );
  ghJson(
    parent
      ? [`repos/${repo}/git/refs/heads/${MEDIA_BRANCH}`, "--method", "PATCH", "--input", request]
      : [`repos/${repo}/git/refs`, "--method", "POST", "--input", request],
  );
  return `https://raw.githubusercontent.com/${repo}/${MEDIA_BRANCH}/${mediaPath}`;
};

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error("usage: bun e2e/scripts/pr-media.ts <run-dir-or-artifact> [...more]");
  process.exit(1);
}

const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
const blocks: Array<string> = [];
for (const input of inputs) {
  const artifact = resolveArtifact(input);
  const gif = await toGif(artifact);
  const size = statSync(gif).size;
  if (size > RENDER_LIMIT_BYTES) {
    console.error(
      `warning: ${basename(gif)} is ${(size / 1024 / 1024).toFixed(1)} MB — GitHub will not render it inline; trim the scenario or lower fps`,
    );
  }
  const hash = createHash("sha256").update(readFileSync(gif)).digest("hex").slice(0, 8);
  const extension = gif.endsWith(".png") ? "png" : "gif";
  const url = upload(repo, gif, `${artifact.slug}-${hash}.${extension}`);
  blocks.push(`![${artifact.label}](${url})`);
}

console.log(`\n${blocks.join("\n\n")}\n`);
