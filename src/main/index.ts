import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { IndexDB } from './db'
import { IndexService } from './index-service'
import { registerIpc } from './ipc'
import { getVaults } from './vaults'

let mainWindow: BrowserWindow | null = null

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
  // Opened (and migrated) here first, so the indexer process only ever meets a
  // schema that is already current.
  const db = new IndexDB(dbPath)
  const indexer = new IndexService(db, dbPath, (progress) =>
    mainWindow?.webContents.send('reindex:progress', progress)
  )
  registerIpc(db, indexer, () => mainWindow)

  createWindow()

  // Build/refresh the index in the background after the window is up.
  mainWindow?.webContents.once('did-finish-load', async () => {
    try {
      console.log('[reindex] done', JSON.stringify(await indexer.run(await getVaults())))
    } catch (err) {
      console.error('[reindex] failed:', err)
    }
  })

  app.on('will-quit', () => indexer.dispose())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
