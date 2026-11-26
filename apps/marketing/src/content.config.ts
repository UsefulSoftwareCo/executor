import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    author: z.string().default("Rhys Sullivan"),
    authorHandle: z.string().default("RhysSullivan"),
    authorRole: z.string().default("Founder of Executor"),
    authorAvatar: z.string().default("/authors/rhys-sullivan.png"),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
