export interface GraphqlPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly url: string;
  readonly endpoint: string;
  readonly icon?: string;
  readonly featured?: boolean;
}

export const graphqlPresets: readonly GraphqlPreset[] = [
  {
    id: "github-graphql",
    name: "GitHub GraphQL",
    summary: "Repos, issues, PRs, and users via GitHub's GraphQL API.",
    url: "https://api.github.com/graphql",
    endpoint: "https://api.github.com/graphql",
    icon: "https://svgl.app/library/github_dark.svg",
    featured: true,
  },
  {
    id: "gitlab",
    name: "GitLab",
    summary: "Projects, merge requests, pipelines, and users.",
    url: "https://gitlab.com/api/graphql",
    endpoint: "https://gitlab.com/api/graphql",
    icon: "https://gitlab.com/favicon.ico",
    featured: true,
  },
  {
    id: "linear",
    name: "Linear",
    summary: "Issues, projects, teams, and cycles.",
    url: "https://api.linear.app/graphql",
    endpoint: "https://api.linear.app/graphql",
    icon: "https://linear.app/favicon.ico",
    featured: true,
  },
  {
    id: "monday",
    name: "Monday.com",
    summary: "Boards, items, columns, and workspace automation.",
    url: "https://api.monday.com/v2",
    endpoint: "https://api.monday.com/v2",
    icon: "https://monday.com/favicon.ico",
  },
  {
    id: "anilist",
    name: "AniList",
    summary: "Anime and manga database — no auth required.",
    url: "https://graphql.anilist.co",
    endpoint: "https://graphql.anilist.co",
    icon: "https://anilist.co/img/icons/favicon-32x32.png",
  },
];
