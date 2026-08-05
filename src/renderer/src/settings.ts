import { useEffect, useState } from 'react'
import { CSS_VAR, THEME_BY_ID, THEMES, type ThemeVars } from './themes'

export type ThemeMode = 'light' | 'dark' | 'system'

export interface FontChoice {
  id: string
  label: string
  /** Full font-family stack (the first entry is the named font, rest are fallbacks). */
  stack: string
}

const SANS_FALLBACK = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
const MONO_FALLBACK = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

export const UI_FONTS: FontChoice[] = [
  { id: 'open-sans', label: 'Open Sans', stack: `'Open Sans', ${SANS_FALLBACK}` },
  { id: 'inter', label: 'Inter', stack: `'Inter', ${SANS_FALLBACK}` },
  { id: 'system', label: 'System UI', stack: SANS_FALLBACK }
]

export const CODE_FONTS: FontChoice[] = [
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', stack: `'IBM Plex Mono', ${MONO_FALLBACK}` },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', stack: `'JetBrains Mono', ${MONO_FALLBACK}` },
  { id: 'fira-code', label: 'Fira Code', stack: `'Fira Code', ${MONO_FALLBACK}` },
  { id: 'system', label: 'System Mono', stack: MONO_FALLBACK }
]

export interface Settings {
  themeId: string
  mode: ThemeMode
  uiFontId: string
  codeFontId: string
  reindexIntervalMinutes: number
}

export const DEFAULT_SETTINGS: Settings = {
  themeId: 'default',
  mode: 'system',
  uiFontId: 'open-sans',
  codeFontId: 'ibm-plex-mono',
  reindexIntervalMinutes: 5
}

const STORAGE_KEY = 'agent-session-list.settings'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function save(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* ignore quota / private mode */
  }
}

const prefersDark = (): boolean =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true

/** Resolve a theme mode to a concrete light/dark, consulting the OS for 'system'. */
export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light'
  return mode
}

export function fontStack(list: FontChoice[], id: string): string {
  return (list.find((f) => f.id === id) ?? list[0]).stack
}

/** Push the resolved palette + fonts onto :root so the whole UI updates live. */
export function applySettings(s: Settings): void {
  const theme = THEME_BY_ID.get(s.themeId) ?? THEMES[0]
  const resolved = resolveMode(s.mode)
  const vars: ThemeVars = theme[resolved]
  const root = document.documentElement
  for (const key of Object.keys(CSS_VAR) as (keyof ThemeVars)[]) {
    root.style.setProperty(CSS_VAR[key], vars[key])
  }
  root.style.setProperty('--ui-font', fontStack(UI_FONTS, s.uiFontId))
  root.style.setProperty('--code-font', fontStack(CODE_FONTS, s.codeFontId))
  root.style.colorScheme = resolved
  root.dataset.mode = resolved
}

/**
 * Settings state hook: persists to localStorage, applies to the DOM on every
 * change, and re-applies when the OS appearance flips while in 'system' mode.
 */
export function useSettings(): [Settings, (next: Settings) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings)

  useEffect(() => {
    save(settings)
    applySettings(settings)
  }, [settings])

  useEffect(() => {
    if (settings.mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applySettings(settings)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings])

  return [settings, setSettings]
}
