/// <reference types="node" />

declare namespace Electron {
  interface BrowserWindow {
    loadFile(path: string, options?: { hash?: string }): void
  }
}

declare module 'ssh2' {
  import { EventEmitter } from 'events'

  export interface ConnectConfig {
    host?: string
    port?: number
    username?: string
    password?: string
    privateKey?: string | Buffer
    passphrase?: string
    readyTimeout?: number
    keepaliveInterval?: number
    keepaliveCountMax?: number
  }

  export interface ClientChannel extends EventEmitter {
    stderr?: EventEmitter
    write(data: string | Buffer): boolean
    end(data?: string | Buffer): void
    setWindow?(rows: number, cols: number, height: number, width: number): void
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): this
    end(): void
    destroy(): void
    shell(callback: (err: Error | undefined, channel: ClientChannel) => void): void
    shell(options: object, callback: (err: Error | undefined, channel: ClientChannel) => void): void
    exec(command: string, callback: (err: Error | undefined, channel: ClientChannel) => void): void
    sftp(callback: (err: Error | undefined, sftp: SFTPWrapper) => void): void
  }
}

export interface SFTPStats {
  mode: number
  size: number
  mtime: number
  uid?: number
  gid?: number
  isDirectory(): boolean
}

export interface SFTPWrapper extends EventEmitter {
  readdir(path: string, callback: (err: Error | undefined, list: Array<{ filename: string; longname: string; attrs: SFTPStats }>) => void): void
  stat(path: string, callback: (err: Error | undefined, stats: SFTPStats) => void): void
  fastPut(localPath: string, remotePath: string, callback: (err: Error | undefined) => void): void
  fastGet(remotePath: string, localPath: string, callback: (err: Error | undefined) => void): void
  createReadStream(path: string, options?: object): NodeJS.ReadableStream & { destroy(error?: Error): void }
  createWriteStream(path: string, options?: object): NodeJS.WritableStream & { destroy(error?: Error): void }
  unlink(path: string, callback: (err: Error | undefined) => void): void
  rmdir(path: string, callback: (err: Error | undefined) => void): void
  rename(oldPath: string, newPath: string, callback: (err: Error | undefined) => void): void
  mkdir(path: string, callback: (err: Error | undefined) => void): void
  open(path: string, flags: string, callback: (err: Error | undefined, handle: Buffer) => void): void
  read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error | undefined, bytesRead: number) => void): void
  close(handle: Buffer, callback: (err: Error | undefined) => void): void
}
