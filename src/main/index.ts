import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { IndexDB } from './db'
import { registerIpc } from './ipc'
import { reindex } from './indexer'
import { getVaults } from './vaults'
import { ensureUserPath } from './user-path'

let mainWindow: BrowserWindow | null = null
let db: IndexDB | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const dbPath = join(app.getPath('userData'), 'index.db')
  db = new IndexDB(dbPath)
  registerIpc(db, () => mainWindow)

  createWindow()

  // Build/refresh the index in the background after the window is up.
  mainWindow?.webContents.once('did-finish-load', async () => {
    try {
      // Agent CLIs live outside launchd's PATH; resolve the user's real one
      // before any collector shells out (see user-path.ts).
      await ensureUserPath()
      const stats = await reindex(db!, await getVaults(), (p) =>
        mainWindow?.webContents.send('reindex:progress', p)
      )
      console.log('[reindex] done', JSON.stringify(stats))
    } catch (err) {
      console.error('[reindex] failed:', err)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
