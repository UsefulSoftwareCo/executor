/** Observe the server-selected hero without changing content, identity, or layout. */
import {
  heroExperiment,
  heroPreviewCookie,
  heroProperties,
  readHeroAssignment,
  readHeroVisitor,
  heroVariants,
} from "./content/hero-experiment";

/** Preview visits are excluded from marketing analytics and experiment attribution. */
export const isHeroPreview = () =>
  new URLSearchParams(location.search).has("hero") ||
  location.pathname.startsWith("/experiments/hero/");

/** Mark static preview pages too; a real homepage visit clears this exclusion. */
export const markHeroPreview = () => {
  if (isHeroPreview())
    document.cookie = `${heroPreviewCookie}=1; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
};

/** Bootstrap exactly the identity and native flag value used to render the document. */
export const heroBootstrap = () => {
  if (location.pathname !== "/" || isHeroPreview()) return {};
  const visitor = readHeroVisitor(document.cookie);
  if (visitor === undefined) return {};
  const assignment = readHeroAssignment(document.cookie);
  return {
    distinctID: visitor,
    isIdentifiedID: false,
    ...(assignment?.visitor === visitor
      ? { featureFlags: { [heroExperiment.id]: assignment.variant } }
      : {}),
  };
};

/** Capture an exposure once this document's hero is visible; the cookie must match its HTML. */
export const observeHero = (
  capture: (event: string, properties: Record<string, string>) => void,
) => {
  const hero = document.querySelector<HTMLElement>("[data-hero-variant]");
  if (hero === null || location.pathname !== "/" || isHeroPreview()) return;
  const assignment = readHeroAssignment(document.cookie);
  if (
    assignment === undefined ||
    assignment.visitor !== readHeroVisitor(document.cookie) ||
    heroVariants.find((variant) => variant.flag === assignment.variant)?.id !==
      hero.dataset.heroVariant
  )
    return;
  const properties = heroProperties(assignment);
  let captured = false;
  const expose = () => {
    if (captured || document.visibilityState !== "visible") return;
    const bounds = hero.getBoundingClientRect();
    if (bounds.bottom <= 0 || bounds.top >= innerHeight) return;
    captured = true;
    capture("$feature_flag_called", properties);
    observer.disconnect();
    document.removeEventListener("visibilitychange", expose);
  };
  const observer = new IntersectionObserver(expose);
  observer.observe(hero);
  document.addEventListener("visibilitychange", expose);
  for (const link of hero.querySelectorAll("[data-hero-cta]")) {
    link.addEventListener("click", () => {
      expose();
      capture("hero_cloud_clicked", properties);
    });
  }
  expose();
};
