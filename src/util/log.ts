/**
 * Terminal output. Colour is opt-out via NO_COLOR and auto-off when stdout is
 * not a TTY, so piping `openhog check` into a file or a CI log stays readable.
 */

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout.isTTY)

function wrap(open: string, close: string) {
  return (text: string): string => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text)
}

export const color = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  grey: wrap('90', '39'),
}

let quiet = false
export function setQuiet(value: boolean): void {
  quiet = value
}

export const log = {
  /** Section heading. */
  title(text: string): void {
    if (quiet) return
    process.stdout.write(`\n${color.bold(text)}\n`)
  },
  step(text: string): void {
    if (quiet) return
    process.stdout.write(`${color.cyan('›')} ${text}\n`)
  },
  ok(text: string): void {
    if (quiet) return
    process.stdout.write(`${color.green('✓')} ${text}\n`)
  },
  warn(text: string): void {
    if (quiet) return
    process.stdout.write(`${color.yellow('!')} ${text}\n`)
  },
  fail(text: string): void {
    process.stderr.write(`${color.red('✗')} ${text}\n`)
  },
  info(text: string): void {
    if (quiet) return
    process.stdout.write(`  ${color.grey(text)}\n`)
  },
  plain(text = ''): void {
    if (quiet) return
    process.stdout.write(`${text}\n`)
  },
}

/** A tiny spinner that degrades to a single line when stdout is not a TTY. */
export function spinner(label: string) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  if (quiet) {
    return { update() {}, stop() {} }
  }
  if (!process.stdout.isTTY) {
    process.stdout.write(`${color.cyan('›')} ${label}\n`)
    return { update() {}, stop() {} }
  }
  let index = 0
  let current = label
  const render = () => {
    process.stdout.write(`\r${color.cyan(frames[index % frames.length]!)} ${current}\u001b[K`)
    index += 1
  }
  render()
  const timer = setInterval(render, 80)
  timer.unref?.()
  return {
    update(next: string) {
      current = next
    },
    stop(final?: string) {
      clearInterval(timer)
      process.stdout.write(`\r\u001b[K`)
      if (final) process.stdout.write(`${final}\n`)
    },
  }
}

/** Left-pads a table so `openhog check` output lines up. */
export function table(rows: [string, string][], gap = 2): string {
  const width = rows.reduce((max, [left]) => Math.max(max, stripAnsi(left).length), 0)
  return rows
    .map(([left, right]) => `${left}${' '.repeat(width - stripAnsi(left).length + gap)}${right}`)
    .join('\n')
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}
