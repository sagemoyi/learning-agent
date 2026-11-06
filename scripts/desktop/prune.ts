// What the installer leaves out of an installed node_modules (docs/settings/proposals/2026-11-05-windows-installer.md, 结构).
// Run by stage.mjs on dsh/ and profile/, or by hand on a folder to try it:
//   node scripts/desktop/prune.ts <node_modules>
// NSIS spends its time creating files, one by one, each scanned by the virus scanner, so files nothing reads at
// run time go, and so do DSH packages the learning profile never loads.
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * DSH packages the learning profile never loads. Neither dsh-base nor dsh-web-app mounts the speech, inspector or
 * Office-skill plugins; our bundle disables the two that use LibreOffice (office-to-pdf, ui-sidebar-documentpreview).
 * The DSH packages left behind name these only in strings.
 */
export const UNUSED = [
  '@deepseek-ai/libreoffice-kit-wasm', // LibreOffice compiled to WASM, for Office previews: 150 MB
  '@deepseek-ai/libreoffice-kit',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice',
  '@deepseek-ai/dsh-experimental-inspector',
  '@deepseek-ai/dsh-experimental-inspector-profile',
]
/** Packages whose names start with these go too: sherpa-onnx is the speech model runtime, one per platform. */
const UNUSED_PREFIXES = ['sherpa-onnx']

/** Files Node never loads: source maps, type declarations, and Markdown other than READMEs (DSH reads plugins' READMEs). */
export function isUnread(name: string): boolean {
  return /\.(map|d\.ts|d\.mts|d\.cts)$/.test(name) || (/\.md$/i.test(name) && !/^readme/i.test(name))
}

/** Remove what the installer leaves out of `modules`; returns how many files and bytes went. */
export function prune(modules: string, { packages = true } = {}): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const count = (path: string): void => {
    const stat = statSync(path)
    if (!stat.isDirectory()) { files++; bytes += stat.size; return }
    for (const entry of readdirSync(path)) count(join(path, entry))
  }
  const drop = (path: string): void => { count(path); rmSync(path, { recursive: true, force: true }) }
  if (packages) {
    for (const name of UNUSED) {
      try { drop(join(modules, name)) } catch { /* not installed here */ }
    }
    for (const entry of readdirSync(modules)) {
      if (UNUSED_PREFIXES.some(prefix => entry.startsWith(prefix))) drop(join(modules, entry))
    }
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && isUnread(entry.name)) drop(path)
    }
  }
  walk(modules)
  return { files, bytes }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const modules = process.argv[2]
  if (!modules) throw new Error('usage: node scripts/desktop/prune.ts <node_modules>')
  const { files, bytes } = prune(resolve(modules))
  console.log(`pruned ${files} files, ${(bytes / 1048576).toFixed(0)} MB from ${modules}`)
}
