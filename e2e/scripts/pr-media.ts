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
//   run dir        e2e/runs/<target>/<scenario-slug> — picks session.mp4 or
//                  terminal.cast and labels the gif from result.json
//   session.mp4    browser recording (ffmpeg -> gif)
//   terminal.cast  terminal recording (agg -> gif; brew install agg)
//   *.png          run screenshot, uploaded as-is
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const MEDIA_BRANCH = "e2e-media";
// Above this GitHub's image proxy stops rendering the gif inline.
const RENDER_LIMIT_BYTES = 10 * 1024 * 1024;

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
  const recording = ["session.mp4", "terminal.cast"]
    .map((name) => join(path, name))
    .find(existsSync);
  if (!recording) throw new Error(`${input} has no session.mp4 or terminal.cast`);
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
  return { path: recording, label, slug: basename(path) };
};

const toGif = (artifact: Artifact): string => {
  if (artifact.path.endsWith(".png")) return artifact.path;
  const out = join(tmpdir(), `${artifact.slug}.gif`);
  if (artifact.path.endsWith(".cast")) {
    run("agg", ["--idle-time-limit", "2", "--font-size", "14", artifact.path, out]);
  } else {
    // Two-pass palette keeps UI text crisp at a size GitHub will render.
    const filter =
      "fps=8,scale=960:-2:flags=lanczos,split[a][b];" +
      "[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5";
    run("ffmpeg", ["-y", "-loglevel", "error", "-i", artifact.path, "-vf", filter, out]);
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
  const gif = toGif(artifact);
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
