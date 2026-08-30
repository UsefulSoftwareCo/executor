// ---------------------------------------------------------------------------
// The flow, as one ordered list of screens.
//
// Each step carries the first-run reaction recorded against that exact screen,
// so a redesign can be checked against the complaint it is meant to answer
// rather than against a general sense that the old screen was bad.
// ---------------------------------------------------------------------------

export type StepId =
  | "integrations-empty"
  | "connect-dialog"
  | "add-openapi"
  | "detail-accounts"
  | "add-account-credential"
  | "add-account-place"
  | "oauth-stuck"
  | "integrations-populated";

export interface FlowStep {
  readonly id: StepId;
  readonly label: string;
  /** Where this screen lives in the real console. */
  readonly route: string;
  /** The component this reproduction is taken from. */
  readonly source: string;
  /** Verbatim first-run reactions to this screen. */
  readonly reactions: readonly string[];
}

export const flowSteps: readonly FlowStep[] = [
  {
    id: "integrations-empty",
    label: "Integrations (empty)",
    route: "/",
    source: "packages/react/src/pages/integrations.tsx",
    reactions: [
      "Adding to clis was easy. Not clear what to do next.",
      "Next is this, not a great screen to find integrations from. No text search? I just wanted to add email",
    ],
  },
  {
    id: "connect-dialog",
    label: "Connect dialog",
    route: "/ (dialog)",
    source: "packages/react/src/pages/integrations.tsx › ConnectDialog",
    reactions: [
      "I'd love a proper like picker grid and search",
      "I want to add multiple to set up for experimentation. I clicked the first one I want (posthog) and it brought me here",
      "Annoying because now I have to sit and wait for it to do whatever and then add, and I could be spending this time finding other integrations I want",
    ],
  },
  {
    id: "add-openapi",
    label: "Add integration form",
    route: "/integrations/add/openapi",
    source: "packages/plugins/openapi/src/react/AddOpenApiIntegration.tsx",
    reactions: [
      "This view is a bit of a mess. There's no clear hierarchy on what exactly I'm supposed to be doing, what matters and doesn't, and what button I should hit. There's the big add integration at the bottom and the weird treatment around it. Just very unclear what the step is",
      "Hit “add” and now another loading screen, well spinning wheel button",
    ],
  },
  {
    id: "detail-accounts",
    label: "Integration detail · Accounts",
    route: "/integrations/posthog?tab=accounts",
    source: "packages/react/src/pages/integration-detail.tsx",
    reactions: [
      "wtf is this?? I just added it why do I have to add it again??",
      "The hierarchy of the integrations and connections is not something I should have to understand or care about as I initially setup",
      "I increasingly hate this view. The more that I look at it, there are just so many things demanding attention and none of them are the thing I actually want to do",
    ],
  },
  {
    id: "add-account-credential",
    label: "Add connection · credential",
    route: "/integrations/posthog?tab=accounts&addAccount=1",
    source: "packages/react/src/components/add-account-modal.tsx",
    reactions: [
      "Where the fk do I paste the key?? The Method 1 thing is locked",
      "I'm not scared of doing anything because I already copied the API key and it's on my clipboard but I can't paste it yet. I just have to not use my computer because I don't have clipboard history management and never will",
      "I'm even scared to send a screenshot because I'm going to lose the key. I'm just going to have to recreate it. I think I'll throw it in a note.",
      "Okay so what type of key do I need? Obviously doing this for every integration will be annoying but I'm sure you can get some agent to go do it.",
    ],
  },
  {
    id: "add-account-place",
    label: "Add connection · placement + owner",
    route: "/integrations/posthog?tab=accounts&addAccount=1",
    source: "packages/react/src/components/add-account-modal.tsx",
    reactions: ["How many times does the word “personal” appear on this page? lol"],
  },
  {
    id: "oauth-stuck",
    label: "OAuth · stuck connecting",
    route: "/integrations/gmail?tab=accounts&addAccount=1",
    source: "packages/react/src/plugins/oauth-sign-in.tsx",
    reactions: [
      "Closed the broken auth page and now app is stuck in “connecting...”",
      "On business Gmail, allowed me to click an “Advanced options” (“I trust the developer”) thing, but normal personal accounts, no",
    ],
  },
  {
    id: "integrations-populated",
    label: "Integrations (populated)",
    route: "/",
    source: "packages/react/src/pages/integrations.tsx",
    reactions: ["This is filling me with rage for some reason"],
  },
];

export const stepIndex = (id: StepId): number => flowSteps.findIndex((step) => step.id === id);
