/**
 * Interactive prompts over node:readline, with one rule: every prompt has a
 * default and every prompt is skippable. `openhog init --yes` has to be able to
 * run to completion inside a CI job or an agent with no TTY at all, so a
 * missing stdin is a valid answer (the default), never a hang.
 */

import { createInterface } from 'node:readline'
import { color } from './log.js'

let assumeYes = false

export function setAssumeYes(value: boolean): void {
  assumeYes = value
}

export function isNonInteractive(): boolean {
  return assumeYes || !process.stdin.isTTY
}

async function ask(question: string, mask = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (mask) {
      // Swallow echo so a pasted API key does not land in the scrollback.
      const output = rl as unknown as { output?: NodeJS.WriteStream; _writeToOutput?: unknown }
      output._writeToOutput = function writeMasked(this: { output: NodeJS.WriteStream }, value: string) {
        if (value.includes(question)) this.output.write(question)
        else this.output.write('*')
      }
    }
    rl.question(question, (answer) => {
      rl.close()
      if (mask) process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

export async function text(
  question: string,
  defaultValue = '',
  options: { mask?: boolean } = {},
): Promise<string> {
  if (isNonInteractive()) return defaultValue
  const suffix = defaultValue && !options.mask ? color.grey(` (${defaultValue})`) : ''
  const answer = await ask(`${color.cyan('?')} ${question}${suffix} `, options.mask)
  return answer || defaultValue
}

export async function confirm(question: string, defaultValue = true): Promise<boolean> {
  if (isNonInteractive()) return defaultValue
  const hint = defaultValue ? 'Y/n' : 'y/N'
  const answer = await ask(`${color.cyan('?')} ${question} ${color.grey(`(${hint})`)} `)
  if (!answer) return defaultValue
  return /^y(es)?$/i.test(answer)
}

export async function select<T extends string>(
  question: string,
  choices: { value: T; label: string; hint?: string }[],
  defaultValue: T,
): Promise<T> {
  if (isNonInteractive()) return defaultValue
  process.stdout.write(`${color.cyan('?')} ${question}\n`)
  choices.forEach((choice, index) => {
    const marker = choice.value === defaultValue ? color.green('●') : color.grey('○')
    const hint = choice.hint ? color.grey(` — ${choice.hint}`) : ''
    process.stdout.write(`  ${marker} ${color.bold(String(index + 1))}. ${choice.label}${hint}\n`)
  })
  const answer = await ask(
    `  ${color.grey(`1-${choices.length}, blank for ${defaultValue}`)} `,
  )
  if (!answer) return defaultValue
  const index = Number.parseInt(answer, 10) - 1
  return choices[index]?.value ?? defaultValue
}

export async function multiSelect<T extends string>(
  question: string,
  choices: { value: T; label: string; hint?: string }[],
  defaultValues: T[],
): Promise<T[]> {
  if (isNonInteractive()) return defaultValues
  process.stdout.write(`${color.cyan('?')} ${question}\n`)
  choices.forEach((choice, index) => {
    const marker = defaultValues.includes(choice.value) ? color.green('◉') : color.grey('◯')
    const hint = choice.hint ? color.grey(` — ${choice.hint}`) : ''
    process.stdout.write(`  ${marker} ${color.bold(String(index + 1))}. ${choice.label}${hint}\n`)
  })
  const answer = await ask(
    `  ${color.grey('comma-separated numbers, blank to keep the selection')} `,
  )
  if (!answer) return defaultValues
  const picked = answer
    .split(',')
    .map((part) => choices[Number.parseInt(part.trim(), 10) - 1]?.value)
    .filter((value): value is T => Boolean(value))
  return picked.length ? picked : defaultValues
}
