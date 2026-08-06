import { execFile } from 'child_process'
import { access, constants } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, join } from 'path'

/**
 * A GUI app launched from Finder/Dock inherits launchd's minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so agent CLIs installed under `~/.local/bin`,
 * Homebrew or a version manager are invisible to `execFile`. Everything works in
 * `electron-vite dev` — the terminal's PATH is inherited — and then fails only in
 * the packaged app, which is exactly how the Amp cloud listing silently died.
 *
 * Resolve the user's real PATH once from a login shell and merge it into this
 * process, so every child process (now and later) can find their tools.
 */

const MARKER = '__AGENT_SESSIONS_PATH__'

/** Common install locations, used when the login shell can't be probed. */
const FALLBACK_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'bin'),
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.cargo', 'bin'),
  join(homedir(), 'go', 'bin'),
  join(homedir(), '.local', 'share', 'mise', 'shims'),
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin'
]

/** Ask the user's login shell for its PATH. Returns '' when unavailable. */
function probeLoginShellPath(): Promise<string> {
  const shell = process.env.SHELL
  if (!shell || process.platform === 'win32') return Promise.resolve('')
  return new Promise((resolve) => {
    // -i so rc files that extend PATH (the common case for zsh) are sourced.
    // Startup output from those rc files is tolerated: the marker delimits ours.
    execFile(
      shell,
      ['-ilc', `printf '%s%s' '${MARKER}' "$PATH"`],
      { encoding: 'utf8', timeout: 5_000, env: { ...process.env, TERM: 'dumb' } },
      (error, stdout) => {
        if (!stdout) {
          if (error) console.error('[path] login shell probe failed:', error.message)
          return resolve('')
        }
        const at = stdout.lastIndexOf(MARKER)
        resolve(at < 0 ? '' : (stdout.slice(at + MARKER.length).split('\n')[0] ?? '').trim())
      }
    )
  })
}

let hydration: Promise<void> | null = null

/**
 * Merge the login shell's PATH (and well-known bin directories) into
 * `process.env.PATH`. Idempotent and safe to await from anywhere.
 */
export function ensureUserPath(): Promise<void> {
  hydration ??= (async () => {
    const dirs: string[] = []
    const add = (dir: string): void => {
      if (dir && !dirs.includes(dir)) dirs.push(dir)
    }
    // Shell order first: it reflects the precedence the user actually expects.
    for (const dir of (await probeLoginShellPath()).split(delimiter)) add(dir)
    for (const dir of (process.env.PATH ?? '').split(delimiter)) add(dir)
    for (const dir of FALLBACK_DIRS) add(dir)
    process.env.PATH = dirs.join(delimiter)
  })()
  return hydration
}

const binaries = new Map<string, Promise<string>>()

/**
 * Resolve an executable to an absolute path, hydrating PATH first. Memoized per
 * name; a failed lookup is forgotten so installing the tool later still works.
 */
export function resolveBin(name: string): Promise<string> {
  let pending = binaries.get(name)
  if (!pending) {
    pending = (async () => {
      await ensureUserPath()
      const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
      for (const dir of dirs) {
        const candidate = join(dir, name)
        try {
          await access(candidate, constants.X_OK)
          return candidate
        } catch {
          // Not here — keep walking PATH.
        }
      }
      throw new Error(`'${name}' not found in PATH (searched ${dirs.length} directories)`)
    })()
    pending.catch(() => binaries.delete(name))
    binaries.set(name, pending)
  }
  return pending
}
