import { execFile } from 'child_process'
import type { AgentType, SessionMeta } from './types'

/** Single-quote a string for safe use in a POSIX shell command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Build the shell command that resumes a given session in its agent. */
export function buildResumeCommand(meta: Pick<SessionMeta, 'agent' | 'nativeId' | 'cwd'>): string {
  const { agent, nativeId, cwd } = meta
  const id = shq(nativeId)
  let cmd: string
  switch (agent as AgentType) {
    case 'claude':
      cmd = `claude --resume ${id}`
      break
    case 'codex':
      cmd = `codex resume ${id}`
      break
    case 'opencode':
      cmd = `opencode --session ${id}`
      break
    case 'amp':
      cmd = `amp threads continue ${id}`
      break
    case 'pi':
      cmd = `pi --session ${id}`
      break
    default:
      cmd = `echo "unknown agent: ${agent}"`
  }
  return cwd ? `cd ${shq(cwd)} && ${cmd}` : cmd
}

// AppleScript: focus Ghostty, open a new tab (Cmd+T), type the command, hit Enter.
// Reads the command from argv so we never string-interpolate untrusted text.
const SCRIPT = `
on run argv
  set cmdText to item 1 of argv
  tell application "Ghostty" to activate
  delay 0.45
  tell application "System Events"
    tell process "Ghostty"
      keystroke "t" using command down
      delay 0.4
      keystroke cmdText
      key code 36
    end tell
  end tell
end run
`

/**
 * Open a new tab in the running Ghostty and run the resume command.
 * Requires macOS Accessibility permission for the controlling process.
 */
export function resumeInGhostty(
  meta: Pick<SessionMeta, 'agent' | 'nativeId' | 'cwd'>
): Promise<{ ok: boolean; command: string; error?: string }> {
  const command = buildResumeCommand(meta)
  return new Promise((resolve) => {
    execFile('osascript', ['-e', SCRIPT, command], { timeout: 15000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, command, error: stderr?.trim() || err.message })
      } else {
        resolve({ ok: true, command })
      }
    })
  })
}
