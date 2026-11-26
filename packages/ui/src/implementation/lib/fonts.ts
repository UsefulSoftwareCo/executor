import geistSans from "../styles/fonts/geist-sans.woff2?url";
import geistMono from "../styles/fonts/geist-mono.woff2?url";

export const fontPreloads = [geistSans, geistMono].map((href) => ({
  rel: "preload",
  href,
  as: "font",
  type: "font/woff2",
  crossOrigin: "anonymous" as const,
}));
