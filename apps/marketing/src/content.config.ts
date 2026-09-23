import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// Blog posts authored as Markdown under src/content/blog. The glob loader
// turns each file into a collection entry whose `id` is the slug used in the
// /blog/[...slug] route (filename without extension).
const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    author: z.string().default("Rhys Sullivan"),
    // X/Twitter handle (without the leading @), a one-line role, and a round
    // avatar image, used by the author card at the top of each post. The
    // avatar path is served from public/ (e.g. /authors/rhys-sullivan.png).
    authorHandle: z.string().default("RhysSullivan"),
    authorRole: z.string().default("Founder of Executor"),
    authorAvatar: z.string().default("/authors/rhys-sullivan.png"),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
