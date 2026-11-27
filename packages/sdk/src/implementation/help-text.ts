import { Array as Arr, Effect } from "effect";
import { fieldDescriptions, helpTextLimits } from "apps/contracts";
import type {
  MarkdownReader,
  MarkdownRefusals,
  MarkdownUnavailable,
} from "../contracts/markdown.ts";
import type { ProviderDefinition } from "../contracts/provider.ts";

const count = (value: number) => value.toLocaleString("en-US");

export interface HelpText {
  readonly where: string;
  readonly text: string;
  readonly maxLength: number;
}

const readEach = <A extends { readonly text: string }>(
  markdown: MarkdownReader,
  pieces: ReadonlyArray<A>,
): Effect.Effect<ReadonlyArray<readonly [A, MarkdownRefusals]>, MarkdownUnavailable> =>
  pieces.length === 0
    ? Effect.succeed([])
    : Effect.flatMap(markdown(pieces.map(({ text }) => text)), (refusals) =>
        refusals.length === pieces.length
          ? Effect.succeed(Arr.zip(pieces, refusals))
          : Effect.die(
              new Error(
                `The Markdown reader answered ${refusals.length} of ${pieces.length} texts`,
              ),
            ),
      );

export const setupHelp = (definition: ProviderDefinition): ReadonlyArray<HelpText> =>
  Object.entries(definition.auth).flatMap(([name, method]) => {
    if (method.type === "interactive") return [];
    const [guide, text, fields] =
      method.type === "secrets"
        ? ["guide", method.guide, method.fields]
        : ["clientGuide", method.clientGuide, method.response];
    return [
      ...(text === undefined
        ? []
        : [{ where: `method "${name}" ${guide}`, text, maxLength: helpTextLimits.guide }]),
      ...fieldDescriptions(fields).map(([field, description]) => ({
        where: `method "${name}" field "${field}" description`,
        text: description,
        maxLength: helpTextLimits.description,
      })),
    ];
  });

export const setupHelpProblems = (markdown: MarkdownReader, help: ReadonlyArray<HelpText>) =>
  Effect.map(readEach(markdown, help), (read): ReadonlyArray<string> =>
    read.flatMap(([{ where, text, maxLength }, refused]) =>
      [
        ...(text.length > maxLength
          ? [`is ${count(text.length)} characters; the limit is ${count(maxLength)}`]
          : []),
        ...(refused.html ? ["contains raw HTML; write Markdown instead"] : []),
        ...(refused.image
          ? ["contains an image; images are not shown, so link to the page instead"]
          : []),
        ...(refused.links.length > 0
          ? ["has a link whose address does not start with https://"]
          : []),
      ].map((problem) => `${where} ${problem}`),
    ),
  );
