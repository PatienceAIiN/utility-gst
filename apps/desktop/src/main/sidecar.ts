import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Owns the Python parsing sidecar: one long-lived child process speaking
 * line-delimited JSON-RPC 2.0 over stdio. The renderer never sees this.
 */

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class Sidecar {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''

  /**
   * Packaged: resources/sidecar holds either a PyInstaller onedir (gstparse.exe,
   * produced by the windows-latest CI job) or an embeddable-Python bundle
   * (python.exe, assemblable from Linux). Dev: the uv venv.
   */
  private resolveCommand(): { cmd: string; args: string[] } {
    if (app.isPackaged) {
      const base = join(process.resourcesPath, 'sidecar')
      const suffix = process.platform === 'win32' ? '.exe' : ''
      const frozen = join(base, `gstparse${suffix}`)
      if (existsSync(frozen)) return { cmd: frozen, args: ['rpc'] }
      // Windows-only fallback: the embeddable-Python bundle assembled on Linux.
      return { cmd: join(base, 'python.exe'), args: ['-m', 'gstparse.cli', 'rpc'] }
    }
    const repoRoot = join(app.getAppPath(), '..', '..')
    const venv = join(repoRoot, 'sidecar', '.venv', 'bin', 'python')
    const cmd = existsSync(venv) ? venv : 'python3'
    return { cmd, args: ['-m', 'gstparse.cli', 'rpc'] }
  }

  start(): void {
    if (this.child) return
    const { cmd, args } = this.resolveCommand()
    const cwd = app.isPackaged
      ? join(process.resourcesPath, 'sidecar')
      : join(app.getAppPath(), '..', '..', 'sidecar')

    this.child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    // Structured logging only -- no PII, no amounts (brief §12).
    this.child.stderr.on('data', (d: Buffer) =>
      console.error('[sidecar]', d.toString().slice(0, 500))
    )
    this.child.on('exit', (code) => {
      console.error('[sidecar] exited', code)
      for (const { reject } of this.pending.values()) {
        reject(new Error('The parsing engine stopped unexpectedly.'))
      }
      this.pending.clear()
      this.child = null
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line) as {
          id: number
          result?: unknown
          error?: { message: string }
        }
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
      } catch {
        console.error('[sidecar] unparseable line')
      }
    }
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.start()
    if (!this.child) return Promise.reject(new Error('Parsing engine unavailable.'))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.child!.stdin.write(payload)
    })
  }

  stop(): void {
    this.child?.kill()
    this.child = null
  }
}

export const sidecar = new Sidecar()
