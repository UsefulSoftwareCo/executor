/**
 * Source configuration for cloning a git repository into a sandbox.
 */
export interface Source {
  /** GitHub repository URL (e.g., "https://github.com/owner/repo") */
  repo: string;
  /** Branch to clone (defaults to "main") */
  branch?: string;
  /** Directory name or relative path to clone into for multi-repo workspaces */
  directory?: string;
  /** If set, create and checkout a new branch with this name after cloning */
  newBranch?: string;
}

/**
 * Status of a sandbox throughout its lifecycle.
 * Used for UI feedback and state management.
 */
export type SandboxStatus =
  | "starting" // Creating new sandbox
  | "restoring" // Restoring from saved state (files or snapshot)
  | "reconnecting" // Reconnecting to existing VM
  | "ready" // Fully usable
  | "stopping" // Shutting down
  | "stopped"; // Terminated
