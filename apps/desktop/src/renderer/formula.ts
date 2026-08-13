/**
 * A small, safe spreadsheet formula evaluator for live preview in the grid.
 *
 * Deliberately NOT eval(): this parses a restricted grammar and supports only
 * an allowlist of functions. Formulas are also written to .xlsx as real
 * formulas, so Excel recalculates them natively -- this evaluator exists so the
 * operator sees the value while editing, not as the source of truth.
 *
 * Money in this application is Decimal in the Python core. These previews use
 * JS numbers and are display-only; nothing computed here reaches a register.
 */

export type CellGrid = string[][]

const A1 = /^\$?([A-Z]+)\$?(\d+)$/i

export function columnToIndex(letters: string): number {
  let n = 0
  for (const character of letters.toUpperCase()) {
    n = n * 26 + (character.charCodeAt(0) - 64)
  }
  return n - 1
}

export function indexToColumn(index: number): string {
  let label = ''
  let n = index
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

export function isFormula(value: string | undefined): boolean {
  return typeof value === 'string' && value.trimStart().startsWith('=')
}

function cellValue(grid: CellGrid, ref: string, depth: number): number {
  const match = A1.exec(ref.trim())
  if (!match) return NaN
  const row = Number(match[2]) - 1
  const column = columnToIndex(match[1]!)
  const raw = grid[row]?.[column] ?? ''
  if (isFormula(raw)) return evaluate(raw, grid, depth + 1)
  const cleaned = raw.replace(/,/g, '').trim()
  return cleaned === '' ? 0 : Number(cleaned)
}

function expandRange(grid: CellGrid, from: string, to: string, depth: number): number[] {
  const a = A1.exec(from.trim())
  const b = A1.exec(to.trim())
  if (!a || !b) return []
  const r1 = Number(a[2]) - 1
  const r2 = Number(b[2]) - 1
  const c1 = columnToIndex(a[1]!)
  const c2 = columnToIndex(b[1]!)
  const values: number[] = []
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      const raw = grid[r]?.[c] ?? ''
      if (raw === '') continue
      values.push(isFormula(raw) ? evaluate(raw, grid, depth + 1) : Number(raw.replace(/,/g, '')))
    }
  }
  return values
}

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  SUM: (a) => a.reduce((x, y) => x + y, 0),
  AVERAGE: (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0),
  MIN: (a) => (a.length ? Math.min(...a) : 0),
  MAX: (a) => (a.length ? Math.max(...a) : 0),
  COUNT: (a) => a.filter((n) => !Number.isNaN(n)).length,
  ROUND: (a) => {
    const [value = 0, places = 0] = a
    const factor = 10 ** places
    // Half-up, matching the register's convention rather than JS's half-even drift.
    return Math.sign(value) * Math.round(Math.abs(value) * factor + Number.EPSILON) / factor
  },
  ABS: (a) => Math.abs(a[0] ?? 0),
  PRODUCT: (a) => a.reduce((x, y) => x * y, 1)
}

export const SUPPORTED_FUNCTIONS = Object.keys(FUNCTIONS)

const MAX_DEPTH = 24

/** Tokenise + evaluate a restricted arithmetic grammar. Returns NaN on anything invalid. */
export function evaluate(input: string, grid: CellGrid, depth = 0): number {
  if (depth > MAX_DEPTH) return NaN // circular reference guard
  const source = input.trimStart().replace(/^=/, '')
  let position = 0

  const skip = (): void => {
    while (position < source.length && /\s/.test(source[position]!)) position++
  }

  function parseExpression(): number {
    let value = parseTerm()
    for (;;) {
      skip()
      const operator = source[position]
      if (operator === '+' || operator === '-') {
        position++
        const right = parseTerm()
        value = operator === '+' ? value + right : value - right
      } else {
        return value
      }
    }
  }

  function parseTerm(): number {
    let value = parseFactor()
    for (;;) {
      skip()
      const operator = source[position]
      if (operator === '*' || operator === '/') {
        position++
        const right = parseFactor()
        value = operator === '*' ? value * right : right === 0 ? NaN : value / right
      } else {
        return value
      }
    }
  }

  function parseFactor(): number {
    skip()
    if (source[position] === '-') {
      position++
      return -parseFactor()
    }
    if (source[position] === '+') {
      position++
      return parseFactor()
    }
    if (source[position] === '(') {
      position++
      const value = parseExpression()
      skip()
      if (source[position] === ')') position++
      return value
    }

    // number
    const number = /^\d+(\.\d+)?/.exec(source.slice(position))
    if (number) {
      position += number[0].length
      return Number(number[0])
    }

    // identifier: function call or cell reference / range
    const identifier = /^[A-Za-z]+\$?\d*/.exec(source.slice(position))
    if (!identifier) return NaN
    const token = identifier[0]
    position += token.length
    skip()

    if (source[position] === '(') {
      const name = token.toUpperCase()
      const fn = FUNCTIONS[name]
      position++
      const args: number[] = []
      for (;;) {
        skip()
        if (source[position] === ')') {
          position++
          break
        }
        // range argument?
        const range = /^(\$?[A-Za-z]+\$?\d+)\s*:\s*(\$?[A-Za-z]+\$?\d+)/.exec(source.slice(position))
        if (range) {
          position += range[0].length
          args.push(...expandRange(grid, range[1]!, range[2]!, depth))
        } else {
          args.push(parseExpression())
        }
        skip()
        if (source[position] === ',' || source[position] === ';') position++
        else if (source[position] === ')') {
          position++
          break
        } else if (position >= source.length) break
      }
      return fn ? fn(args.filter((n) => !Number.isNaN(n))) : NaN
    }

    // plain cell reference
    return cellValue(grid, token, depth)
  }

  const result = parseExpression()
  return Number.isFinite(result) ? result : NaN
}

/** What the grid should display for a cell: formulas resolve, everything else is literal. */
export function displayValue(raw: string | undefined, grid: CellGrid): string {
  if (!isFormula(raw)) return raw ?? ''
  const value = evaluate(raw!, grid)
  if (Number.isNaN(value)) return '#ERROR'
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(10))) // trim float noise without lying about precision
}
