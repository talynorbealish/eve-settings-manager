import { app } from 'electron'
import { readdir, mkdir, stat, copyFile, writeFile, readFile } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import type { Backup } from './types.js'

function getBackupRoot(): string {
  return join(app.getPath('userData'), 'backups')
}

async function readMeta(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(getBackupRoot(), 'meta.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function updateMeta(name: string, displayName: string): Promise<void> {
  const meta = await readMeta()
  meta[name] = displayName
  await writeFile(join(getBackupRoot(), 'meta.json'), JSON.stringify(meta), 'utf8')
}

async function removeMeta(name: string): Promise<void> {
  const root = getBackupRoot()
  const meta = await readMeta()
  if (!Object.keys(meta).length && !(name in meta)) return
  delete meta[name]
  try {
    await writeFile(join(root, 'meta.json'), JSON.stringify(meta), 'utf8')
  } catch { /* backup root may not exist if there are no backups */ }
}

// ── Source labels (name → "Server / Profile") ──────────────────────────────────

async function readSources(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(getBackupRoot(), 'sources.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function updateSource(name: string, source: string): Promise<void> {
  const sources = await readSources()
  sources[name] = source
  try {
    await writeFile(join(getBackupRoot(), 'sources.json'), JSON.stringify(sources), 'utf8')
  } catch { /* ignore */ }
}

async function renameSource(oldName: string, newName: string): Promise<void> {
  const sources = await readSources()
  if (sources[oldName] === undefined) return
  sources[newName] = sources[oldName]
  delete sources[oldName]
  try {
    await writeFile(join(getBackupRoot(), 'sources.json'), JSON.stringify(sources), 'utf8')
  } catch { /* ignore */ }
}

async function removeSource(name: string): Promise<void> {
  const sources = await readSources()
  if (!(name in sources)) return
  delete sources[name]
  try {
    await writeFile(join(getBackupRoot(), 'sources.json'), JSON.stringify(sources), 'utf8')
  } catch { /* ignore */ }
}

/**
 * Creates a named backup of all .dat files in a profile directory.
 * Files are copied into: <userData>/backups/<name>/
 */
export async function createBackup(profilePath: string, name: string, source?: string): Promise<Backup> {
  const backupPath = join(getBackupRoot(), name)
  await mkdir(backupPath, { recursive: true })

  const entries = await readdir(profilePath, { withFileTypes: true })
  const datFiles = entries.filter(e => e.isFile() && e.name.endsWith('.dat'))
  await Promise.all(datFiles.map(e => copyFile(join(profilePath, e.name), join(backupPath, e.name))))

  if (source) await updateSource(name, source)

  return {
    type: 'folder',
    name,
    source,
    path: backupPath,
    createdAt: Date.now(),
    fileCount: datFiles.length,
  }
}

/**
 * Creates a backup of a single .dat file.
 * File is copied into: <userData>/backups/<name>.dat
 * Display name is stored in <userData>/backups/meta.json.
 */
export async function createFileBackup(profilePath: string, sourcePath: string, name: string, displayName?: string, source?: string): Promise<Backup> {
  const root = getBackupRoot()
  await mkdir(root, { recursive: true })
  const destPath = join(root, `${name}.dat`)
  await copyFile(sourcePath, destPath)
  if (displayName) await updateMeta(name, displayName)
  if (source) await updateSource(name, source)
  return {
    type: 'file',
    name,
    displayName,
    source,
    path: destPath,
    createdAt: Date.now(),
    fileCount: 1,
  }
}

/**
 * Lists all backups, newest first.
 */
export async function listBackups(): Promise<Backup[]> {
  const root = getBackupRoot()

  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const meta = await readMeta()
  const sources = await readSources()

  const backups = await Promise.all([
    // Folder backups — subdirectories
    ...entries
      .filter(e => e.isDirectory())
      .map(async e => {
        const backupPath = join(root, e.name)
        const files = await readdir(backupPath)
        const s = await stat(backupPath)
        return {
          type: 'folder' as const,
          name: e.name,
          source: sources[e.name],
          path: backupPath,
          createdAt: s.birthtimeMs,
          fileCount: files.filter(f => f.endsWith('.dat')).length,
        }
      }),
    // File backups — .dat files at root level
    ...entries
      .filter(e => e.isFile() && e.name.endsWith('.dat'))
      .map(async e => {
        const filePath = join(root, e.name)
        const name = e.name.replace(/\.dat$/, '')
        const s = await stat(filePath)
        return {
          type: 'file' as const,
          name,
          displayName: meta[name],
          source: sources[name],
          path: filePath,
          createdAt: s.birthtimeMs,
          fileCount: 1,
        }
      }),
  ])

  return backups.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Renames a backup. For folder backups the directory is renamed; for file
 * backups the .dat is renamed and its display-name/source metadata migrated.
 */
export async function renameBackup(backupPath: string, newName: string): Promise<void> {
  const { rename } = await import('node:fs/promises')
  const root = getBackupRoot()
  const isFile = backupPath.endsWith('.dat')

  if (isFile) {
    const oldName = basename(backupPath).replace(/\.dat$/, '')
    const newPath = join(root, `${newName}.dat`)
    await rename(backupPath, newPath)
    // Migrate display-name + source metadata
    const meta = await readMeta()
    if (meta[oldName] !== undefined) {
      meta[newName] = meta[oldName]
      delete meta[oldName]
      await writeFile(join(root, 'meta.json'), JSON.stringify(meta), 'utf8')
    }
    await renameSource(oldName, newName)
  } else {
    const oldName = basename(backupPath)
    await rename(backupPath, join(root, newName))
    await renameSource(oldName, newName)
  }
}

/**
 * Restores a folder backup by copying its .dat files into the profile directory.
 */
export async function restoreBackup(profilePath: string, backupPath: string): Promise<void> {
  const entries = await readdir(backupPath, { withFileTypes: true })
  const datFiles = entries.filter(e => e.isFile() && e.name.endsWith('.dat'))
  await Promise.all(datFiles.map(e => copyFile(join(backupPath, e.name), join(profilePath, e.name))))
}

/**
 * Puts a single file backup back into the profile directory.
 */
export async function restoreFileBackup(profilePath: string, backupFilePath: string): Promise<void> {
  await copyFile(backupFilePath, join(profilePath, basename(backupFilePath)))
}

/**
 * Deletes a named folder backup directory.
 */
export async function deleteBackup(backupPath: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(backupPath, { recursive: true, force: true })
  await removeSource(basename(backupPath))
}

/**
 * Deletes a single file backup and removes its entry from meta.json.
 */
export async function deleteFileBackup(backupFilePath: string): Promise<void> {
  const { rm } = await import('node:fs/promises')
  await rm(backupFilePath, { force: true })
  const name = basename(backupFilePath).replace(/\.dat$/, '')
  await removeMeta(name)
  await removeSource(name)
}
