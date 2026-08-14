import { useCallback, useEffect, useState } from 'react'
import { Box, Button, Fade, Stack, Typography } from '@mui/material'
import BackspaceOutlinedIcon from '@mui/icons-material/BackspaceOutlined'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'

/**
 * Full-window lock. Nothing behind it is rendered until the code is accepted,
 * so a locked app cannot leak a client's register through a stale frame.
 *
 * The keypad is on screen because a four-digit code is faster to tap than to
 * type, but the physical keyboard works throughout -- an operator who lives in
 * this app should never be forced onto the mouse.
 */

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']

export default function Lock({
  mode = 'unlock',
  onUnlocked,
  onCancel
}: {
  /** 'unlock' gates the app; 'set' captures a new code twice. */
  mode?: 'unlock' | 'set'
  onUnlocked: (code: string) => void
  onCancel?: () => void
}): JSX.Element {
  const [code, setCode] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(0)
  const [lockedFor, setLockedFor] = useState(0)

  const fail = useCallback((message: string) => {
    setError(message)
    setShake((n) => n + 1)
    setCode('')
  }, [])

  // Countdown while locked out, so the wait is visible rather than a dead UI.
  useEffect(() => {
    if (lockedFor <= 0) return
    const timer = setInterval(() => setLockedFor((n) => Math.max(0, n - 1)), 1000)
    return () => clearInterval(timer)
  }, [lockedFor])

  const submit = useCallback(
    async (entered: string) => {
      if (mode === 'set') {
        if (confirming === null) {
          setConfirming(entered)
          setCode('')
          setError(null)
          return
        }
        if (confirming !== entered) {
          setConfirming(null)
          fail('Those did not match. Start again.')
          return
        }
        onUnlocked(entered)
        return
      }

      const result = await window.api.passcode.verify(entered)
      if (result.ok) {
        onUnlocked(entered)
        return
      }
      if (result.lockedForSeconds) setLockedFor(result.lockedForSeconds)
      fail(result.error ?? 'That code is not right.')
    },
    [mode, confirming, fail, onUnlocked]
  )

  const push = useCallback(
    (digit: string) => {
      if (lockedFor > 0) return
      setError(null)
      setCode((current) => {
        const next = (current + digit).slice(0, 4)
        if (next.length === 4) void submit(next)
        return next
      })
    },
    [lockedFor, submit]
  )

  // Physical keyboard, always.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (/^\d$/.test(event.key)) push(event.key)
      else if (event.key === 'Backspace') setCode((c) => c.slice(0, -1))
      else if (event.key === 'Escape' && onCancel) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [push, onCancel])

  const title =
    mode === 'set'
      ? confirming === null
        ? 'Choose a 4-digit passcode'
        : 'Enter it again to confirm'
      : 'Enter your passcode'

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        bgcolor: 'background.default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'lockIn .3s ease',
        '@keyframes lockIn': { from: { opacity: 0 }, to: { opacity: 1 } }
      }}
    >
      <Stack alignItems="center" spacing={3} sx={{ width: 300 }}>
        <Box
          sx={{
            width: 58,
            height: 58,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'action.hover',
            color: 'primary.main',
            animation: 'rise .45s cubic-bezier(.2,.8,.3,1)',
            '@keyframes rise': {
              from: { transform: 'translateY(8px) scale(.9)', opacity: 0 },
              to: { transform: 'none', opacity: 1 }
            }
          }}
        >
          <LockOutlinedIcon />
        </Box>

        <Stack alignItems="center" spacing={0.5}>
          <Typography variant="h6" align="center">
            {title}
          </Typography>
          <Typography variant="caption" color="text.secondary" align="center" sx={{ minHeight: 20 }}>
            {lockedFor > 0
              ? `Too many attempts — try again in ${lockedFor}s`
              : error
                ? error
                : mode === 'set'
                  ? 'Avoid repeated or sequential digits.'
                  : 'Utility is locked.'}
          </Typography>
        </Stack>

        {/* Dots */}
        <Stack
          key={shake}
          direction="row"
          spacing={2}
          sx={{
            animation: shake ? 'shake .4s' : 'none',
            '@keyframes shake': {
              '0%,100%': { transform: 'translateX(0)' },
              '20%,60%': { transform: 'translateX(-7px)' },
              '40%,80%': { transform: 'translateX(7px)' }
            }
          }}
        >
          {[0, 1, 2, 3].map((index) => (
            <Box
              key={index}
              sx={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: 2,
                borderColor: error ? 'error.main' : 'divider',
                bgcolor:
                  index < code.length ? (error ? 'error.main' : 'primary.main') : 'transparent',
                transition: 'background-color 140ms ease, transform 140ms ease',
                transform: index < code.length ? 'scale(1.12)' : 'none'
              }}
            />
          ))}
        </Stack>

        {/* Keypad */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 76px)',
            gap: 1.5,
            justifyContent: 'center'
          }}
        >
          {DIGITS.map((digit, index) =>
            digit === '' ? (
              <Box key={index} />
            ) : (
              <Button
                key={index}
                disabled={lockedFor > 0}
                onClick={() => (digit === '⌫' ? setCode((c) => c.slice(0, -1)) : push(digit))}
                sx={{
                  height: 62,
                  borderRadius: '50%',
                  minWidth: 0,
                  fontSize: 21,
                  fontWeight: 500,
                  color: 'text.primary',
                  bgcolor: 'action.hover',
                  transition: 'transform 110ms ease, background-color 160ms ease',
                  '&:hover': { bgcolor: 'action.selected' },
                  '&:active': { transform: 'scale(.92)' }
                }}
              >
                {digit === '⌫' ? <BackspaceOutlinedIcon fontSize="small" /> : digit}
              </Button>
            )
          )}
        </Box>

        {onCancel && (
          <Fade in>
            <Button size="small" color="inherit" onClick={onCancel}>
              Cancel
            </Button>
          </Fade>
        )}
      </Stack>
    </Box>
  )
}
