import { defineComponents } from "blume";

// The docs keep Blume's own page shell — its RootLayout, article header, code
// blocks, "On this page" outline and page actions. Only the chrome that has to
// match the marketing site is replaced:
//
//   Header  the marketing rail, carrying the site navigation, the search
//           button and the documentation tree. It is the whole left column on
//           desktop and a bar on small screens, so Blume's own header is gone.
//   Sidebar nothing: the tree lives in the rail, and Blume's nav column is
//           removed from the grid in styles.css.
//   Footer  the marketing footer, so /docs and / end the same way.
//
// Every other slot is Blume's, and so is the MDX component set, the table of
// contents and all the agent-facing output.
export default defineComponents({
  mdx: {
    ReleaseCommand: "./components/ReleaseCommand.astro",
    ReleaseDesktopLink: "./components/ReleaseDesktopLink.astro",
  },
  layout: {
    Footer: "../marketing/src/components/SiteFooter.astro",
    Header: "./components/DocsRail.astro",
    Sidebar: "./components/NoSidebar.astro",
  },
});
