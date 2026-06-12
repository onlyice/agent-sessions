import { useEffect } from 'react'
import { X } from 'lucide-react'
import { THEMES } from '../themes'
import {
  CODE_FONTS,
  UI_FONTS,
  resolveMode,
  type Settings,
  type ThemeMode
} from '../settings'
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
  onClose
}: {
  settings: Settings
  onChange: (s: Settings) => void
  onClose: () => void
}): React.JSX.Element {
  const resolved = resolveMode(settings.mode)

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
