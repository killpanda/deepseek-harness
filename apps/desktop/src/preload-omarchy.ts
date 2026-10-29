/** Applies the main process's Omarchy theme stylesheet to the application document on Linux. */

import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import type { OmarchyThemeMessage } from './omarchy-theme.ts'

/** Root attribute naming the active Omarchy theme; the stylesheet selector requires it. */
const OMARCHY_ATTRIBUTE = 'data-omarchy-theme'

/** Id of the preload-owned stylesheet element. */
const STYLE_ID = 'dsh-omarchy-theme'

/**
 * Reads the current Omarchy stylesheet synchronously so the first paint uses
 * it, then replaces it on every theme switch the main process reports. A
 * `null` message removes the stylesheet and attribute.
 */
export function syncOmarchyTheme(): void {
  if (process.platform !== 'linux') return
  let latest = ipcRenderer.sendSync(DESKTOP_IPC.omarchyThemeRead) as OmarchyThemeMessage
  const apply = (): void => {
    const root = document.documentElement as HTMLElement | null
    if (root === null) return
    let style = document.getElementById(STYLE_ID)
    if (latest === null) {
      style?.remove()
      root.removeAttribute(OMARCHY_ATTRIBUTE)
      return
    }
    if (style === null) {
      style = document.createElement('style')
      style.id = STYLE_ID
    }
    style.textContent = latest.css
    // The head may not exist yet; a style element applies from anywhere in the document.
    if (!style.isConnected) ((document.head as HTMLHeadElement | null) ?? root).append(style)
    root.setAttribute(OMARCHY_ATTRIBUTE, latest.name === '' ? 'omarchy' : latest.name)
  }
  ipcRenderer.on(DESKTOP_IPC.omarchyTheme, (_event, message: OmarchyThemeMessage) => {
    latest = message
    apply()
  })
  if ((document.documentElement as HTMLElement | null) === null) window.addEventListener('DOMContentLoaded', apply, { once: true })
  else apply()
}
