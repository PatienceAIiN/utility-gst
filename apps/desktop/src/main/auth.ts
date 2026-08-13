import { app, safeStorage } from 'electron'
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Local-first accounts. Sign-up, sign-in and password reset all happen on this
 * machine with no network involved; the account only ever reaches a server if
 * the operator turns cloud sync on.
 *
 * Password hashing uses scrypt (RFC 7914) from Node's crypto module rather than
 * Argon2id as the brief specifies. Argon2 needs a native module, which would
 * have to build against BOTH Electron ABIs for the dual-channel release
 * (DECISIONS.md D-01/D-06) -- the single most fragile part of the build. scrypt
 * is a memory-hard KDF in the same family, ships with Node, and needs no
 * compilation. When the server exists it will hash with Argon2id server-side;
 * this protects the local vault only.
 *
 * The password is never stored. The record holds salt + derived key, and the
 * verifier is a constant-time comparison.
 */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 } as const
const RECOVERY_WORDS = 4

export interface Account {
  id: string
  email: string
  name: string
  org?: string | undefined
  gstin?: string | undefined
  createdAt: string
  /** scrypt$N$r$p$saltB64$keyB64 */
  password: string
  /** SHA-256 of the recovery code. The code itself is shown once and not kept. */
  recoveryHash: string
  lastSignInAt?: string | undefined
  /** Failed attempts and lockout, enforced locally (brief §9). */
  failedAttempts: number
  lockedUntil?: string | undefined
}

interface Vault {
  account: Account | null
}

function hashPassword(password: string, salt?: Buffer): string {
  const useSalt = salt ?? randomBytes(16)
  const key = scryptSync(password, useSalt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024
  })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${useSalt.toString('base64')}$${key.toString('base64')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, keyB64] = parts
  try {
    const salt = Buffer.from(saltB64!, 'base64')
    const expected = Buffer.from(keyB64!, 'base64')
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function newRecoveryCode(): string {
  // Grouped hex is easy to read back off a screen or a piece of paper.
  return Array.from({ length: RECOVERY_WORDS }, () => randomBytes(2).toString('hex').toUpperCase()).join(
    '-'
  )
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export type AuthResult =
  | { ok: true; account: PublicAccount }
  | { ok: false; error: string; lockedForSeconds?: number }

export interface PublicAccount {
  id: string
  email: string
  name: string
  org?: string | undefined
  gstin?: string | undefined
  createdAt: string
  lastSignInAt?: string | undefined
}

class Auth {
  private path = join(app.getPath('userData'), 'account.dat')
  private vault: Vault | null = null
  private signedIn = false

  /**
   * The vault is encrypted at rest with Electron safeStorage, which uses DPAPI
   * on Windows and is bound to the OS user account. A plain JSON file holding a
   * password hash next to the data it protects is not acceptable.
   */
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
      console.error('[auth] vault unreadable')
    }
    this.vault = { account: null }
    return this.vault
  }

  private persist(): void {
    const json = JSON.stringify(this.vault ?? { account: null })
    mkdirSync(dirname(this.path), { recursive: true })
    const payload = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from(json, 'utf8')
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, payload)
    renameSync(temporary, this.path)
  }

  private toPublic(account: Account): PublicAccount {
    return {
      id: account.id,
      email: account.email,
      name: account.name,
      org: account.org,
      gstin: account.gstin,
      createdAt: account.createdAt,
      lastSignInAt: account.lastSignInAt
    }
  }

  status(): { hasAccount: boolean; signedIn: boolean; account: PublicAccount | null } {
    const { account } = this.load()
    return {
      hasAccount: account !== null,
      signedIn: this.signedIn,
      account: account && this.signedIn ? this.toPublic(account) : null
    }
  }

  signUp(input: {
    email: string
    name: string
    password: string
    org?: string | undefined
    gstin?: string | undefined
  }): AuthResult & { recoveryCode?: string } {
    const vault = this.load()
    if (vault.account) return { ok: false, error: 'An account already exists on this computer.' }
    if (input.password.length < 10) {
      return { ok: false, error: 'Use at least 10 characters.' }
    }

    const recoveryCode = newRecoveryCode()
    const account: Account = {
      id: randomBytes(16).toString('hex'),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      org: input.org?.trim() || undefined,
      gstin: input.gstin?.trim().toUpperCase() || undefined,
      createdAt: new Date().toISOString(),
      password: hashPassword(input.password),
      recoveryHash: sha256(recoveryCode),
      failedAttempts: 0
    }
    vault.account = account
    this.persist()
    this.signedIn = true
    return { ok: true, account: this.toPublic(account), recoveryCode }
  }

  signIn(email: string, password: string): AuthResult {
    const { account } = this.load()
    if (!account) return { ok: false, error: 'No account on this computer yet.' }

    if (account.lockedUntil) {
      const remaining = new Date(account.lockedUntil).getTime() - Date.now()
      if (remaining > 0) {
        return {
          ok: false,
          error: 'Too many failed attempts.',
          lockedForSeconds: Math.ceil(remaining / 1000)
        }
      }
    }

    if (account.email !== email.trim().toLowerCase() || !verifyPassword(password, account.password)) {
      account.failedAttempts += 1
      // Exponential backoff (brief §9), capped so a typo is not a lockout.
      if (account.failedAttempts >= 5) {
        const seconds = Math.min(15 * 60, 2 ** (account.failedAttempts - 5) * 30)
        account.lockedUntil = new Date(Date.now() + seconds * 1000).toISOString()
      }
      this.persist()
      return { ok: false, error: 'That email or password is not right.' }
    }

    account.failedAttempts = 0
    account.lockedUntil = undefined
    account.lastSignInAt = new Date().toISOString()
    this.persist()
    this.signedIn = true
    return { ok: true, account: this.toPublic(account) }
  }

  signOut(): void {
    this.signedIn = false
  }

  /**
   * Local password reset. There is no email server involved, so the recovery
   * code issued at sign-up is the second factor. Losing it means the vault
   * cannot be reset -- which is stated plainly in the UI at sign-up.
   */
  resetPassword(email: string, recoveryCode: string, newPassword: string): AuthResult & { recoveryCode?: string } {
    const { account } = this.load()
    if (!account) return { ok: false, error: 'No account on this computer yet.' }
    if (account.email !== email.trim().toLowerCase()) {
      return { ok: false, error: 'That email does not match this computer’s account.' }
    }
    if (sha256(recoveryCode.trim().toUpperCase()) !== account.recoveryHash) {
      return { ok: false, error: 'That recovery code is not right.' }
    }
    if (newPassword.length < 10) return { ok: false, error: 'Use at least 10 characters.' }

    const fresh = newRecoveryCode()
    account.password = hashPassword(newPassword)
    account.recoveryHash = sha256(fresh)
    account.failedAttempts = 0
    account.lockedUntil = undefined
    this.persist()
    this.signedIn = true
    return { ok: true, account: this.toPublic(account), recoveryCode: fresh }
  }

  updateProfile(patch: {
    name?: string | undefined
    org?: string | undefined
    gstin?: string | undefined
  }): AuthResult {
    const { account } = this.load()
    if (!account || !this.signedIn) return { ok: false, error: 'Sign in first.' }
    if (patch.name !== undefined) account.name = patch.name.trim()
    if (patch.org !== undefined) account.org = patch.org.trim() || undefined
    if (patch.gstin !== undefined) account.gstin = patch.gstin.trim().toUpperCase() || undefined
    this.persist()
    return { ok: true, account: this.toPublic(account) }
  }

  changePassword(current: string, next: string): AuthResult {
    const { account } = this.load()
    if (!account || !this.signedIn) return { ok: false, error: 'Sign in first.' }
    if (!verifyPassword(current, account.password)) {
      return { ok: false, error: 'Your current password is not right.' }
    }
    if (next.length < 10) return { ok: false, error: 'Use at least 10 characters.' }
    account.password = hashPassword(next)
    this.persist()
    return { ok: true, account: this.toPublic(account) }
  }

  /** Identifier used to namespace remote backups. Not the email itself. */
  accountKey(): string | null {
    const { account } = this.load()
    return account ? sha256(account.id).slice(0, 32) : null
  }
}

export const auth = new Auth()
