import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

import {
  evidenceViewerUrl,
  r2ObjectUrl,
  validateEvidenceBundle,
  verifyPublishedEvidence,
} from "../src/evidence-publication";
import { loadTrustedRunLanes } from "../src/evidence-trust";

const CACHE_CONTROL = "public, max-age=31536000, immutable";
const UPLOAD_CONCURRENCY = 6;
const SECRET_ENVIRONMENT_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
]);

const argumentValue = (name: string) => {
  const args = process.argv.slice(2);
  const equals = args.find((argument) => argument.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const requiredArgument = (name: string) => {
  const value = argumentValue(name);
  if (!value) throw new Error(`publish-evidence-r2: ${name} is required`);
  return value;
};

const requiredEnvironment = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`publish-evidence-r2: ${name} is required`);
  return value;
};

const curlConfigValue = (value: string) => {
  if (value.includes("\r") || value.includes("\n") || value.includes("\0")) {
    throw new Error("publish-evidence-r2: R2 credentials contain an unsupported character");
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
};

const curlEnvironment = () => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_ENVIRONMENT_KEYS.has(key) && value !== undefined) environment[key] = value;
  }
  return environment;
};

const runCurl = (args: ReadonlyArray<string>, configuration: string) =>
  new Promise<{ readonly ok: true } | { readonly ok: false; readonly error: Error }>((resolve) => {
    const child = spawn("curl", [...args], {
      env: curlEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.stdout.resume();
    child.once("error", (error) => resolve({ ok: false, error }));
    child.once("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else {
        resolve({
          ok: false,
          error: new Error(`curl exited with code ${code}: ${stderr.trim()}`),
        });
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(configuration);
  });

const uploadFiles = async (
  files: ReadonlyArray<ReturnType<typeof validateEvidenceBundle>["files"][number]>,
  upload: (file: ReturnType<typeof validateEvidenceBundle>["files"][number]) => Promise<void>,
) => {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const file = files[index];
        if (!file) return;
        await upload(file);
      }
    }),
  );
};

const main = async () => {
  const runsDir = requiredArgument("--runs-dir");
  const bucket = requiredArgument("--bucket");
  const prefix = requiredArgument("--prefix");
  const endpoint = requiredArgument("--endpoint");
  const publicBaseUrl = requiredArgument("--public-base-url");
  const sourceRevision = requiredArgument("--source-revision");
  const trustedLanesFile = requiredArgument("--trusted-lanes");
  const accessKeyId = requiredEnvironment("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnvironment("R2_SECRET_ACCESS_KEY");
  const trustedRuns = loadTrustedRunLanes(trustedLanesFile, runsDir);
  const bundle = validateEvidenceBundle(runsDir, sourceRevision, trustedRuns);
  const viewerUrl = evidenceViewerUrl(publicBaseUrl, prefix);
  const curlConfiguration = `user = "${curlConfigValue(accessKeyId)}:${curlConfigValue(secretAccessKey)}"\n`;
  const sortedFiles = [...bundle.files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const controlFiles = new Set(["index.html", "manifest.json", "publication.json"]);
  const payloadFiles = sortedFiles.filter((file) => !controlFiles.has(file.relativePath));
  const finalFiles = ["manifest.json", "publication.json", "index.html"].map((relativePath) => {
    const file = sortedFiles.find((candidate) => candidate.relativePath === relativePath);
    if (!file) throw new Error(`publish-evidence-r2: missing ${relativePath}`);
    return file;
  });

  let uploaded = 0;
  const upload = async (file: (typeof sortedFiles)[number]) => {
    const objectUrl = r2ObjectUrl(endpoint, bucket, prefix, file.relativePath);
    const result = await runCurl(
      [
        "--config",
        "-",
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--retry",
        "3",
        "--retry-all-errors",
        "--connect-timeout",
        "30",
        "--request",
        "PUT",
        "--upload-file",
        file.absolutePath,
        "--aws-sigv4",
        "aws:amz:auto:s3",
        "--header",
        `Content-Type: ${file.artifact.mime}`,
        "--header",
        `Cache-Control: ${CACHE_CONTROL}`,
        objectUrl,
      ],
      curlConfiguration,
    );
    if (!result.ok) throw result.error;
    uploaded += 1;
    if (uploaded % 25 === 0 || uploaded === sortedFiles.length) {
      console.log(`publish-evidence-r2: uploaded ${uploaded}/${sortedFiles.length} files`);
    }
  };

  await uploadFiles(payloadFiles, upload);
  for (const file of finalFiles) await upload(file);

  await verifyPublishedEvidence({ viewerUrl, files: bundle.files });

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(
      outputFile,
      `viewer_url=${viewerUrl}\nobject_prefix=${prefix}\nuploaded_files=${uploaded}\n`,
    );
  }
  console.log(`publish-evidence-r2: verified ${viewerUrl}`);
};

main().catch((error) => {
  console.error(`publish-evidence-r2: ${String(error)}`);
  process.exitCode = 1;
});
