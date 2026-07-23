import { useEffect, useState } from 'react'
import { Check, FolderPlus, Trash2, X } from 'lucide-react'
import { THEMES } from '../themes'
import {
  CODE_FONTS,
  UI_FONTS,
  resolveMode,
  type Settings,
  type ThemeMode
} from '../settings'
import type { Vault } from '../types'
import { Markdown } from './Markdown'

const MODES: { id: ThemeMode; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' }
]

const SAMPLE = `### Markdown preview
Renders **bold**, *italic*, \`inline code\` and lists:

- First item
- Second item

\`\`\`ts
const greet = (name: string) => \`Hello, \${name}\`
\`\`\``

export function Settings({
  settings,
  onChange,
  onClose,
  vaults,
  activeVaultId,
  onPickVaultDir,
  onAddVault,
  onRemoveVault,
  onSwitchVault
}: {
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
  vaults: Vault[]
  activeVaultId: string
  onPickVaultDir: () => Promise<{
    home?: string
    suggestedName?: string
    error?: string
    canceled?: boolean
  }>
  onAddVault: (home: string, name: string) => Promise<string | null>
  onRemoveVault: (id: string) => Promise<void>
  onSwitchVault: (id: string) => Promise<void>
}): React.JSX.Element {
  const resolved = resolveMode(settings.mode)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // After a directory is picked, hold it here so the user can name the vault.
  const [pending, setPending] = useState<{ home: string } | null>(null)
  const [pendingName, setPendingName] = useState('')

  const handlePick = async (): Promise<void> => {
    setVaultError(null)
    setBusy(true)
    try {
      const res = await onPickVaultDir()
      if (res.canceled) return
      if (res.error) {
        setVaultError(res.error)
        return
      }
      if (res.home) {
        setPending({ home: res.home })
        setPendingName(res.suggestedName ?? '')
      }
    } finally {
      setBusy(false)
    }
  }

  const cancelAdd = (): void => {
    setPending(null)
    setPendingName('')
    setVaultError(null)
  }

  const confirmAdd = async (): Promise<void> => {
    if (!pending || !pendingName.trim()) return
    setVaultError(null)
    setBusy(true)
    try {
      const err = await onAddVault(pending.home, pendingName)
      if (err) {
        setVaultError(err)
        return
      }
      cancelAdd()
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </header>

        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-label-row">
              <label className="settings-label">Vaults</label>
              <button
                className="vault-add-btn"
                onClick={handlePick}
                disabled={busy || pending !== null}
              >
                <FolderPlus size={15} />
                Add vault…
              </button>
            </div>
            <p className="settings-hint">
              A vault is a home directory the transcripts are read from (containing
              <code> .claude</code>, <code>.codex</code>, <code>.local/share/opencode</code>…). Only one
              vault is shown at a time.
            </p>
            {vaultError && <div className="vault-error">{vaultError}</div>}
            {pending && (
              <div className="vault-add-form">
                <div className="vault-add-path" title={pending.home}>
                  {pending.home}
                </div>
                <div className="vault-add-row">
                  <input
                    className="vault-name-input"
                    value={pendingName}
                    autoFocus
                    placeholder="Vault name"
                    onChange={(e) => setPendingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void confirmAdd()
                      if (e.key === 'Escape') {
                        e.stopPropagation() // don't let it close the settings panel
                        cancelAdd()
                      }
                    }}
                  />
                  <button
                    className="vault-form-btn primary"
                    onClick={() => void confirmAdd()}
                    disabled={busy || !pendingName.trim()}
                  >
                    Add
                  </button>
                  <button className="vault-form-btn" onClick={cancelAdd} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <div className="vault-list">
              {vaults.map((v) => (
                <div
                  key={v.id}
                  className={`vault-row ${v.id === activeVaultId ? 'active' : ''}`}
                >
                  <button
                    className="vault-row-main"
                    onClick={() => void onSwitchVault(v.id)}
                    title={v.id === activeVaultId ? 'Current vault' : 'Switch to this vault'}
                  >
                    <span className="vault-row-check">
                      {v.id === activeVaultId && <Check size={15} />}
                    </span>
                    <span className="vault-row-body">
                      <span className="vault-row-name">{v.name}</span>
                      <span className="vault-row-path">{v.home}</span>
                    </span>
                  </button>
                  {v.removable ? (
                    <button
                      className="vault-row-remove"
                      onClick={() => void onRemoveVault(v.id)}
                      title="Remove vault"
                    >
                      <Trash2 size={15} />
                    </button>
                  ) : (
                    <span className="vault-row-badge">built-in</span>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <label className="settings-label">Appearance</label>
            <div className="seg">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={`seg-btn ${settings.mode === m.id ? 'on' : ''}`}
                  onClick={() => onChange({ ...settings, mode: m.id })}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <label className="settings-label">Theme</label>
            <div className="theme-grid">
              {THEMES.map((t) => {
                const v = t[resolved]
                const active = settings.themeId === t.id
                return (
                  <button
                    key={t.id}
                    className={`theme-card ${active ? 'on' : ''}`}
                    onClick={() => onChange({ ...settings, themeId: t.id })}
                  >
                    <div className="theme-swatch" style={{ background: v.bg, borderColor: v.border }}>
                      <span className="sw" style={{ background: v.accent }} />
                      <span className="sw" style={{ background: v.text }} />
                      <span className="sw" style={{ background: v.bgElev }} />
                      <span className="sw" style={{ background: v.mark }} />
                    </div>
                    <span className="theme-name">{t.name}</span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="settings-section settings-fonts">
            <div>
              <label className="settings-label">UI Font</label>
              <select
                className="settings-select"
                value={settings.uiFontId}
                onChange={(e) => onChange({ ...settings, uiFontId: e.target.value })}
              >
                {UI_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="settings-label">Code Font</label>
              <select
                className="settings-select"
                value={settings.codeFontId}
                onChange={(e) => onChange({ ...settings, codeFontId: e.target.value })}
              >
                {CODE_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          </section>

          <section className="settings-section">
            <label className="settings-label" htmlFor="reindex-interval">
              Reindex Interval
            </label>
            <div className="settings-number-row">
              <input
                id="reindex-interval"
                className="settings-number"
                type="number"
                min={1}
                max={1440}
                step={1}
                value={settings.reindexIntervalMinutes}
                onChange={(e) => {
                  const minutes = Math.min(Math.max(Number(e.target.value) || 1, 1), 1440)
                  onChange({ ...settings, reindexIntervalMinutes: minutes })
                }}
              />
              <span className="settings-unit">minutes after the previous index</span>
            </div>
          </section>

          <section className="settings-section">
            <label className="settings-label">Preview</label>
            <div className="settings-preview">
              <Markdown text={SAMPLE} />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
