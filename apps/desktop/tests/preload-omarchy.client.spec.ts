// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { syncOmarchyTheme } from '../src/preload-omarchy.ts'

const ipc = vi.hoisted(() => ({ sendSync: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))

afterEach(() => {
  document.getElementById('dsh-omarchy-theme')?.remove()
  document.documentElement.removeAttribute('data-omarchy-theme')
  vi.restoreAllMocks()
  ipc.sendSync.mockReset()
  ipc.on.mockReset()
})

function pushed(): (event: unknown, message: unknown) => void {
  const [channel, listener] = ipc.on.mock.calls[0]!
  expect(channel).toBe(DESKTOP_IPC.omarchyTheme)
  return listener as (event: unknown, message: unknown) => void
}

it('applies the initial stylesheet and replaces it on each switch', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  ipc.sendSync.mockReturnValue({ name: 'tokyo-night', css: 'body { --a: red; }' })
  syncOmarchyTheme()
  expect(ipc.sendSync).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.omarchyThemeRead)
  expect(document.documentElement.getAttribute('data-omarchy-theme')).toBe('tokyo-night')
  expect(document.getElementById('dsh-omarchy-theme')?.textContent).toBe('body { --a: red; }')
  pushed()({}, { name: '', css: 'body { --a: blue; }' })
  expect(document.querySelectorAll('#dsh-omarchy-theme')).toHaveLength(1)
  expect(document.getElementById('dsh-omarchy-theme')?.textContent).toBe('body { --a: blue; }')
  expect(document.documentElement.getAttribute('data-omarchy-theme')).toBe('omarchy')
  pushed()({}, null)
  expect(document.getElementById('dsh-omarchy-theme')).toBeNull()
  expect(document.documentElement.hasAttribute('data-omarchy-theme')).toBe(false)
})

it('does nothing outside Linux', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  syncOmarchyTheme()
  expect(ipc.sendSync).not.toHaveBeenCalled()
  expect(ipc.on).not.toHaveBeenCalled()
})

it('defers the initial stylesheet until the document root exists', () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  ipc.sendSync.mockReturnValue({ name: 'nord', css: 'body {}' })
  const root = vi.spyOn(document, 'documentElement', 'get').mockReturnValue(null as never)
  syncOmarchyTheme()
  root.mockRestore()
  expect(document.getElementById('dsh-omarchy-theme')).toBeNull()
  window.dispatchEvent(new Event('DOMContentLoaded'))
  expect(document.documentElement.getAttribute('data-omarchy-theme')).toBe('nord')
})
