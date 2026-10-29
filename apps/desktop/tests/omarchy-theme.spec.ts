import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import {
  DesktopOmarchyTheme, omarchyCurrentDirectory, omarchyThemeCss, parseOmarchyColors, readOmarchyTheme,
} from '../src/omarchy-theme.ts'

const TOKYO_NIGHT = `mode = "dark"
accent = "#7aa2f7"
selection = "#292e42"
background = "#1a1b26"
darker_background = "#0e0e14"
lighter_background = "#24283b"
foreground = "#a9b1d6"
bright_foreground = "#c0caf5"
red = "#f7768e"
yellow = "#e0af68"
green = "#9ece6a"
blue = "#7aa2f7"
magenta = "#ad8ee6"
`

const directories: string[] = []

function themeRoot(colors?: string, name?: string): string {
  const current = mkdtempSync(join(tmpdir(), 'omarchy-'))
  directories.push(current)
  if (colors !== undefined) {
    mkdirSync(join(current, 'theme'))
    writeFileSync(join(current, 'theme', 'colors.toml'), colors)
  }
  if (name !== undefined) writeFileSync(join(current, 'theme.name'), `${name}\n`)
  return current
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

it('locates the Omarchy 4 state directory', () => {
  expect(omarchyCurrentDirectory({}, '/home/u')).toBe('/home/u/.local/state/omarchy/current')
  expect(omarchyCurrentDirectory({ XDG_STATE_HOME: '/state' }, '/home/u')).toBe('/state/omarchy/current')
  expect(omarchyCurrentDirectory({ XDG_STATE_HOME: 'relative' }, '/home/u')).toBe('/home/u/.local/state/omarchy/current')
})

it('parses a complete colors.toml', () => {
  const palette = parseOmarchyColors(TOKYO_NIGHT, 'tokyo-night')
  expect(palette).toMatchObject({ name: 'tokyo-night', mode: 'dark' })
  expect(palette?.colors).toMatchObject({ accent: '#7aa2f7', background: '#1a1b26', red: '#f7768e' })
})

it('falls back for optional colors and infers the mode from the background', () => {
  const palette = parseOmarchyColors(`# comment\naccent = '#ABCDEF' # trailing\nbackground = "#fff"\nforeground = "#222222"\n[extra]\nred = "#ff0000"\n`)
  expect(palette).toEqual({
    name: '',
    mode: 'light',
    colors: {
      accent: '#abcdef', background: '#fff', foreground: '#222222', bright_foreground: '#222222',
      darker_background: '#fff', lighter_background: '#fff', selection: '#abcdef',
      red: '#abcdef', green: '#abcdef', yellow: '#abcdef', blue: '#abcdef', magenta: '#abcdef',
    },
  })
  expect(parseOmarchyColors('accent = "#000"\nbackground = "#101010"\nforeground = "#eee"\nmode = "sepia"')?.mode).toBe('dark')
})

it('rejects a theme without the required colors', () => {
  expect(parseOmarchyColors('accent = "#7aa2f7"\nbackground = "#1a1b26"')).toBeUndefined()
  expect(parseOmarchyColors('accent = "blue"\nbackground = "#1a1b26"\nforeground = "#fff"')).toBeUndefined()
})

it('reads the current theme and its name', () => {
  expect(readOmarchyTheme(themeRoot(TOKYO_NIGHT, 'tokyo-night'))?.name).toBe('tokyo-night')
  expect(readOmarchyTheme(themeRoot(TOKYO_NIGHT))?.name).toBe('')
  expect(readOmarchyTheme(themeRoot())).toBeUndefined()
})

it('projects the palette onto the token scales only while following the system appearance', () => {
  const css = omarchyThemeCss(parseOmarchyColors(TOKYO_NIGHT)!)
  expect(css.startsWith('html[data-omarchy-theme][data-ds-theme-source="system"] body {')).toBe(true)
  expect(css).toContain('--dsw-static-neutral-bluish-950: #1a1b26;')
  expect(css).toContain('--dsw-static-neutral-bluish-00: #c0caf5;')
  expect(css).toContain('--dsw-static-neutral-1000: #0e0e14;')
  expect(css).toContain('--dsw-static-deepseek-500: #7aa2f7;')
  expect(css).toContain('--dsw-static-red-600-a08: color-mix(in srgb, #f7768e 8%, transparent);')
  expect(css).toContain('--dsw-static-blue-900: color-mix(in srgb, #7aa2f7 30%, #0e0e14);')
  const light = omarchyThemeCss(parseOmarchyColors('mode = "light"\naccent = "#205ea6"\nbackground = "#fffcf0"\nforeground = "#100f0f"')!)
  expect(light).toContain('--dsw-static-neutral-bluish-00: #fffcf0;')
  expect(light).toContain('--dsw-static-neutral-1000: #100f0f;')
  expect(light).toContain('--dsw-static-amber-900: color-mix(in srgb, #205ea6 30%, #000000);')
})

function fakeWindow() {
  const listeners = new Map<string, () => void>()
  return {
    webContents: { send: vi.fn() },
    destroyed: false,
    isDestroyed() { return this.destroyed },
    setBackgroundColor: vi.fn(),
    on: (event: string, listener: () => void) => { listeners.set(event, listener) },
    close: () => { listeners.get('closed')?.() },
  }
}

it('resolves the system appearance to the theme scheme and answers only the attached window', () => {
  const nativeTheme = { themeSource: 'system' as 'system' | 'light' | 'dark' }
  const theme = new DesktopOmarchyTheme(themeRoot(TOKYO_NIGHT, 'tokyo-night'), nativeTheme)
  try {
    expect(nativeTheme.themeSource).toBe('dark')
    expect(theme.activePalette?.mode).toBe('dark')
    theme.setRendererSource('light')
    expect(nativeTheme.themeSource).toBe('light')
    theme.setRendererSource('system')
    expect(nativeTheme.themeSource).toBe('dark')
    const window = fakeWindow()
    const event = { sender: window.webContents, returnValue: undefined as unknown }
    theme.answer(event as never)
    expect(event.returnValue).toBeNull()
    theme.attach(window as never)
    theme.answer(event as never)
    expect(event.returnValue).toMatchObject({ name: 'tokyo-night', css: expect.stringContaining('--dsw-static-deepseek-500') })
    window.close()
    theme.answer(event as never)
    expect(event.returnValue).toBeNull()
  } finally { theme.dispose() }
})

it('keeps the renderer source when no Omarchy theme is installed', () => {
  const nativeTheme = { themeSource: 'light' as 'system' | 'light' | 'dark' }
  const theme = new DesktopOmarchyTheme(join(tmpdir(), 'omarchy-missing-directory'), nativeTheme)
  expect(nativeTheme.themeSource).toBe('system')
  theme.setRendererSource('dark')
  expect(nativeTheme.themeSource).toBe('dark')
  expect(theme.activePalette).toBeUndefined()
  theme.dispose()
})

it('follows omarchy-theme-set replacing the theme directory', async () => {
  const current = themeRoot(TOKYO_NIGHT, 'tokyo-night')
  const nativeTheme = { themeSource: 'system' as 'system' | 'light' | 'dark' }
  const theme = new DesktopOmarchyTheme(current, nativeTheme)
  const window = fakeWindow()
  theme.attach(window as never)
  try {
    mkdirSync(join(current, 'next-theme'))
    writeFileSync(join(current, 'next-theme', 'colors.toml'), 'mode = "light"\naccent = "#205ea6"\nbackground = "#fffcf0"\nforeground = "#100f0f"\n')
    rmSync(join(current, 'theme'), { recursive: true })
    renameSync(join(current, 'next-theme'), join(current, 'theme'))
    writeFileSync(join(current, 'theme.name'), 'flexoki-light\n')
    await vi.waitFor(() => {
      expect(window.webContents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.omarchyTheme,
        expect.objectContaining({ name: 'flexoki-light' }))
    }, { timeout: 3000 })
    expect(nativeTheme.themeSource).toBe('light')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#fffcf0')
  } finally { theme.dispose() }
})
