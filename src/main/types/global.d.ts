/// <reference types="node" />

declare namespace Electron {
  interface BrowserWindow {
    loadFile(path: string, options?: { hash?: string }): void
  }
}