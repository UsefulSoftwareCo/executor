import { defineComponents } from "blume";

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
