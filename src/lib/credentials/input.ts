import {createInterface} from 'node:readline'

import {CredentialError} from './errors.js'

/**
 * Prompt for a secret value with no terminal echo.
 * Falls back to reading stdin directly if not interactive (piped input).
 */
export async function readSecretInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Non-interactive: read a single line from stdin (for piped input)
    return readStdinLine()
  }

  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    // Disable echo by writing the prompt manually and muting output
    process.stdout.write(prompt)
    const stdin = process.stdin as NodeJS.ReadStream
    const wasRawMode = stdin.isRaw
    stdin.setRawMode(true)

    let secret = ''
    const onData = (data: Buffer) => {
      const char = data.toString('utf8')

      // Enter key
      if (char === '\n' || char === '\r') {
        stdin.setRawMode(wasRawMode ?? false)
        stdin.removeListener('data', onData)
        process.stdout.write('\n')
        rl.close()
        resolve(secret.trim())
        return
      }

      // Ctrl+C
      if (char === '\u0003') {
        stdin.setRawMode(wasRawMode ?? false)
        stdin.removeListener('data', onData)
        process.stdout.write('\n')
        rl.close()
        reject(
          new CredentialError(
            'input-failure',
            'Key input cancelled',
            'Run the command again to retry.',
          ),
        )
        return
      }

      // Backspace/Delete
      if (char === '\u007F' || char === '\b') {
        if (secret.length > 0) {
          secret = secret.slice(0, -1)
        }

        return
      }

      secret += char
    }

    stdin.on('data', onData)
  })
}

async function readStdinLine(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({input: process.stdin})
    let resolved = false
    rl.on('line', (line) => {
      if (!resolved) {
        resolved = true
        rl.close()
        resolve(line.trim())
      }
    })
    rl.on('close', () => {
      if (!resolved) {
        reject(
          new CredentialError(
            'input-failure',
            'No input received on stdin',
            'Provide a key via stdin pipe or run interactively.',
          ),
        )
      }
    })
  })
}
