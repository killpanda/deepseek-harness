/**
 * Omarchy desktop theme integration for the Linux shell. Omarchy publishes the
 * active theme as `$XDG_STATE_HOME/omarchy/current/theme/colors.toml` and
 * replaces that directory on every `omarchy-theme-set`; this module reads the
 * palette, projects it onto the Web UI token stylesheet, and follows switches.
 */

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainEvent, NativeTheme } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

/** Color scheme an Omarchy theme declares in `colors.toml`. */
export type OmarchyMode = 'light' | 'dark'

/** `colors.toml` keys the projection reads. */
const COLOR_KEYS = [
  'accent', 'background', 'foreground', 'bright_foreground', 'darker_background', 'lighter_background',
  'selection', 'red', 'green', 'yellow', 'blue', 'magenta',
] as const

/** One `colors.toml` key the projection reads. */
export type OmarchyColorKey = typeof COLOR_KEYS[number]

/** Validated Omarchy palette with every projected color resolved. */
export interface OmarchyPalette {
  /** Theme directory name from `current/theme.name`; empty when Omarchy did not write one. */
  readonly name: string
  /** Declared scheme, or the one implied by the background luminance. */
  readonly mode: OmarchyMode
  /** Hex colors by key; optional keys fall back to required ones. */
  readonly colors: Readonly<Record<OmarchyColorKey, string>>
}

/** Keys every usable theme must declare; the rest fall back to these. */
const REQUIRED_KEYS = ['accent', 'background', 'foreground'] as const satisfies readonly OmarchyColorKey[]

const FALLBACKS: Readonly<Record<Exclude<OmarchyColorKey, typeof REQUIRED_KEYS[number]>, OmarchyColorKey>> = {
  bright_foreground: 'foreground',
  darker_background: 'background',
  lighter_background: 'background',
  selection: 'accent',
  red: 'accent',
  green: 'accent',
  yellow: 'accent',
  blue: 'accent',
  magenta: 'accent',
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/iu
const ASSIGNMENT = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/u

/**
 * Resolve the directory Omarchy 4 writes the current theme into.
 * @param env - Process environment; `XDG_STATE_HOME` overrides `~/.local/state`.
 * @param home - Home directory used when `XDG_STATE_HOME` is unset or relative.
 * @returns `<state>/omarchy/current`, which holds `theme/` and `theme.name`.
 */
export function omarchyCurrentDirectory(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const state = env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME.startsWith('/')
    ? env.XDG_STATE_HOME
    : join(home, '.local', 'state')
  return join(state, 'omarchy', 'current')
}

/**
 * Parse the top-level string assignments of an Omarchy `colors.toml`.
 * @param text - File contents; tables, comments, and non-string values are ignored.
 * @param name - Theme name recorded on the result.
 * @returns the palette, or `undefined` when a required color is missing or not a hex color.
 */
export function parseOmarchyColors(text: string, name = ''): OmarchyPalette | undefined {
  const values = new Map<string, string>()
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.startsWith('[')) break
    const match = ASSIGNMENT.exec(line)
    if (match !== null) values.set(match[1]!, (match[2] ?? match[3]!).trim())
  }
  const color = (key: string): string | undefined => {
    const value = values.get(key)
    return value !== undefined && HEX_COLOR.test(value) ? value.toLowerCase() : undefined
  }
  const colors: Partial<Record<OmarchyColorKey, string>> = {}
  for (const key of REQUIRED_KEYS) {
    const value = color(key)
    if (value === undefined) return undefined
    colors[key] = value
  }
  for (const [key, fallback] of Object.entries(FALLBACKS) as [keyof typeof FALLBACKS, OmarchyColorKey][]) {
    colors[key] = color(key) ?? colors[fallback]!
  }
  const declared = values.get('mode')
  const mode: OmarchyMode = declared === 'light' || declared === 'dark'
    ? declared
    : relativeLuminance(colors.background!) > 0.5 ? 'light' : 'dark'
  return { name, mode, colors: colors as Record<OmarchyColorKey, string> }
}

function relativeLuminance(hex: string): number {
  const digits = hex.length === 4 ? [...hex.slice(1)].map(digit => digit + digit).join('') : hex.slice(1, 7)
  const [red, green, blue] = [0, 2, 4].map(offset => Number.parseInt(digits.slice(offset, offset + 2), 16) / 255)
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}

/**
 * Read the current Omarchy theme.
 * @param current - Directory from {@link omarchyCurrentDirectory}.
 * @returns the palette, or `undefined` when no theme is installed or `colors.toml` is unusable.
 */
export function readOmarchyTheme(current: string): OmarchyPalette | undefined {
  let text: string
  try { text = readFileSync(join(current, 'theme', 'colors.toml'), 'utf8') }
  catch (error) {
    // Omarchy is absent, or `omarchy-theme-set` is between removing and renaming the theme directory.
    if (isMissing(error)) return undefined
    throw error
  }
  let name = ''
  try { name = readFileSync(join(current, 'theme.name'), 'utf8').trim() }
  catch (error) {
    // theme.name is informational; older Omarchy releases did not write it.
    if (!isMissing(error)) throw error
  }
  return parseOmarchyColors(text, name)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** Approximate gray level (0-255) of each built-in neutral token step, used to place it between the theme's ends. */
const NEUTRAL_SCALES = {
  'neutral-bluish': {
    '00': 255, 50: 249, 55: 246, 60: 247, 75: 242, 90: 240, 100: 238, 150: 237, 200: 229, 300: 211, 310: 210,
    400: 178, 500: 158, 600: 134, 700: 102, 750: 70, 800: 54, 850: 44, 875: 35, 900: 27, 950: 21, 1000: 17,
  },
  neutral: {
    '00': 255, 50: 250, 100: 245, 150: 237, 200: 229, 250: 220, 300: 212, 400: 163, 500: 130, 550: 103,
    600: 85, 700: 60, 800: 41, 850: 34, 900: 15, 1000: 0,
  },
} as const satisfies Record<string, Record<string, number>>

/** Steps of each chromatic token family, as `[step, end, percent of the base color]`. */
const TINTS: Readonly<Record<string, readonly [end: 'light' | 'dark' | 'transparent', percent: number]>> = {
  50: ['light', 8], '50p': ['light', 9], 75: ['light', 12], 100: ['light', 16], 200: ['light', 28], 300: ['light', 45],
  400: ['light', 75], 450: ['light', 90], 500: ['light', 100], 600: ['dark', 85], '700-delete': ['dark', 70],
  800: ['dark', 45], 900: ['dark', 30], 950: ['dark', 22], '500-a08': ['transparent', 8], '500-a12': ['transparent', 12],
  '400-a12': ['transparent', 12], '600-a08': ['transparent', 8],
}

/** Built-in chromatic families, their steps, and the Omarchy color each one follows. */
const FAMILIES: readonly [family: string, base: OmarchyColorKey, steps: readonly string[]][] = [
  ['deepseek', 'accent', ['50', '100', '200', '300', '400', '450', '500', '600', '700-delete', '800', '900']],
  ['blue', 'blue', ['50', '50p', '75', '100', '300', '400', '450', '500', '600', '800', '900', '950']],
  ['red', 'red', ['50', '100', '400', '400-a12', '500', '600', '600-a08', '900']],
  ['green', 'green', ['100', '400', '500', '500-a08', '500-a12', '900']],
  ['amber', 'yellow', ['100', '400', '500', '600', '900']],
  ['violet', 'magenta', ['400', '600']],
]

function mix(first: string, percent: number, second: string): string {
  if (percent >= 100) return first
  if (percent <= 0) return second
  return `color-mix(in srgb, ${first} ${String(Math.round(percent))}%, ${second})`
}

/**
 * Project a palette onto the Web UI token stylesheet. The rules apply only
 * while the application follows the system appearance (`data-ds-theme-source`
 * is `system`) and the document carries `data-omarchy-theme`; their selector
 * outranks both built-in palettes, so light and dark tokens resolve to the
 * Omarchy colors while explicit light or dark preferences keep the stock look.
 * @param palette - Validated palette.
 * @returns a stylesheet redefining the static token scales and the alias tokens that use literal colors.
 */
export function omarchyThemeCss(palette: OmarchyPalette): string {
  const c = palette.colors
  const dark = palette.mode === 'dark'
  // Light and dark ends of the neutral scale, and the gray levels that anchor them.
  const lightEnd = dark ? c.bright_foreground : c.background
  const darkEnd = dark ? c.background : c.foreground
  const [low, high] = dark ? [21, 249] : [27, 255]
  const declarations: string[] = []
  for (const [scale, steps] of Object.entries(NEUTRAL_SCALES)) {
    for (const [step, level] of Object.entries(steps)) {
      const value = dark && level < low
        ? mix(c.background, level / low * 100, c.darker_background)
        : mix(lightEnd, (level - low) / (high - low) * 100, darkEnd)
      declarations.push(`--dsw-static-${scale}-${step}: ${value};`)
    }
  }
  const tintEnds = { light: '#ffffff', dark: dark ? c.darker_background : '#000000', transparent: 'transparent' }
  for (const [family, base, steps] of FAMILIES) {
    for (const step of steps) {
      const [end, percent] = TINTS[step]!
      declarations.push(`--dsw-static-${family}-${step}: ${mix(c[base], percent, tintEnds[end])};`)
    }
  }
  declarations.push(
    `--dsw-alias-brand-primary-new-colorprimary-new-color: ${c.accent};`,
    `--dsw-alias-bg-document-selection: ${mix(c.selection, 80, 'transparent')};`,
    `--dsw-alias-file-diff-added-bg: ${mix(c.green, 16, c.background)};`,
    `--dsw-alias-file-diff-added-gutter: ${mix(c.green, 10, c.background)};`,
    `--dsw-alias-file-diff-added-marker: ${c.green};`,
    `--dsw-alias-file-diff-deleted-bg: ${mix(c.red, 16, c.background)};`,
    `--dsw-alias-file-diff-deleted-gutter: ${mix(c.red, 10, c.background)};`,
    `--dsw-alias-file-diff-deleted-marker: ${c.red};`,
    `--dsw-menu-surface-fill: ${mix(c.lighter_background, 70, 'transparent')};`,
    `--dsw-alias-menu-group-header-fill: ${mix(c.lighter_background, 94, 'transparent')};`,
    `--dsw-specific-menu: var(--dsw-menu-surface-fill);`,
  )
  return `html[data-omarchy-theme][data-ds-theme-source="system"] body {\n  ${declarations.join('\n  ')}\n}\n`
}

/** Message sent to the application preload: the stylesheet and theme name, or `null` when no Omarchy theme applies. */
export type OmarchyThemeMessage = { readonly name: string; readonly css: string } | null

/** Coalescing delay for the burst of directory events one `omarchy-theme-set` produces. */
const SWITCH_SETTLE_MS = 150

/**
 * Follows the current Omarchy theme for the main window: answers the preload's
 * synchronous initial read, pushes each switch, and resolves the renderer's
 * `system` appearance to the theme's scheme through `nativeTheme`.
 */
export class DesktopOmarchyTheme {
  private palette: OmarchyPalette | undefined
  private message: OmarchyThemeMessage = null
  private source: 'light' | 'dark' | 'system' = 'system'
  private watcher: FSWatcher | undefined
  private timer: NodeJS.Timeout | undefined
  private window: BrowserWindow | undefined

  /**
   * @param current - Directory from {@link omarchyCurrentDirectory}.
   * @param nativeTheme - Electron native theme whose source this instance owns while a palette applies.
   */
  constructor(private readonly current: string, private readonly nativeTheme: Pick<NativeTheme, 'themeSource'>) {
    this.update(readOmarchyTheme(current))
    // Omarchy replaces `theme/` on every switch, so only a watch on its parent survives.
    if (existsSync(current)) {
      this.watcher = watch(current, () => { this.schedule() })
      this.watcher.on('error', (error) => { console.error('desktop omarchy theme: watch failed', error) })
    }
  }

  /** Current palette, used for the initial window background. */
  get activePalette(): OmarchyPalette | undefined { return this.palette }

  /**
   * Answer the preload's synchronous initial read from the given window.
   * @param event - Synchronous IPC event; only the attached window receives a stylesheet.
   */
  answer(event: IpcMainEvent): void {
    event.returnValue = this.window !== undefined && event.sender === this.window.webContents ? this.message : null
  }

  /**
   * Bind the window that receives stylesheet updates.
   * @param window - Main application window.
   */
  attach(window: BrowserWindow): void {
    this.window = window
    window.on('closed', () => { if (this.window === window) this.window = undefined })
  }

  /**
   * Apply the renderer's appearance preference, resolving `system` to the Omarchy scheme.
   * @param source - Theme source the application preload published.
   */
  setRendererSource(source: 'light' | 'dark' | 'system'): void {
    this.source = source
    this.nativeTheme.themeSource = source === 'system' && this.palette !== undefined ? this.palette.mode : source
  }

  /** Stop following theme switches. */
  dispose(): void {
    clearTimeout(this.timer)
    this.watcher?.close()
    this.watcher = undefined
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      try {
        const next = readOmarchyTheme(this.current)
        // A read between removal and rename sees no theme; the rename event re-reads.
        if (next !== undefined) this.update(next)
      } catch (error) { console.error('desktop omarchy theme: read failed', error) }
    }, SWITCH_SETTLE_MS)
  }

  private update(palette: OmarchyPalette | undefined): void {
    this.palette = palette
    this.message = palette === undefined ? null : { name: palette.name, css: omarchyThemeCss(palette) }
    this.setRendererSource(this.source)
    const window = this.window
    if (window !== undefined && !window.isDestroyed()) {
      window.setBackgroundColor(palette?.colors.background ?? '#00000000')
      window.webContents.send(DESKTOP_IPC.omarchyTheme, this.message)
    }
  }
}
