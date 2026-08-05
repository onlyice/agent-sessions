import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applySettings, loadSettings } from './settings'
import './styles.css'

// Bundle the selectable fonts so the picker works offline.
import '@fontsource/open-sans/400.css'
import '@fontsource/open-sans/500.css'
import '@fontsource/open-sans/600.css'
import '@fontsource/open-sans/700.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/ibm-plex-mono/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/fira-code/400.css'

// Apply persisted theme/fonts before first paint to avoid a flash.
applySettings(loadSettings())

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
