import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge shadcn component styles with the caller's Tailwind overrides. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
