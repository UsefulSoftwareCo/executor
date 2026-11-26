import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Layer, Schedule } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  acceptedNotes,
  notes,
  portMarker,
  portTrailers,
  refusedNotes,
  repositories,
} from "../release-notes-repositories.ts";

const render = (text: string) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("GH_TOKEN").pipe(
      Config.orElse(() => Config.Redacted("GITHUB_TOKEN")),
    );
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({ schedule: Schedule.exponential(2_000), times: 3 }),
    );
    const request = yield* HttpClientRequest.post("https://api.github.com/markdown").pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({
        Accept: "application/vnd.github+json",
        "User-Agent": "executor-release-notes-spec",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
      HttpClientRequest.bodyJson({ text, mode: "gfm", context: "UsefulSoftwareCo/executor" }),
    );
    const response = yield* http.execute(request);
    return yield* response.text;
  });

const items = (html: string) =>
  [...html.matchAll(/<li>([\s\S]*?)<\/li>/gu)].map((match) => match[1]!);

const text = (html: string) =>
  html
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/gu, "&");

const structure = new Set([
  '<h2 dir="auto">',
  "</h2>",
  '<h3 dir="auto">',
  "</h3>",
  '<ul dir="auto">',
  "</ul>",
  "<li>",
  "</li>",
  '<p dir="auto">',
  "</p>",
]);

const credit =
  / \(<a href="https:\/\/github\.com\/UsefulSoftwareCo\/executor\/pull\/2436"[^>]*>#2436<\/a>, thanks <a class="user-mention notranslate"[^>]*href="https:\/\/github\.com\/danizord">@danizord<\/a>\)$/u;

const portNote = "A self-hosted Executor limits each client behind trusted proxies on its own.";

const trailerProbes: ReadonlyArray<{ readonly body: string; readonly note: string }> = [
  {
    note: "A note after a trailer line in the middle is shown.",
    body: "Some prose about the change.\n\nCo-authored-by: Someone <someone@example.invalid>\n\nRelease-note: NOTE\n\nThe rest of the message.",
  },
  {
    note: "A note right under a trailer of dashes is shown.",
    body: "Co-authored-by: --- <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note right over a trailer of equals signs is shown.",
    body: "Some prose.\n\nRelease-note: NOTE\nCo-authored-by: === <a@example.invalid>\nThe rest of the message.",
  },
  {
    note: "A note under a trailer of dashes after a blank line is shown.",
    body: "Co-authored-by: ---------- <a@example.invalid>\n\nRelease-note: NOTE\n\nThe rest of the message.",
  },
  {
    note: "A note under an address of hyphens is shown.",
    body: "Co-authored-by: Someone <---@--->\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a bot with trailing spaces is shown.",
    body: "CO-AUTHORED-BY: helper[bot] <1+helper[bot]@users.noreply.github.com>   \nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a trailer of emphasis marks is shown.",
    body: "Co-authored-by: *** ___ ** <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a trailer of pipes is shown.",
    body: "Co-authored-by: a | b | <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a trailer with an entity is shown.",
    body: "Co-authored-by: &lt;!-- <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
  {
    note: "A note under a trailer ending in a backslash is shown.",
    body: "Co-authored-by: x \\ <a@example.invalid>\nRelease-note: NOTE\nThe rest of the message.",
  },
].map(({ note, body }) => ({ note, body: body.replace("NOTE", note) }));

const voidElements = new Set(["br", "hr", "img", "input", "wbr"]);

const openAt = (html: string, at: number) => {
  const open: Array<string> = [];
  for (const match of html.slice(0, at).matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)[^>]*?(\/?)>/gu)) {
    const [, closing, name = "", selfClosing] = match;
    const tag = name.toLowerCase();
    if (closing === "/") {
      const index = open.lastIndexOf(tag);
      if (index >= 0) open.splice(index);
    } else if (selfClosing !== "/" && !voidElements.has(tag)) open.push(tag);
  }
  return open;
};

layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer), { excludeTestServices: true })(
  "Release notes on GitHub",
  (it) => {
    it.effect(
      "GitHub renders every accepted note, in the notes built from them, as its text alone",
      () =>
        Effect.gen(function* () {
          const repos = yield* repositories([
            {
              title: "Write plain notes (#210)",
              body: acceptedNotes.map((note) => `Release-note: ${note}`).join("\n"),
              files: ["packages/sdk/src/plain.ts"],
            },
            {
              title: "Rate-limit each self-host client behind trusted proxies (#112)",
              body: `Release-note: ${portNote}\n\n${portMarker}\n\n${portTrailers}`,
              files: ["apps/hosted/self-host/src/limit.ts"],
            },
          ]);
          const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
          expect(result.exitCode, result.stderr).toBe(0);
          const [changes = ""] = result.stdout.split("\n## Install\n");
          const html = yield* render(changes);
          const listed = items(html);
          expect(listed).toHaveLength(acceptedNotes.length + 1);
          for (const [index, note] of acceptedNotes.entries()) {
            expect(listed[index], note).not.toContain("<");
            expect(text(listed[index]!), note).toBe(note);
          }
          const port = listed.at(-1)!;
          expect(port, port).toMatch(credit);
          expect(text(port.replace(credit, ""))).toBe(portNote);
          const outside = html.replace(/<li>[\s\S]*?<\/li>/gu, "<li></li>");
          for (const [tag] of outside.matchAll(/<[^>]*>/gu)) expect(structure, tag).toContain(tag);
        }),
    );

    it.effect(
      "a whole co-author trailer line in a message's middle leaves its note listed, and hides, quotes, indents or swallows no line after it",
      () =>
        Effect.gen(function* () {
          const repos = yield* repositories(
            trailerProbes.map(({ body }, index) => ({
              title: `Probe a trailer line (#${600 + index})`,
              body,
              files: [`packages/sdk/src/trailer-probe-${index}.ts`],
            })),
          );
          const result = yield* notes(repos, ["--version", "2.0.0-beta.5"]);
          expect(result.exitCode, result.stderr).toBe(0);
          expect(result.stderr).not.toContain("::warning");
          const [changes = ""] = result.stdout.split("\n## Install\n");
          expect(changes.trim()).toBe(
            [
              "## Changes since 2.0.0-beta.4",
              "",
              "### All installs",
              "",
              ...trailerProbes.map(({ note }) => `- ${note}`),
            ].join("\n"),
          );
          for (const { body, note } of trailerProbes) {
            const html = yield* render(body);
            yield* Console.log(`${JSON.stringify(body)}\n  -> ${JSON.stringify(html)}`);
            for (const line of [`Release-note: ${note}`, "The rest of the message."]) {
              const at = html.indexOf(line);
              expect(at, `${line} in ${html}`).toBeGreaterThanOrEqual(0);
              expect(openAt(html, at), `${line} in ${html}`).toEqual(["p"]);
            }
            expect(html, body).not.toMatch(/<(?:pre|code|blockquote|h[1-6]|table|details)\b/u);
          }
        }),
    );

    it.effect("GitHub renders what the notes refuse as links, mentions, images or markup", () =>
      Effect.gen(function* () {
        const html = yield* render(refusedNotes.map(({ note }) => `- ${note}`).join("\n"));
        const rendered = items(html);
        expect(rendered).toHaveLength(refusedNotes.length);
        const active = new Set(
          refusedNotes.flatMap(({ note }, index) => (rendered[index]!.includes("<") ? [note] : [])),
        );
        for (const { note, reason } of refusedNotes)
          yield* Console.log(
            `${active.has(note) ? "active" : "inert "}  ${JSON.stringify(note)}  (${reason})`,
          );
        for (const note of [
          "\\@someone",
          "gh-123 is fixed",
          "HTTP://example.invalid",
          "UsefulSoftwareCo/executor#123",
          "@one@two",
          "#1#2",
          ":shipit:",
          "See [the guide](https://evil.example/guide)",
          "Logo ![logo](https://evil.example/a.png)",
          "Look <img src=x onerror=alert(1)>",
          "Now **bold**",
          "Read https://evil.example/bare",
          "Visit www.example.com",
          "# Executor starts faster",
          "Run `executor upgrade`",
        ])
          expect(active, note).toContain(note);
      }),
    );
  },
);
