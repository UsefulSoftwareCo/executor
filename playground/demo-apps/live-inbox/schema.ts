/** Shared data shape; safe to import from browser and server code. */
import { object, string } from "apps";
export const Message = object({ id: string(), subject: string() });
