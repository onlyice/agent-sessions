// Ensures Electron's binary is fully extracted after install.
//
// Electron's own installer uses `extract-zip`, which on some setups (observed
// with Node 24 on macOS) silently bails after the first file, leaving a broken
// `dist/` and the "Electron failed to install correctly" error. We detect an
// incomplete extraction and redo it with macOS `ditto` (which also preserves
// the .app symlinks/signing). No-op when Electron is already healthy.

import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import fs from 'fs'

const require = createRequire(import.meta.url)

function platformExecPath(platform) {
  switch (platform) {
    case 'darwin':
    case 'mas':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'win32':
      return 'electron.exe'
    default:
      return 'electron'
  }
}

async function main() {
  let electronDir
  try {
    electronDir = dirname(require.resolve('electron/package.json'))
  } catch {
    return // electron not installed (e.g. CI without it) — nothing to do
  }
  const { version } = require(join(electronDir, 'package.json'))
  const platform = process.platform
  const arch = process.arch
  const execRel = platformExecPath(platform)
  const distDir = join(electronDir, 'dist')
  const execPath = join(distDir, execRel)

  if (fs.existsSync(execPath)) return // already healthy

  console.log(`[ensure-electron] dist incomplete, re-extracting electron@${version}…`)

  // @electron/get is in Electron's own dependency scope, so resolve it from there.
  const electronRequire = createRequire(join(electronDir, 'package.json'))
  const { downloadArtifact } = electronRequire('@electron/get')
  const zipPath = await downloadArtifact({ version, artifactName: 'electron', platform, arch })

  fs.rmSync(distDir, { recursive: true, force: true })
  fs.mkdirSync(distDir, { recursive: true })

  if (platform === 'darwin') {
    execFileSync('ditto', ['-x', '-k', zipPath, distDir], { stdio: 'inherit' })
  } else {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', distDir], { stdio: 'inherit' })
  }

  // Mirror electron/install.js: hoist the type defs and write path.txt.
  const typeDef = join(distDir, 'electron.d.ts')
  if (fs.existsSync(typeDef)) fs.renameSync(typeDef, join(electronDir, 'electron.d.ts'))
  fs.writeFileSync(join(electronDir, 'path.txt'), execRel)

  if (!fs.existsSync(execPath)) {
    throw new Error(`[ensure-electron] still missing ${execPath} after re-extraction`)
  }
  console.log('[ensure-electron] electron binary restored ✓')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
