import type { Metadata } from "next";
import { AgentsSection } from "../agents-section";

export const metadata: Metadata = {
  title: "Agents",
  description: "Create and manage reusable Open Agents profiles and skills.",
};

export default function AgentsPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Agents</h1>
      <AgentsSection />
    </>
  );
}
