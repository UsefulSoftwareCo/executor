import { setupCliTarget } from "./cli.globalsetup";

export default (): Promise<(() => Promise<void>) | void> => setupCliTarget("linux");
