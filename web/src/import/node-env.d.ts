// Minimal ambient declarations for the Node built-ins used by the dev-only
// `dwgConvert.ts` Vite plugin. This project doesn't ship `@types/node` (the
// app is browser code; the only Node-context file, vite.config.ts, is outside
// the tsc `include`). dwgConvert.ts lives under src/import/, so it gets
// type-checked — these shims keep it self-contained without pulling in a
// dependency. They cover only what dwgConvert.ts actually touches.

interface Buffer {
  readonly length: number
}
declare const Buffer: {
  concat(list: Buffer[]): Buffer
}

declare module 'node:child_process' {
  interface Readable {
    on(event: 'data', cb: (chunk: unknown) => void): void
  }
  interface ChildProc {
    stderr: Readable
    on(event: 'error', cb: (err: Error) => void): void
    on(event: 'close', cb: (code: number | null) => void): void
  }
  export function spawn(
    command: string,
    args: string[],
    options?: { stdio?: unknown },
  ): ChildProc
}

declare module 'node:fs' {
  export const promises: {
    writeFile(path: string, data: Buffer): Promise<void>
    readFile(path: string, encoding: 'utf8'): Promise<string>
    unlink(path: string): Promise<void>
  }
}

declare module 'node:os' {
  export function tmpdir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string
    on(event: 'data', cb: (chunk: Buffer) => void): void
    on(event: 'end', cb: () => void): void
    on(event: 'error', cb: (err: Error) => void): void
  }
  export interface ServerResponse {
    statusCode: number
    setHeader(name: string, value: string): void
    end(chunk?: string): void
  }
}
