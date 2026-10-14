/** The icons an app declares beside its accounts, so a host shows them without evaluating it. */
import { Schema } from "effect";
import { RouterIcon } from "./router.ts";

/** At most this many icons, together at most this many characters of JSON (32 KiB). */
export const appIconLimits = { icons: 8, characters: 32 * 1024 } as const;

/** Base64 image data of a type browsers render safely in an image element, or an HTTPS URL. */
const appIconSource =
  /^(?:data:image\/(?:svg\+xml|png|webp|jpeg);base64,[A-Za-z0-9+/]*={0,2}|https:\/\/\S+)$/u;

/**
 * One image an app shows for itself, the same shape as a router's icon. `theme` names the color
 * scheme it is drawn for; an icon without one suits both.
 */
export const AppIcon = Schema.Struct({
  ...RouterIcon.fields,
  src: Schema.String.check(
    Schema.isPattern(appIconSource),
    Schema.isMaxLength(appIconLimits.characters),
  ),
});
export type AppIcon = typeof AppIcon.Type;

/** An app's icons, bounded in number and total size. */
export const AppIcons = Schema.Array(AppIcon).check(
  Schema.isMaxLength(appIconLimits.icons),
  Schema.makeFilter((icons) => JSON.stringify(icons).length <= appIconLimits.characters, {
    message: `An app's icons total at most ${appIconLimits.characters} characters`,
  }),
);
export type AppIcons = typeof AppIcons.Type;

/** Why declared icons are refused, in the author's terms, or undefined when they are valid. */
export const appIconsProblem = (icons: unknown): string | undefined => {
  if (!Array.isArray(icons)) return "icons must be an array of { src, mimeType?, sizes?, theme? }";
  if (icons.length > appIconLimits.icons)
    return `An app declares at most ${appIconLimits.icons} icons; this one declares ${icons.length}`;
  for (const [index, icon] of icons.entries()) {
    const src: unknown = typeof icon === "object" && icon !== null ? icon.src : undefined;
    if (typeof src !== "string" || !appIconSource.test(src))
      return `icons[${index}].src must be a base64 data:image/svg+xml, image/png, image/webp or image/jpeg URI, or an https: URL`;
  }
  const size = JSON.stringify(icons).length;
  if (size > appIconLimits.characters)
    return `An app's icons total at most 32 KiB; these take ${Math.ceil(size / 1024)} KiB`;
  return Schema.is(AppIcons)(icons)
    ? undefined
    : 'Each icon is { src, mimeType?: string, sizes?: string[], theme?: "light" | "dark" }';
};
