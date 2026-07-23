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
  onAddVault,
  onRemoveVault,
  onSwitchVault
}: {
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
  vaults: Vault[]
  activeVaultId: string
  onAddVault: () => Promise<string | null>
  onRemoveVault: (id: string) => Promise<void>
  onSwitchVault: (id: string) => Promise<void>
}): React.JSX.Element {
  const resolved = resolveMode(settings.mode)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const handleAdd = async (): Promise<void> => {
    setVaultError(null)
    setAdding(true)
    try {
      const err = await onAddVault()
      if (err) setVaultError(err)
    } finally {
      setAdding(false)
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
              <button className="vault-add-btn" onClick={handleAdd} disabled={adding}>
                <FolderPlus size={15} />
                {adding ? 'Adding…' : 'Add vault…'}
              </button>
            </div>
            <p className="settings-hint">
              A vault is a home directory the transcripts are read from (containing
              <code> .claude</code>, <code>.codex</code>, <code>.local/share/opencode</code>…). Only one
              vault is shown at a time.
            </p>
            {vaultError && <div className="vault-error">{vaultError}</div>}
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
