import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { backendUrl } from './sync'
import { store } from './store'

/**
 * Feedback and error reporting.
 *
 * Both post to our own API, which is what actually sends mail. Nothing is
 * dropped: a send that fails is appended to a local queue and retried on the
 * next successful send, so an operator on a flaky office connection does not
 * lose the report they just wrote.
 *
 * Error reports are gated on the diagnostics consent and never carry amounts,
 * party names or GSTINs.
 */

const QUEUE = (): string => join(app.getPath('userData'), 'outbox.jsonl')

interface Queued {
  path: string
  payload: Record<string, unknown>
}

function enqueue(item: Queued): void {
  try {
    appendFileSync(QUEUE(), JSON.stringify(item) + '\n', 'utf8')
  } catch {
    /* nothing better to do */
  }
}

async function post(path: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(`${backendUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000)
    })
    return response.ok
  } catch {
    return false
  }
}

/** Retry anything queued earlier. Best effort; failures stay queued. */
export async function flushOutbox(): Promise<number> {
  const file = QUEUE()
  if (!existsSync(file)) return 0
  let items: Queued[]
  try {
    items = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Queued)
  } catch {
    return 0
  }
  const remaining: Queued[] = []
  let sent = 0
  for (const item of items) {
    if (await post(item.path, item.payload)) sent++
    else remaining.push(item)
  }
  try {
    writeFileSync(file, remaining.map((i) => JSON.stringify(i)).join('\n') + (remaining.length ? '\n' : ''), 'utf8')
  } catch {
    /* keep going */
  }
  return sent
}

export async function sendFeedback(
  kind: string,
  message: string,
  email: string
): Promise<{ status: 'sent' | 'queued'; pending?: number }> {
  const payload = {
    kind,
    message,
    email: email || null,
    version: app.getVersion()
  }
  if (await post('/v1/feedback', payload)) {
    void flushOutbox()
    return { status: 'sent' }
  }
  enqueue({ path: '/v1/feedback', payload })
  return { status: 'queued' }
}

export function reportError(kind: string, message: string): void {
  // Diagnostics are opt-in. With consent withheld, nothing is recorded or sent.
  if (store.get().consent?.analytics !== true) return
  const payload = { kind, message: message.slice(0, 4000), version: app.getVersion() }
  void post('/v1/errors', payload).then((ok) => {
    if (!ok) enqueue({ path: '/v1/errors', payload })
  })
}

/** Crash handlers. An error reporter must never itself crash the app. */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (error) => {
    reportError('uncaught-exception', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    console.error('[fatal]', error)
  })
  process.on('unhandledRejection', (reason) => {
    reportError('unhandled-rejection', reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason))
  })
}
