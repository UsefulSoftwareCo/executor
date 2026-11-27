import { contextBridge, ipcRenderer } from "electron";
import { desktopChannels } from "./contracts/bridge-channels.ts";

contextBridge.exposeInMainWorld(
  "executorAccountMenu",
  Object.freeze({
    choose: (action: string, account: string | null) =>
      ipcRenderer.send(desktopChannels.menuChoice, { action, account }),
  }),
);
