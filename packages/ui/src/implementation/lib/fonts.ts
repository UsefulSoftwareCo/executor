/** The bundled Geist faces, requested with the stylesheet rather than when text first uses them. */
import geistSans from "../styles/fonts/geist-sans.woff2?url";
import geistMono from "../styles/fonts/geist-mono.woff2?url";

/**
 * Head links that preload each face. Faces load with `font-display: optional`, so one that has
 * not arrived by the first paint is never swapped in later, which would rewrap text and move it.
 */
export const fontPreloads = [geistSans, geistMono].map((href) => ({
  rel: "preload",
  href,
  as: "font",
  type: "font/woff2",
  crossOrigin: "anonymous" as const,
}));
