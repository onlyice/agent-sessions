// Built-in color palettes. Each theme ships both a light and a dark variant so
// it works under any theme mode (light / dark / follow-system). Values are the
// canonical colors from each upstream theme, adapted to this app's variable set.

export interface ThemeVars {
  bg: string
  bgSide: string
  bgElev: string
  bgHover: string
  border: string
  text: string
  textDim: string
  textFaint: string
  accent: string
  /** Text color drawn on top of the accent color (buttons, badges). */
  onAccent: string
  mark: string
  markText: string
  codeBg: string
  link: string
  scrollbar: string
  scrollbarHover: string
}

export interface Theme {
  id: string
  name: string
  light: ThemeVars
  dark: ThemeVars
}

/** Maps a ThemeVars key to its CSS custom property name. */
export const CSS_VAR: Record<keyof ThemeVars, string> = {
  bg: '--bg',
  bgSide: '--bg-side',
  bgElev: '--bg-elev',
  bgHover: '--bg-hover',
  border: '--border',
  text: '--text',
  textDim: '--text-dim',
  textFaint: '--text-faint',
  accent: '--accent',
  onAccent: '--on-accent',
  mark: '--mark',
  markText: '--mark-text',
  codeBg: '--code-bg',
  link: '--link',
  scrollbar: '--scrollbar',
  scrollbarHover: '--scrollbar-hover'
}

export const THEMES: Theme[] = [
  {
    id: 'default',
    name: 'Default',
    dark: {
      bg: '#202020', bgSide: '#1c1c1c', bgElev: '#292929', bgHover: '#303030',
      border: '#383838', text: '#e8e6e3', textDim: '#9a9690', textFaint: '#6b6862',
      accent: '#d97757', onAccent: '#1a1a1a', mark: '#f5d76e', markText: '#1a1a1a',
      codeBg: '#262626', link: '#6cb6ff', scrollbar: '#404040', scrollbarHover: '#4d4d4d'
    },
    light: {
      bg: '#ffffff', bgSide: '#f7f6f4', bgElev: '#f0eeea', bgHover: '#e8e6e1',
      border: '#e2dfd9', text: '#2b2926', textDim: '#6b6862', textFaint: '#9a9690',
      accent: '#c2410c', onAccent: '#ffffff', mark: '#ffe08a', markText: '#2b2926',
      codeBg: '#f3f1ec', link: '#0969da', scrollbar: '#d4d0c8', scrollbarHover: '#b8b4ac'
    }
  },
  {
    id: 'github',
    name: 'GitHub',
    dark: {
      bg: '#0d1117', bgSide: '#010409', bgElev: '#161b22', bgHover: '#21262d',
      border: '#30363d', text: '#c9d1d9', textDim: '#8b949e', textFaint: '#6e7681',
      accent: '#2f81f7', onAccent: '#ffffff', mark: '#bb8009', markText: '#ffffff',
      codeBg: '#161b22', link: '#58a6ff', scrollbar: '#30363d', scrollbarHover: '#484f58'
    },
    light: {
      bg: '#ffffff', bgSide: '#f6f8fa', bgElev: '#f6f8fa', bgHover: '#eaeef2',
      border: '#d0d7de', text: '#1f2328', textDim: '#656d76', textFaint: '#8c959f',
      accent: '#0969da', onAccent: '#ffffff', mark: '#fff8c5', markText: '#1f2328',
      codeBg: '#f6f8fa', link: '#0969da', scrollbar: '#d0d7de', scrollbarHover: '#afb8c1'
    }
  },
  {
    id: 'one',
    name: 'One',
    dark: {
      bg: '#282c34', bgSide: '#21252b', bgElev: '#2c313a', bgHover: '#323842',
      border: '#3b4048', text: '#abb2bf', textDim: '#828997', textFaint: '#5c6370',
      accent: '#61afef', onAccent: '#282c34', mark: '#e5c07b', markText: '#282c34',
      codeBg: '#2c313a', link: '#61afef', scrollbar: '#4b5263', scrollbarHover: '#5c6370'
    },
    light: {
      bg: '#fafafa', bgSide: '#f0f0f1', bgElev: '#eaeaeb', bgHover: '#e5e5e6',
      border: '#d4d4d6', text: '#383a42', textDim: '#696c77', textFaint: '#a0a1a7',
      accent: '#4078f2', onAccent: '#ffffff', mark: '#c18401', markText: '#ffffff',
      codeBg: '#eaeaeb', link: '#4078f2', scrollbar: '#c8c8ca', scrollbarHover: '#a0a1a7'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: {
      bg: '#282a36', bgSide: '#21222c', bgElev: '#343746', bgHover: '#3c3f51',
      border: '#44475a', text: '#f8f8f2', textDim: '#bdbecb', textFaint: '#6272a4',
      accent: '#bd93f9', onAccent: '#282a36', mark: '#f1fa8c', markText: '#282a36',
      codeBg: '#343746', link: '#8be9fd', scrollbar: '#44475a', scrollbarHover: '#6272a4'
    },
    light: {
      bg: '#fffbeb', bgSide: '#f5f1e3', bgElev: '#efe9d3', bgHover: '#e8e2ca',
      border: '#ddd6bd', text: '#1f1f1f', textDim: '#635d49', textFaint: '#8c876f',
      accent: '#7b3fbf', onAccent: '#ffffff', mark: '#cfc137', markText: '#1f1f1f',
      codeBg: '#efe9d3', link: '#036a96', scrollbar: '#ddd6bd', scrollbarHover: '#c5bd9f'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: {
      bg: '#2e3440', bgSide: '#272b35', bgElev: '#3b4252', bgHover: '#434c5e',
      border: '#434c5e', text: '#eceff4', textDim: '#d8dee9', textFaint: '#7b88a1',
      accent: '#88c0d0', onAccent: '#2e3440', mark: '#ebcb8b', markText: '#2e3440',
      codeBg: '#3b4252', link: '#81a1c1', scrollbar: '#4c566a', scrollbarHover: '#616e88'
    },
    light: {
      bg: '#eceff4', bgSide: '#e5e9f0', bgElev: '#dfe4ee', bgHover: '#d8dee9',
      border: '#d8dee9', text: '#2e3440', textDim: '#4c566a', textFaint: '#7b88a1',
      accent: '#5e81ac', onAccent: '#ffffff', mark: '#ebcb8b', markText: '#2e3440',
      codeBg: '#e5e9f0', link: '#5e81ac', scrollbar: '#c2cad8', scrollbarHover: '#a9b4c8'
    }
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    dark: {
      bg: '#1a1b26', bgSide: '#16161e', bgElev: '#1f2335', bgHover: '#24283b',
      border: '#2f3549', text: '#c0caf5', textDim: '#9aa5ce', textFaint: '#565f89',
      accent: '#7aa2f7', onAccent: '#1a1b26', mark: '#e0af68', markText: '#1a1b26',
      codeBg: '#1f2335', link: '#7dcfff', scrollbar: '#2f3549', scrollbarHover: '#414868'
    },
    light: {
      bg: '#e1e2e7', bgSide: '#d6d8df', bgElev: '#cdcfd6', bgHover: '#c4c6cd',
      border: '#b3b5bf', text: '#343b58', textDim: '#6172b0', textFaint: '#848cb5',
      accent: '#2e7de9', onAccent: '#ffffff', mark: '#8c6c3e', markText: '#ffffff',
      codeBg: '#cdcfd6', link: '#007197', scrollbar: '#b3b5bf', scrollbarHover: '#9da0ad'
    }
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    dark: {
      bg: '#1e1e2e', bgSide: '#181825', bgElev: '#313244', bgHover: '#45475a',
      border: '#45475a', text: '#cdd6f4', textDim: '#a6adc8', textFaint: '#7f849c',
      accent: '#cba6f7', onAccent: '#1e1e2e', mark: '#f9e2af', markText: '#1e1e2e',
      codeBg: '#313244', link: '#89b4fa', scrollbar: '#45475a', scrollbarHover: '#585b70'
    },
    light: {
      bg: '#eff1f5', bgSide: '#e6e9ef', bgElev: '#dce0e8', bgHover: '#ccd0da',
      border: '#ccd0da', text: '#4c4f69', textDim: '#6c6f85', textFaint: '#8c8fa1',
      accent: '#8839ef', onAccent: '#ffffff', mark: '#df8e1d', markText: '#ffffff',
      codeBg: '#dce0e8', link: '#1e66f5', scrollbar: '#bcc0cc', scrollbarHover: '#acb0be'
    }
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    dark: {
      bg: '#282828', bgSide: '#1d2021', bgElev: '#32302f', bgHover: '#3c3836',
      border: '#504945', text: '#ebdbb2', textDim: '#bdae93', textFaint: '#928374',
      accent: '#fe8019', onAccent: '#282828', mark: '#fabd2f', markText: '#282828',
      codeBg: '#32302f', link: '#83a598', scrollbar: '#504945', scrollbarHover: '#665c54'
    },
    light: {
      bg: '#fbf1c7', bgSide: '#f2e5bc', bgElev: '#ebdbb2', bgHover: '#e3d4a7',
      border: '#d5c4a1', text: '#3c3836', textDim: '#665c54', textFaint: '#928374',
      accent: '#af3a03', onAccent: '#fbf1c7', mark: '#b57614', markText: '#fbf1c7',
      codeBg: '#ebdbb2', link: '#076678', scrollbar: '#d5c4a1', scrollbarHover: '#bdae93'
    }
  }
]

export const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]))
