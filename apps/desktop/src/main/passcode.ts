import { app, safeStorage } from 'electron'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Screen lock.
 *
 * Deliberately scoped: this stops someone sitting down at an unattended machine
 * and reading a client's register. It is NOT encryption. A four-digit code is
 * ten thousand combinations, so anyone with the data files and patience can
 * bypass it entirely -- the UI says so rather than implying more.
 *
 * What it does do properly:
 *  - the code is never stored, only a salted scrypt hash
 *  - verification is constant-time
 *  - wrong attempts back off and then lock out, so the ten thousand
 *    combinations cannot be walked through by hand or by a script driving the
 *    UI. Without that a 4-digit lock is theatre.
 */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 } as const
const LOCKOUT_AFTER = 5
const MAX_LOCKOUT_MS = 15 * 60 * 1000

interface Vault {
  hash?: string | undefined
  failed: number
  lockedUntil?: string | undefined
}

function hash(code: string, salt?: Buffer): string {
  const useSalt = salt ?? randomBytes(16)
  const key = scryptSync(code, useSalt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024
  })
  return `${useSalt.toString('base64')}$${key.toString('base64')}`
}

function verifyHash(code: string, stored: string): boolean {
  const [saltB64, keyB64] = stored.split('$')
  if (!saltB64 || !keyB64) return false
  try {
    const expected = Buffer.from(keyB64, 'base64')
    const actual = scryptSync(code, Buffer.from(saltB64, 'base64'), expected.length, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: 256 * 1024 * 1024
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export interface PasscodeStatus {
  enabled: boolean
  /** True once unlocked this session. */
  unlocked: boolean
  lockedForSeconds: number
  attemptsLeft: number
}

class Passcode {
  private path = join(app.getPath('userData'), 'passcode.dat')
  private vault: Vault | null = null
  private unlocked = false

  private load(): Vault {
    if (this.vault) return this.vault
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path)
        const json = safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(raw)
          : raw.toString('utf8')
        this.vault = JSON.parse(json) as Vault
        return this.vault
      }
    } catch {
      console.error('[passcode] vault unreadable')
    }
    this.vault = { failed: 0 }
    return this.vault
  }

  private persist(): void {
    const json = JSON.stringify(this.vault ?? { failed: 0 })
    mkdirSync(dirname(this.path), { recursive: true })
    const payload = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf8')
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, payload)
    renameSync(temporary, this.path)
  }

  private lockRemaining(): number {
    const { lockedUntil } = this.load()
    if (!lockedUntil) return 0
    return Math.max(0, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000))
  }

  status(): PasscodeStatus {
    const vault = this.load()
    return {
      enabled: Boolean(vault.hash),
      // With no passcode set there is nothing to unlock, so the app is open.
      unlocked: vault.hash ? this.unlocked : true,
      lockedForSeconds: this.lockRemaining(),
      attemptsLeft: Math.max(0, LOCKOUT_AFTER - vault.failed)
    }
  }

  set(code: string): { ok: boolean; error?: string } {
    if (!/^\d{4}$/.test(code)) return { ok: false, error: 'Use exactly four digits.' }
    // A code that is all one digit, or a straight run, is the first thing anyone
    // tries. Refusing them costs the operator nothing and removes the easiest
    // guesses from a small keyspace.
    if (/^(\d)\1{3}$/.test(code) || '0123456789'.includes(code) || '9876543210'.includes(code)) {
      return { ok: false, error: 'Avoid repeated or sequential digits — try something less guessable.' }
    }
    const vault = this.load()
    vault.hash = hash(code)
    vault.failed = 0
    vault.lockedUntil = undefined
    this.persist()
    this.unlocked = true
    return { ok: true }
  }

  verify(code: string): { ok: boolean; error?: string; lockedForSeconds?: number } {
    const vault = this.load()
    if (!vault.hash) {
      this.unlocked = true
      return { ok: true }
    }
    const remaining = this.lockRemaining()
    if (remaining > 0) {
      return { ok: false, error: 'Too many attempts.', lockedForSeconds: remaining }
    }
    if (!verifyHash(code, vault.hash)) {
      vault.failed += 1
      if (vault.failed >= LOCKOUT_AFTER) {
        // Exponential, capped. This is what makes a 4-digit code meaningful:
        // 10,000 combinations is nothing without a delay between guesses.
        const seconds = Math.min(MAX_LOCKOUT_MS / 1000, 2 ** (vault.failed - LOCKOUT_AFTER) * 30)
        vault.lockedUntil = new Date(Date.now() + seconds * 1000).toISOString()
      }
      this.persist()
      return { ok: false, error: 'That code is not right.' }
    }
    vault.failed = 0
    vault.lockedUntil = undefined
    this.persist()
    this.unlocked = true
    return { ok: true }
  }

  /** Turning it off requires proving you know it. */
  disable(code: string): { ok: boolean; error?: string } {
    const vault = this.load()
    if (!vault.hash) return { ok: true }
    if (!verifyHash(code, vault.hash)) return { ok: false, error: 'That code is not right.' }
    vault.hash = undefined
    vault.failed = 0
    vault.lockedUntil = undefined
    this.persist()
    this.unlocked = true
    return { ok: true }
  }

  /**
   * Clear the passcode on an administrator's authority, for someone who has
   * forgotten theirs.
   *
   * This is the one path that removes a lock without the code, so it is driven
   * solely by a grant the server issues against the signed-in account -- never
   * by anything the person at the keyboard can assert. The caller must confirm
   * the grant before calling, and confirm back to the server afterwards so it
   * is spent exactly once.
   */
  releaseByGrant(): void {
    const vault = this.load()
    if (!vault.hash) return
    vault.hash = undefined
    vault.failed = 0
    vault.lockedUntil = undefined
    this.persist()
    this.unlocked = true
  }

  /** Re-lock without quitting, for stepping away from the desk. */
  lock(): void {
    if (this.load().hash) this.unlocked = false
  }
}

export const passcode = new Passcode()
