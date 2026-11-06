// What the workbench page may ask of the desktop app, as `window.microsight` (packages/settings/src/welcome.tsx,
// DesktopBridge): the app's version, a new library folder, and updates. main.ts answers only DSH's own page.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

contextBridge.exposeInMainWorld('microsight', {
  version: ipcRenderer.sendSync('microsight:version') as string,
  chooseLibrary: () => ipcRenderer.invoke('microsight:choose-library'),
  update: {
    status: () => ipcRenderer.invoke('microsight:update-status'),
    check: () => ipcRenderer.invoke('microsight:update-check'),
    install: () => ipcRenderer.invoke('microsight:update-install'),
    onStatus: (listener: (status: unknown) => void) => {
      const forward = (_event: IpcRendererEvent, status: unknown): void => listener(status)
      ipcRenderer.on('microsight:update', forward)
      return () => { ipcRenderer.removeListener('microsight:update', forward) }
    },
  },
})
