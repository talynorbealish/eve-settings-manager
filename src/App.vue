<script setup lang="ts">
import { onMounted, onUnmounted, watch, ref, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useServerStore } from './stores/useServerStore'
import { useProfileStore } from './stores/useProfileStore'
import { useSettingsStore } from './stores/useSettingsStore'
import { useBackupStore } from './stores/useBackupStore'
import { usePrefsStore } from './stores/usePrefsStore'
import type { CharFile, SettingsFile, Backup } from './types'

const { t, locale } = useI18n()

const serverStore = useServerStore()
const profileStore = useProfileStore()
const settingsStore = useSettingsStore()
const backupStore = useBackupStore()
const prefsStore = usePrefsStore()

const fixturePath = import.meta.env.VITE_FIXTURE_PATH as string | undefined

// ── Tab state ──────────────────────────────────────────────────────────────────
const activeTab = ref<'characters' | 'accounts' | 'backups'>('characters')
function selectTab(tab: 'characters' | 'accounts' | 'backups') {
  activeTab.value = tab
  prefsStore.setLastTab(tab)
}

// ── Search / sort / filter ───────────────────────────────────────────────────
const searchQuery = ref('')
const sortMode = ref<'recent' | 'name' | 'oldest'>('recent')
const filterRecent = ref(false) // only files modified in the last 24h

const DAY_MS = 24 * 60 * 60 * 1000

function sourcePathForProfile(): string | undefined {
  const p = profileStore.activeProfile?.path
  return p ? prefsStore.lastSource[p] : undefined
}

const filteredCharFiles = computed(() => {
  let files = settingsStore.charFiles
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    files = files.filter(f =>
      (f.charName?.toLowerCase().includes(q)) ||
      f.id.toLowerCase().includes(q)
    )
  }
  if (filterRecent.value) {
    const cutoff = Date.now() - DAY_MS
    files = files.filter(f => f.modifiedAt >= cutoff)
  }
  const sorted = [...files].sort((a, b) => {
    if (sortMode.value === 'name') {
      return (a.charName ?? a.id).localeCompare(b.charName ?? b.id)
    }
    if (sortMode.value === 'oldest') return a.modifiedAt - b.modifiedAt
    return b.modifiedAt - a.modifiedAt
  })
  // Pin favorites + the last source character to the top (keeping relative order)
  const src = sourcePathForProfile()
  const rank = (f: CharFile) => {
    if (f.path === src) return 0
    if (prefsStore.isFavorite(f.id)) return 1
    return 2
  }
  return sorted.sort((a, b) => rank(a) - rank(b))
})

onMounted(async () => {
  await prefsStore.load()
  activeTab.value = prefsStore.lastTab
  serverStore.detectFolder(fixturePath)
  backupStore.loadBackups()
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

async function selectFolder() {
  await serverStore.openFolderDialog()
  if (!serverStore.activeServer) {
    await profileStore.loadProfiles()
  }
}

watch(() => serverStore.activeServer, async (server) => {
  await profileStore.loadProfiles()
  if (server) await serverStore.refreshStatus()
})

watch(() => profileStore.activeProfile, async () => {
  await settingsStore.loadSettings()
})

function formatDate(ms: number) {
  const d = new Date(ms)
  const date = String(d.getMonth() + 1).padStart(2, '0') + '/' +
    String(d.getDate()).padStart(2, '0') + '/' +
    d.getFullYear()
  const time = String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0')
  return `${date} ${time}`
}

function formatDateOnly(ms: number) {
  const d = new Date(ms)
  return String(d.getMonth() + 1).padStart(2, '0') + '/' +
    String(d.getDate()).padStart(2, '0') + '/' +
    d.getFullYear()
}

// Filesystem-safe timestamp (no '/' or ':' which are illegal in Windows paths)
function safeStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

// ── Toasts ───────────────────────────────────────────────────────────────────
interface Toast { id: number; message: string; action?: { label: string; fn: () => void } }
const toasts = ref<Toast[]>([])
let toastSeq = 0

function pushToast(message: string, action?: { label: string; fn: () => void }) {
  const id = ++toastSeq
  toasts.value.push({ id, message, action })
  // Action toasts linger longer so the user can react (e.g. Undo)
  const ttl = action ? 8000 : 3500
  setTimeout(() => dismissToast(id), ttl)
}

function dismissToast(id: number) {
  const i = toasts.value.findIndex(t => t.id === id)
  if (i >= 0) toasts.value.splice(i, 1)
}

// ── Where a backup/copy was taken from (for the source label) ──────────────────
function currentSourceLabel(): string {
  const server = serverStore.activeServer?.displayName || serverStore.activeServer?.name || ''
  const profile = profileStore.activeProfile?.name || ''
  return [server, profile].filter(Boolean).join(' / ')
}

// ── Backup ─────────────────────────────────────────────────────────────────────
const backupDialog = ref(false)
const backupName = ref('')

function openBackupDialog() {
  backupName.value = profileStore.activeProfile?.name ?? 'backup'
  backupDialog.value = true
}

function openServerFolder() {
  const target = profileStore.activeProfile?.path ?? serverStore.activeServer?.path
  if (target) window.ipcRenderer.invoke('folder:open-in-shell', target)
}

function revealBackup(path: string) {
  window.ipcRenderer.invoke('folder:show-in-shell', path)
}

async function confirmBackup() {
  const name = backupName.value.trim()
  if (!name) return
  const exists = backupStore.backups.some(b => b.name === name && b.type === 'folder')
  if (exists) {
    backupDialog.value = false
    openWarnDialog(
      t('warn.backupExistsDetail', { name }),
      async () => { await backupStore.createBackup(name, currentSourceLabel()); pushToast(`Backed up profile "${name}"`) },
      t('warn.backupExistsTitle'),
      'confirm',
    )
    return
  }
  backupDialog.value = false
  await backupStore.createBackup(name, currentSourceLabel())
  pushToast(`Backed up profile "${name}"`)
}

async function createFileBackupDirect(file: SettingsFile) {
  const name = file.path.split(/[\\/]/).pop()?.replace(/\.dat$/, '') ?? file.id
  const displayName = file.type === 'char'
    ? (file.charName ?? settingsStore.charNames[file.id])
    : (settingsStore.descriptions[file.filename] || `Account ${file.id}`)
  const exists = backupStore.backups.some(b => b.name === name && b.type === 'file')
  if (exists) {
    openWarnDialog(
      t('warn.backupExistsDetail', { name }),
      async () => { await backupStore.createFileBackup(file.path, name, displayName, currentSourceLabel()); pushToast(`Backed up "${displayName}"`) },
      t('warn.backupExistsTitle'),
      'confirm',
    )
    return
  }
  await backupStore.createFileBackup(file.path, name, displayName, currentSourceLabel())
  pushToast(`Backed up "${displayName}"`)
}

// ── Sync ──────────────────────────────────────────────────────────────────────
const syncDialog = ref(false)
const syncSource = ref<SettingsFile | null>(null)
const syncSelected = ref<string[]>([])
const syncSort = ref<'name' | 'recent'>('name')

const syncTargets = computed(() => {
  if (!syncSource.value) return []
  const src = syncSource.value
  const pool = src.type === 'char' ? settingsStore.charFiles : settingsStore.userFiles
  return pool
    .filter(f => f.path !== src.path)
    .sort((a, b) => {
      if (syncSort.value === 'recent') return b.modifiedAt - a.modifiedAt
      return syncTargetLabel(a).toLowerCase().localeCompare(syncTargetLabel(b).toLowerCase())
    })
})

const syncSearch = ref('')
const backupFirst = ref(true) // auto-create a restore point before copying

const filteredSyncTargets = computed(() => {
  if (!syncSearch.value.trim()) return syncTargets.value
  const q = syncSearch.value.toLowerCase()
  return syncTargets.value.filter(f =>
    syncTargetLabel(f).toLowerCase().includes(q)
  )
})

const selectedSyncTargets = computed(() => {
  return syncTargets.value.filter(f => syncSelected.value.includes(f.path))
})

// Copy sets relevant to the current source type
const relevantCopySets = computed(() =>
  prefsStore.copySets.filter(s => s.type === (syncSource.value?.type ?? 'char'))
)

function applyCopySet(name: string) {
  const set = prefsStore.copySets.find(s => s.name === name)
  if (!set) return
  // Select the targets whose id is in the set (and that exist in this profile)
  syncSelected.value = syncTargets.value
    .filter(f => set.ids.includes(f.id))
    .map(f => f.path)
  pushToast(`Applied set "${name}" (${syncSelected.value.length} selected)`)
}

async function saveCurrentAsSet() {
  if (!syncSource.value || !syncSelected.value.length) return
  const name = (window.prompt('Name this copy set:') ?? '').trim()
  if (!name) return
  const ids = selectedSyncTargets.value.map(f => f.id)
  await prefsStore.saveCopySet({ name, type: syncSource.value.type, ids })
  pushToast(`Saved set "${name}" (${ids.length} characters)`)
}

function selectAllFiltered() {
  const paths = filteredSyncTargets.value.map(f => f.path)
  const set = new Set([...syncSelected.value, ...paths])
  syncSelected.value = [...set]
}

function syncTargetLabel(file: SettingsFile): string {
  if (file.type === 'char') return (file as CharFile).charName ?? file.id
  const note = settingsStore.descriptions[file.filename]
  return note || `Account ${file.id}`
}

const syncAllChecked = computed(() =>
  syncTargets.value.length > 0 && syncSelected.value.length === syncTargets.value.length
)

function openSyncDialog(file: SettingsFile) {
  syncSource.value = file
  syncSelected.value = []
  syncSearch.value = ''
  syncDialog.value = true
}

function toggleSyncAll() {
  if (syncAllChecked.value) {
    syncSelected.value = []
  } else {
    syncSelected.value = syncTargets.value.map(f => f.path)
  }
}

function toggleSyncTarget(path: string) {
  const idx = syncSelected.value.indexOf(path)
  if (idx >= 0) {
    syncSelected.value.splice(idx, 1)
  } else {
    syncSelected.value.push(path)
  }
}

async function confirmSync() {
  if (!syncSource.value || !syncSelected.value.length) return
  syncDialog.value = false
  const src = syncSource.value
  const targets = [...syncSelected.value]
  const count = targets.length
  const profilePath = profileStore.activeProfile?.path
  syncSource.value = null
  syncSelected.value = []
  await nextTick()

  try {
    // Optional persistent restore point of the whole profile before overwriting
    if (backupFirst.value && profileStore.activeProfile) {
      const stamp = safeStamp(Date.now())
      await backupStore.createBackup(`Before copy ${stamp}`, currentSourceLabel())
    }

    await settingsStore.syncSettings(src.path, targets)

    // Remember the source character for this profile so it stays pinned/locatable
    if (profilePath) await prefsStore.setLastSource(profilePath, src.path)

    pushToast(`Copied to ${count} ${count === 1 ? 'file' : 'files'}`, {
      label: 'Undo',
      fn: async () => {
        const n = await settingsStore.undoLastCopy()
        pushToast(`Restored ${n} ${n === 1 ? 'file' : 'files'}`)
      },
    })
  } catch (err) {
    pushToast(`Copy failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Warning dialog ─────────────────────────────────────────────────────────────
const warnDialog = ref(false)
const warnTitle = ref('')
const warnDetail = ref('')
const warnAction = ref<(() => Promise<void>) | null>(null)
const warnType = ref<'confirm' | 'danger'>('danger')

function openWarnDialog(detail: string, action: () => Promise<void>, title?: string, type: 'confirm' | 'danger' = 'danger') {
  warnTitle.value = title ?? ''
  warnDetail.value = detail
  warnAction.value = action
  warnType.value = type
  warnDialog.value = true
}

async function proceedWarn() {
  warnDialog.value = false
  const action = warnAction.value
  warnAction.value = null
  await nextTick()
  if (action) await action()
}

// ── Backup put back / delete ──────────────────────────────────────────────────
function backupDisplayName(backup: Backup): string {
  if (backup.type === 'folder') return backup.name
  if (backup.displayName) return backup.displayName
  const charMatch = backup.name.match(/^core_char_(.+)$/)
  if (charMatch) {
    return settingsStore.charNames[charMatch[1]]
      ?? settingsStore.charFiles.find(f => f.id === charMatch[1])?.charName
      ?? charMatch[1]
  }
  const userMatch = backup.name.match(/^core_user_(.+)$/)
  if (userMatch) return `Account ${userMatch[1]}`
  return backup.name
}

function putBackFile(backup: Backup) {
  openWarnDialog(
    t('warn.putBackFileDetail', { name: backupDisplayName(backup) }),
    async () => { await backupStore.restoreFileBackup(backup); pushToast(`Restored "${backupDisplayName(backup)}"`) },
    undefined,
    'confirm'
  )
}

function putBackFolder(backup: Backup) {
  openWarnDialog(
    t('warn.backupFolderDetail', { name: backup.name }),
    async () => { await backupStore.restoreBackup(backup); pushToast(`Restored "${backup.name}"`) },
    undefined,
    'confirm'
  )
}

function deleteBackupItem(backup: Backup) {
  openWarnDialog(
    t('warn.deleteBackupDetail', { name: backupDisplayName(backup) }),
    async () => {
      backup.type === 'file'
        ? await backupStore.deleteFileBackup(backup)
        : await backupStore.deleteBackup(backup)
      pushToast('Backup deleted')
    },
    t('warn.deleteBackupTitle'),
  )
}

// ── Backup rename ──────────────────────────────────────────────────────────────
const renameDialog = ref(false)
const renameTarget = ref<Backup | null>(null)
const renameValue = ref('')

function openRenameDialog(backup: Backup) {
  renameTarget.value = backup
  renameValue.value = backup.type === 'file' ? (backup.displayName ?? backup.name) : backup.name
  renameDialog.value = true
}

async function confirmRename() {
  const name = renameValue.value.trim()
  if (!name || !renameTarget.value) return
  const target = renameTarget.value
  renameDialog.value = false
  await backupStore.renameBackup(target, name)
  renameTarget.value = null
  pushToast('Backup renamed')
}

// ── Profile dialog ─────────────────────────────────────────────────────────────
const profileDialog = ref(false)
const profileDialogMode = ref<'create' | 'rename' | 'duplicate'>('create')
const profileName = ref('')
const profileNameError = ref('')

const profileDialogTitle = computed(() => {
  if (profileDialogMode.value === 'rename') return t('profile.rename')
  if (profileDialogMode.value === 'duplicate') return t('profile.duplicate')
  return t('profile.create')
})

function openProfileDialog(mode: 'create' | 'rename' | 'duplicate') {
  profileDialogMode.value = mode
  profileNameError.value = ''
  if (mode === 'rename') {
    profileName.value = profileStore.activeProfile?.name ?? ''
  } else if (mode === 'duplicate') {
    profileName.value = t('profile.duplicateOf', { name: profileStore.activeProfile?.name ?? '' })
  } else {
    profileName.value = ''
  }
  profileDialog.value = true
}

function validateProfileName(name: string): boolean {
  if (!name.trim()) {
    profileNameError.value = t('profile.nameEmpty')
    return false
  }
  const currentLower = profileDialogMode.value === 'rename' ? profileStore.activeProfile?.name?.toLowerCase() : null
  const duplicate = profileStore.profiles.some(p =>
    p.name.toLowerCase() === name.trim().toLowerCase() && p.name.toLowerCase() !== currentLower
  )
  if (duplicate) {
    profileNameError.value = t('profile.nameDuplicate')
    return false
  }
  return true
}

async function confirmProfileDialog() {
  const name = profileName.value.trim()
  if (!validateProfileName(name)) return
  profileDialog.value = false
  profileNameError.value = ''
  if (profileDialogMode.value === 'create') {
    await profileStore.createProfile(name)
    const created = profileStore.profiles.find(p => p.name === name)
    if (created) await profileStore.selectProfile(created)
  } else if (profileDialogMode.value === 'rename') {
    const oldName = profileStore.activeProfile!.name
    await profileStore.renameProfile(oldName, name)
    const renamed = profileStore.profiles.find(p => p.name === name)
    if (renamed) await profileStore.selectProfile(renamed)
  } else if (profileDialogMode.value === 'duplicate') {
    const sourceName = profileStore.activeProfile!.name
    await profileStore.duplicateProfile(sourceName, name)
    const duped = profileStore.profiles.find(p => p.name === name)
    if (duped) await profileStore.selectProfile(duped)
  }
}

function confirmDeleteProfile() {
  const name = profileStore.activeProfile?.name
  if (!name) return
  openWarnDialog(
    t('profile.deleteDetail', { name }),
    () => profileStore.deleteProfile(name),
    t('profile.deleteTitle'),
  )
}

// ── Server name localization ───────────────────────────────────────────────────
const SERVER_KEY_MAP: Record<string, string> = {
  'Tranquility': 'tranquility',
  'Serenity': 'serenity',
  'Infinity': 'infinity',
  'Singularity': 'singularity',
  'Duality': 'duality',
  'Thunderdome': 'thunderdome',
}

function localizeServerName(displayName: string): string {
  const base = displayName.replace(/\s*\(.*\)$/, '').trim()
  const suffix = displayName.match(/\s*\(.*\)$/)?.[0] ?? ''
  const key = SERVER_KEY_MAP[base]
  if (!key) return displayName
  return t(`serverNames.${key}`) + suffix
}

// ── Notes ──────────────────────────────────────────────────────────────────────
async function saveNote(filename: string, val: string) {
  const trimmed = val.trim()
  if (trimmed) {
    await settingsStore.setDescription(filename, trimmed)
  } else {
    await settingsStore.deleteDescription(filename)
  }
}

// ── GitHub ─────────────────────────────────────────────────────────────────────
function openGitHub() {
  window.ipcRenderer.invoke('shell:open-external', 'https://github.com/mintnick/eve-settings-manager')
}

// ── Language ───────────────────────────────────────────────────────────────────
const LANGUAGES = [
  { value: 'en',     label: 'English' },
  { value: 'zh-CN',  label: '简体中文' },
  { value: 'zh-CHT', label: '繁體中文' },
  { value: 'ru',     label: 'Русский' },
  { value: 'de',     label: 'Deutsch' },
  { value: 'fr',     label: 'Français' },
  { value: 'es',     label: 'Español' },
  { value: 'pt-BR',  label: 'Português (BR)' },
  { value: 'ko',     label: '한국어' },
  { value: 'ja',     label: '日本語' },
  { value: 'pl',     label: 'Polski' },
]

const language = ref('en')
const showLangDropdown = ref(false)

function detectSystemLanguage(): string {
  const sys = navigator.language.toLowerCase()
  if (sys.startsWith('zh'))
    return (sys.includes('tw') || sys.includes('hk') || sys.includes('hant')) ? 'zh-CHT' : 'zh-CN'
  if (sys.startsWith('ja')) return 'ja'
  if (sys.startsWith('ko')) return 'ko'
  if (sys.startsWith('fr')) return 'fr'
  if (sys.startsWith('de')) return 'de'
  if (sys.startsWith('es')) return 'es'
  if (sys.startsWith('ru')) return 'ru'
  if (sys.startsWith('pt')) return 'pt-BR'
  if (sys.startsWith('pl')) return 'pl'
  return 'en'
}

// ── Theme ──────────────────────────────────────────────────────────────────────
const isDark = ref(true)

function applyTheme(dark: boolean) {
  isDark.value = dark
  // Default (no class) = dark; `.light` opts into the light glass theme.
  document.documentElement.classList.toggle('light', !dark)
}

async function toggleTheme() {
  applyTheme(!isDark.value)
  await window.ipcRenderer.invoke('store:set-theme', isDark.value ? 'dark' : 'light')
}

onMounted(async () => {
  const [savedTheme, savedLang] = await Promise.all([
    window.ipcRenderer.invoke('store:get-theme'),
    window.ipcRenderer.invoke('store:get-language'),
  ])

  // Start dark by default; otherwise restore the user's last choice.
  const dark = savedTheme ? savedTheme === 'dark' : true
  if (!savedTheme) await window.ipcRenderer.invoke('store:set-theme', 'dark')
  applyTheme(dark)

  const lang = savedLang ?? detectSystemLanguage()
  if (!savedLang) await window.ipcRenderer.invoke('store:set-language', lang)
  language.value = lang
  locale.value = lang
})

async function setLanguage(lang: string) {
  language.value = lang
  locale.value = lang
  showLangDropdown.value = false
  await window.ipcRenderer.invoke('store:set-language', lang)
}

// ── Context menu for profiles ──────────────────────────────────────────────────
const profileMenu = ref(false)
const profileMenuX = ref(0)
const profileMenuY = ref(0)

function openProfileContextMenu(event: MouseEvent) {
  profileMenuX.value = event.clientX
  profileMenuY.value = event.clientY
  profileMenu.value = true
}

// Character portrait URL from ESI
function portraitUrl(charId: string): string {
  return `https://images.evetech.net/characters/${charId}/portrait?size=64`
}

// ── Favorites (pin master characters) ───────────────────────────────────────────
function toggleFavorite(id: string) {
  prefsStore.toggleFavorite(id)
}

// ── Multi-select / batch backup ─────────────────────────────────────────────────
const selectionMode = ref(false)
const selectedCards = ref<Set<string>>(new Set())

function toggleSelectionMode() {
  selectionMode.value = !selectionMode.value
  if (!selectionMode.value) selectedCards.value = new Set()
}

function toggleCardSelected(path: string) {
  const next = new Set(selectedCards.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  selectedCards.value = next
}

async function backupSelectedCards() {
  const files = settingsStore.charFiles.filter(f => selectedCards.value.has(f.path))
  if (!files.length) return
  for (const f of files) {
    const name = f.path.split(/[\\/]/).pop()?.replace(/\.dat$/, '') ?? f.id
    const displayName = f.charName ?? settingsStore.charNames[f.id]
    await backupStore.createFileBackup(f.path, name, displayName, currentSourceLabel())
  }
  pushToast(`Backed up ${files.length} ${files.length === 1 ? 'character' : 'characters'}`)
  selectionMode.value = false
  selectedCards.value = new Set()
}

// ── Help / About ────────────────────────────────────────────────────────────────
const helpDialog = ref(false)

// ── Source highlight helper (for the grid) ──────────────────────────────────────
function isLastSource(file: CharFile): boolean {
  return file.path === sourcePathForProfile()
}

// ── Search focus ──────────────────────────────────────────────────────────────
const searchInput = ref<HTMLInputElement | null>(null)
watch(activeTab, (tab) => {
  if (tab === 'characters') nextTick(() => searchInput.value?.focus())
})

// ── Keyboard: Esc closes the topmost overlay ─────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (renameDialog.value) { renameDialog.value = false; return }
  if (helpDialog.value) { helpDialog.value = false; return }
  if (warnDialog.value) { warnDialog.value = false; return }
  if (syncDialog.value) { syncDialog.value = false; return }
  if (backupDialog.value) { backupDialog.value = false; return }
  if (profileDialog.value) { profileDialog.value = false; return }
  if (profileMenu.value) { profileMenu.value = false; return }
  if (showLangDropdown.value) { showLangDropdown.value = false; return }
  if (selectionMode.value) { toggleSelectionMode(); return }
}
</script>

<template>
  <div class="h-full flex flex-col text-zinc-100 select-none">

    <!-- Ambient drifting orbs (sits above the veil, behind the UI) -->
    <div class="ambient" aria-hidden="true">
      <span class="orb orb-a"></span>
      <span class="orb orb-b"></span>
      <span class="orb orb-c"></span>
    </div>

    <!-- No folder found -->
    <div v-if="!serverStore.hasFolder && !serverStore.loadingFolder" class="flex-1 flex flex-col items-center justify-center gap-4">
      <svg class="w-16 h-16 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
      </svg>
      <p class="text-lg font-medium text-zinc-300">{{ t('emptyState.title') }}</p>
      <p class="text-sm text-zinc-500">{{ t('emptyState.sub') }}</p>
      <button
        class="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors"
        @click="selectFolder()"
      >
        {{ t('emptyState.selectFolder') }}
      </button>
    </div>

    <!-- Loading -->
    <div v-else-if="serverStore.loadingFolder" class="flex-1 flex items-center justify-center">
      <svg class="w-8 h-8 text-indigo-400 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </div>

    <!-- Main layout -->
    <template v-else>

      <!-- Top bar: server + profile + actions -->
      <header class="glass-panel relative z-30 flex items-center h-12 px-4 border-b flex-shrink-0 gap-3">
        <!-- Server selector -->
        <div class="flex items-center gap-1.5">
          <div
            v-for="server in serverStore.servers"
            :key="server.path"
            class="px-3 py-1 rounded-md text-sm font-medium cursor-pointer transition-all"
            :class="serverStore.activeServer?.path === server.path
              ? 'bg-indigo-600/25 text-indigo-300 ring-1 ring-indigo-400/40 glow-indigo'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5'"
            @click="serverStore.selectServer(server)"
          >
            {{ localizeServerName(server.displayName) }}
          </div>
        </div>

        <!-- Server status dot -->
        <div
          v-if="serverStore.serverStatus"
          class="w-2 h-2 rounded-full flex-shrink-0"
          :class="serverStore.serverStatus.online ? 'bg-emerald-400' : 'bg-red-400'"
          :title="serverStore.serverStatus.online ? 'Server Online' : 'Server Offline'"
        />

        <div class="flex-1" />

        <!-- Profile selector -->
        <div v-if="profileStore.profiles.length" class="flex items-center gap-1 bg-black/20 rounded-lg px-1 py-0.5 ring-1 ring-white/5">
          <button
            v-for="p in profileStore.profiles"
            :key="p.name"
            class="px-3 py-1 text-sm rounded-md transition-all"
            :class="profileStore.activeProfile?.name === p.name
              ? 'bg-white/12 text-zinc-100 font-medium shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200'"
            @click="profileStore.selectProfile(p)"
            @contextmenu.prevent="openProfileContextMenu"
          >
            {{ p.name }}
          </button>
          <button
            class="w-7 h-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/10 transition-colors"
            title="New profile"
            @click="openProfileDialog('create')"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>

        <!-- Utility buttons -->
        <div class="flex items-center gap-1">
          <!-- Theme toggle -->
          <button
            class="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/8 transition-colors"
            :title="isDark ? 'Switch to light theme' : 'Switch to dark theme'"
            @click="toggleTheme()"
          >
            <!-- Sun (shown in dark mode → click for light) -->
            <svg v-if="isDark" class="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
            </svg>
            <!-- Moon (shown in light mode → click for dark) -->
            <svg v-else class="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
            </svg>
          </button>
          <button
            class="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/8 transition-colors"
            title="Open folder"
            @click="selectFolder()"
          >
            <svg class="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
          </button>
          <!-- Language -->
          <div class="relative">
            <button
              class="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/8 transition-colors"
              @click="showLangDropdown = !showLangDropdown"
            >
              <svg class="w-4.5 h-4.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
              </svg>
            </button>
            <!-- Click-away (sits inside the header's stacking context, below the dropdown) -->
            <div v-if="showLangDropdown" class="fixed inset-0 z-40" @click="showLangDropdown = false" />
            <div
              v-if="showLangDropdown"
              class="glass-dialog absolute right-0 top-full mt-2 rounded-xl py-1 z-50 min-w-[150px]"
            >
              <button
                v-for="lang in LANGUAGES"
                :key="lang.value"
                class="w-full text-left px-3 py-1.5 text-sm transition-colors"
                :class="language === lang.value ? 'text-indigo-300 bg-indigo-500/15' : 'text-zinc-300 hover:bg-white/8'"
                @click="setLanguage(lang.value)"
              >
                {{ lang.label }}
              </button>
            </div>
          </div>
          <!-- GitHub -->
          <button
            class="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/8 transition-colors"
            title="GitHub"
            @click="openGitHub()"
          >
            <svg class="w-4.5 h-4.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836a9.59 9.59 0 012.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.741 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/>
            </svg>
          </button>
          <!-- Help / About -->
          <button
            class="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/8 transition-colors"
            title="Help &amp; About"
            @click="helpDialog = true"
          >
            <svg class="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
            </svg>
          </button>
        </div>
      </header>

      <!-- Tab navigation -->
      <nav class="flex items-center px-4 h-10 bg-black/15 border-b border-white/5 flex-shrink-0 gap-1">
        <button
          class="px-3 py-1.5 text-sm rounded-md font-medium transition-all"
          :class="activeTab === 'characters' ? 'text-zinc-100 bg-white/10' : 'text-zinc-500 hover:text-zinc-300'"
          @click="selectTab('characters')"
        >
          {{ t('table.characters') }}
          <span v-if="settingsStore.charFiles.length" class="ml-1.5 text-xs text-zinc-500">{{ searchQuery ? `${filteredCharFiles.length}/` : '' }}{{ settingsStore.charFiles.length }}</span>
        </button>
        <button
          class="px-3 py-1.5 text-sm rounded-md font-medium transition-all"
          :class="activeTab === 'accounts' ? 'text-zinc-100 bg-white/10' : 'text-zinc-500 hover:text-zinc-300'"
          @click="selectTab('accounts')"
        >
          {{ t('table.accounts') }}
          <span v-if="settingsStore.userFiles.length" class="ml-1.5 text-xs text-zinc-500">{{ settingsStore.userFiles.length }}</span>
        </button>
        <button
          class="px-3 py-1.5 text-sm rounded-md font-medium transition-all"
          :class="activeTab === 'backups' ? 'text-zinc-100 bg-white/10' : 'text-zinc-500 hover:text-zinc-300'"
          @click="selectTab('backups')"
        >
          Backups
          <span v-if="backupStore.backups.length" class="ml-1.5 text-xs text-zinc-500">{{ backupStore.backups.length }}</span>
        </button>

        <div class="flex-1" />

        <!-- Quick actions -->
        <button
          v-if="profileStore.activeProfile"
          class="px-3 py-1.5 text-xs font-medium bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 rounded-md ring-1 ring-indigo-400/20 transition-colors"
          @click="openBackupDialog()"
        >
          {{ t('actions.backup') }}
        </button>
        <button
          v-if="serverStore.activeServer"
          class="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-white/8 rounded-md transition-colors"
          @click="openServerFolder()"
        >
          {{ t('actions.openFolder') }}
        </button>
      </nav>

      <!-- Loading state -->
      <div v-if="settingsStore.loading" class="flex-1 flex items-center justify-center">
        <svg class="w-6 h-6 text-indigo-400 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>

      <!-- No profiles -->
      <div v-else-if="!profileStore.profiles.length" class="flex-1 flex flex-col items-center justify-center gap-3">
        <svg class="w-12 h-12 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
        <p class="text-zinc-400 font-medium">{{ t('table.noProfiles') }}</p>
        <p class="text-sm text-zinc-600">{{ t('table.noProfilesSub') }}</p>
      </div>

      <!-- Content area -->
      <div v-else class="flex-1 overflow-auto">

        <!-- Characters tab -->
        <div v-if="activeTab === 'characters'">
          <!-- Sticky controls: search + sort + filter + multi-select -->
          <div class="sticky top-0 z-10 px-4 pt-4 pb-3 bg-black/20 backdrop-blur-md border-b border-white/5 space-y-2.5">
            <div class="relative">
              <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              <input
                ref="searchInput"
                v-model="searchQuery"
                type="text"
                class="glass-input w-full pl-10 pr-20 py-2 rounded-lg text-sm text-zinc-200 placeholder-zinc-600"
                placeholder="Search characters by name or ID..."
              />
              <div v-if="searchQuery" class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                <span class="text-xs text-zinc-500">{{ filteredCharFiles.length }} / {{ settingsStore.charFiles.length }}</span>
                <button
                  class="w-5 h-5 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/10 transition-colors"
                  title="Clear search"
                  @click="searchQuery = ''"
                >
                  <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="flex items-center gap-2 text-xs">
              <!-- Sort -->
              <div class="flex items-center gap-1 glass-well rounded-lg p-0.5">
                <button
                  v-for="opt in [{ v: 'recent', l: 'Recent' }, { v: 'name', l: 'A–Z' }, { v: 'oldest', l: 'Oldest' }]"
                  :key="opt.v"
                  class="px-2.5 py-1 rounded-md transition-colors"
                  :class="sortMode === opt.v ? 'bg-white/12 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'"
                  @click="sortMode = opt.v as any"
                >{{ opt.l }}</button>
              </div>
              <!-- Last 24h filter -->
              <button
                class="px-2.5 py-1.5 rounded-lg transition-colors"
                :class="filterRecent ? 'bg-indigo-500/20 text-indigo-300 ring-1 ring-indigo-400/30' : 'glass-well text-zinc-400 hover:text-zinc-200'"
                @click="filterRecent = !filterRecent"
              >Last 24h</button>

              <div class="flex-1" />

              <!-- Multi-select toggle -->
              <button
                class="px-2.5 py-1.5 rounded-lg transition-colors"
                :class="selectionMode ? 'bg-indigo-500/20 text-indigo-300 ring-1 ring-indigo-400/30' : 'glass-well text-zinc-400 hover:text-zinc-200'"
                @click="toggleSelectionMode()"
              >{{ selectionMode ? 'Cancel' : 'Select' }}</button>
            </div>
          </div>

          <div class="p-4">
            <div v-if="!settingsStore.charFiles.length" class="text-center py-12 text-zinc-600">
              {{ t('table.noCharFiles') }}
            </div>
            <div v-else-if="!filteredCharFiles.length" class="text-center py-12 text-zinc-600">
              No characters matching "{{ searchQuery }}"
            </div>
            <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              <div
                v-for="char in filteredCharFiles"
                :key="char.path"
                class="glass-card group relative rounded-xl p-4"
                :class="[
                  selectionMode ? 'cursor-pointer' : 'cursor-default',
                  selectionMode && selectedCards.has(char.path) ? 'ring-2 ring-indigo-400/60' : '',
                  isLastSource(char) ? 'ring-1 ring-amber-400/40' : '',
                ]"
                @click="selectionMode && toggleCardSelected(char.path)"
              >
                <!-- Selection checkbox -->
                <div
                  v-if="selectionMode"
                  class="absolute top-2 right-2 w-5 h-5 rounded-md flex items-center justify-center transition-colors"
                  :class="selectedCards.has(char.path) ? 'bg-indigo-500 text-white' : 'bg-black/30 ring-1 ring-white/20'"
                >
                  <svg v-if="selectedCards.has(char.path)" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>

                <div class="flex items-start gap-3">
                  <!-- Portrait -->
                  <img
                    :src="portraitUrl(char.id)"
                    :alt="char.charName ?? char.id"
                    class="w-12 h-12 rounded-lg bg-white/5 ring-1 ring-white/10 flex-shrink-0"
                    loading="lazy"
                    @error="($event.target as HTMLImageElement).style.display = 'none'"
                  />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-1.5">
                      <h3 class="font-medium text-zinc-100 truncate">{{ char.charName ?? char.id }}</h3>
                      <span v-if="isLastSource(char)" class="text-[10px] font-semibold uppercase tracking-wide text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded flex-shrink-0">Source</span>
                    </div>
                    <p class="text-xs text-zinc-500 mt-1">{{ formatDateOnly(char.modifiedAt) }} · {{ formatRelative(char.modifiedAt) }}</p>
                  </div>
                  <!-- Favorite star -->
                  <button
                    v-if="!selectionMode"
                    class="flex-shrink-0 transition-colors"
                    :class="prefsStore.isFavorite(char.id) ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-400 opacity-0 group-hover:opacity-100'"
                    :title="prefsStore.isFavorite(char.id) ? 'Unpin' : 'Pin as favorite source'"
                    @click.stop="toggleFavorite(char.id)"
                  >
                    <svg class="w-4 h-4" :fill="prefsStore.isFavorite(char.id) ? 'currentColor' : 'none'" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                    </svg>
                  </button>
                </div>
                <!-- Actions -->
                <div v-if="!selectionMode" class="flex items-center gap-2 mt-3 pt-3 border-t border-white/8 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    class="flex-1 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/15 rounded-md transition-colors"
                    @click="openSyncDialog(char)"
                  >
                    Copy to...
                  </button>
                  <button
                    class="flex-1 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/15 rounded-md transition-colors"
                    @click="createFileBackupDirect(char)"
                  >
                    Backup
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Accounts tab -->
        <div v-if="activeTab === 'accounts'" class="p-4">
          <div v-if="!settingsStore.userFiles.length" class="text-center py-12 text-zinc-600">
            {{ t('table.noAccountFiles') }}
          </div>
          <div v-else class="space-y-2">
            <div
              v-for="user in settingsStore.userFiles"
              :key="user.path"
              class="glass-card group flex items-center gap-4 rounded-xl px-5 py-3"
            >
              <!-- Icon -->
              <div class="w-10 h-10 rounded-lg bg-white/5 ring-1 ring-white/10 flex items-center justify-center flex-shrink-0">
                <svg class="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-zinc-200 truncate">
                    {{ settingsStore.descriptions[user.filename] || ('Account ' + user.id) }}
                  </span>
                  <span class="text-xs text-zinc-600 flex-shrink-0">{{ formatDate(user.modifiedAt) }} · {{ formatRelative(user.modifiedAt) }}</span>
                </div>
                <!-- Editable account name / label -->
                <input
                  type="text"
                  class="mt-1 w-full bg-transparent border-none outline-none text-sm text-zinc-500 placeholder-zinc-700 focus:text-zinc-200"
                  placeholder="Set account name…"
                  :value="settingsStore.descriptions[user.filename] ?? ''"
                  @change="saveNote(user.filename, ($event.target as HTMLInputElement).value)"
                  @keydown.enter="($event.target as HTMLElement).blur()"
                />
              </div>
              <!-- Actions -->
              <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  class="px-3 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/15 rounded-md transition-colors"
                  @click="openSyncDialog(user)"
                >
                  Copy to...
                </button>
                <button
                  class="px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/15 rounded-md transition-colors"
                  @click="createFileBackupDirect(user)"
                >
                  Backup
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Backups tab -->
        <div v-if="activeTab === 'backups'" class="p-4">
          <div v-if="!backupStore.backups.length" class="text-center py-12 text-zinc-600">
            {{ t('sidebar.noBackups') }}
          </div>
          <div v-else class="space-y-2">
            <div
              v-for="backup in backupStore.backups"
              :key="backup.name + backup.createdAt"
              class="glass-card group flex items-center gap-4 rounded-xl px-5 py-3"
            >
              <!-- Icon -->
              <div class="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ring-1"
                :class="backup.type === 'folder' ? 'bg-amber-500/10 ring-amber-500/20' : 'bg-sky-500/10 ring-sky-500/20'"
              >
                <svg v-if="backup.type === 'folder'" class="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                </svg>
                <svg v-else class="w-5 h-5 text-sky-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              </div>
              <div class="flex-1 min-w-0">
                <span class="font-medium text-zinc-200">{{ backupDisplayName(backup) }}</span>
                <div class="flex items-center gap-3 mt-0.5">
                  <span class="text-xs text-zinc-600">{{ formatDateOnly(backup.createdAt) }} · {{ formatRelative(backup.createdAt) }}</span>
                  <span class="text-xs text-zinc-600">{{ backup.type === 'file' ? t('sidebar.singleFile') : t('sidebar.files', { n: backup.fileCount }) }}</span>
                  <span v-if="backup.source" class="text-xs text-zinc-600 truncate">· from {{ backup.source }}</span>
                </div>
              </div>
              <!-- Actions -->
              <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  class="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/8 transition-colors"
                  title="Rename"
                  @click="openRenameDialog(backup)"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                  </svg>
                </button>
                <button
                  class="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-indigo-400 hover:bg-indigo-600/10 transition-colors"
                  title="Show in folder"
                  @click="revealBackup(backup.path)"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                </button>
                <button
                  class="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-emerald-400 hover:bg-emerald-600/10 transition-colors"
                  title="Restore"
                  @click="backup.type === 'file' ? putBackFile(backup) : putBackFolder(backup)"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                </button>
                <button
                  class="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-600/10 transition-colors"
                  title="Delete"
                  @click="deleteBackupItem(backup)"
                >
                  <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

      </div>

      <!-- Floating batch-action bar (multi-select) -->
      <div
        v-if="selectionMode && selectedCards.size"
        class="glass-dialog fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-xl px-4 py-2.5"
      >
        <span class="text-sm text-zinc-300">{{ selectedCards.size }} selected</span>
        <button
          class="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
          @click="backupSelectedCards()"
        >
          Back up selected
        </button>
        <button
          class="px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-white/8 transition-colors"
          @click="toggleSelectionMode()"
        >
          Cancel
        </button>
      </div>
    </template>

    <!-- ═══════════ DIALOGS ═══════════ -->

    <!-- Profile dialog -->
    <Teleport to="body">
      <div v-if="profileDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" @click.self="profileDialog = false">
        <div class="glass-dialog rounded-2xl w-[360px] p-6">
          <h3 class="text-lg font-semibold text-zinc-100 mb-4">{{ profileDialogTitle }}</h3>
          <input
            v-model="profileName"
            type="text"
            class="glass-input w-full px-3 py-2 rounded-lg text-zinc-100 placeholder-zinc-600"
            :placeholder="t('profile.namePlaceholder')"
            autofocus
            @keydown.enter="confirmProfileDialog"
            @input="profileNameError = ''"
          />
          <p v-if="profileNameError" class="text-xs text-red-400 mt-2">{{ profileNameError }}</p>
          <div class="flex justify-end gap-2 mt-5">
            <button class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-white/8 transition-colors" @click="profileDialog = false">
              {{ t('dialog.cancel') }}
            </button>
            <button class="px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors" @click="confirmProfileDialog">
              {{ t('dialog.save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Backup name dialog -->
    <Teleport to="body">
      <div v-if="backupDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" @click.self="backupDialog = false">
        <div class="glass-dialog rounded-2xl w-[400px] p-6">
          <h3 class="text-lg font-semibold text-zinc-100 mb-4">{{ t('dialog.saveBackup') }}</h3>
          <input
            v-model="backupName"
            type="text"
            class="glass-input w-full px-3 py-2 rounded-lg text-zinc-100 placeholder-zinc-600"
            :placeholder="t('dialog.backupName')"
            autofocus
            @keydown.enter="confirmBackup"
          />
          <div class="flex justify-end gap-2 mt-5">
            <button class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-white/8 transition-colors" @click="backupDialog = false">
              {{ t('dialog.cancel') }}
            </button>
            <button
              class="px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              :disabled="!backupName.trim()"
              @click="confirmBackup"
            >
              {{ t('dialog.save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Sync picker dialog -->
    <Teleport to="body">
      <div v-if="syncDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" @click.self="syncDialog = false">
        <div class="glass-dialog rounded-2xl w-[720px] max-w-[90vw] p-6">
          <div class="mb-4">
            <h3 v-if="syncSource" class="text-lg font-semibold text-zinc-100 flex items-center flex-wrap gap-x-2 gap-y-1.5">
              <span>Sync from</span>
              <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-white/8 text-zinc-100">
                <img
                  v-if="syncSource.type === 'char'"
                  :src="portraitUrl(syncSource.id)"
                  class="w-5 h-5 rounded bg-white/5 ring-1 ring-white/10"
                  @error="($event.target as HTMLImageElement).style.display = 'none'"
                />
                {{ syncTargetLabel(syncSource) }}
              </span>
              <span>to which {{ syncSource.type === 'user' ? 'accounts' : 'characters' }}?</span>
            </h3>
            <h3 v-else class="text-lg font-semibold text-zinc-100">{{ t('dialog.syncTitle') }}</h3>
          </div>

          <div v-if="syncTargets.length" class="flex gap-5">
            <!-- Left: the pool to pick from -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between mb-2 h-7">
                <span class="text-xs font-medium text-zinc-500 uppercase tracking-wide">
                  {{ syncSource?.type === 'user' ? 'All Accounts' : 'All Characters' }} ({{ syncTargets.length }})
                </span>
                <div class="flex items-center gap-1 glass-well rounded-md p-0.5">
                  <button
                    class="px-2 py-0.5 text-xs rounded transition-colors"
                    :class="syncSort === 'name' ? 'bg-white/12 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'"
                    @click="syncSort = 'name'"
                  >Name</button>
                  <button
                    class="px-2 py-0.5 text-xs rounded transition-colors"
                    :class="syncSort === 'recent' ? 'bg-white/12 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'"
                    @click="syncSort = 'recent'"
                  >Last used</button>
                </div>
              </div>

              <!-- Search within targets + select-all -->
              <div class="flex items-center gap-2 mb-2">
                <div class="relative flex-1">
                  <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                  </svg>
                  <input
                    v-model="syncSearch"
                    type="text"
                    class="glass-input w-full pl-9 pr-3 py-1.5 rounded-lg text-sm text-zinc-200 placeholder-zinc-600"
                    placeholder="Filter..."
                  />
                </div>
                <button
                  v-if="!syncSearch"
                  class="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 ring-1 ring-indigo-400/20 transition-colors whitespace-nowrap"
                  @click="toggleSyncAll()"
                >{{ syncAllChecked ? 'Deselect all' : t('dialog.selectAll') }}</button>
                <button
                  v-else
                  class="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 ring-1 ring-indigo-400/20 transition-colors whitespace-nowrap"
                  @click="selectAllFiltered()"
                >Select all {{ filteredSyncTargets.length }}</button>
              </div>

              <!-- Target list -->
              <div class="glass-well h-[320px] overflow-auto space-y-0.5 rounded-lg p-1">
                <div
                  v-for="file in filteredSyncTargets"
                  :key="file.path"
                  class="flex items-center gap-2 text-sm py-1.5 px-2 rounded-md cursor-pointer transition-colors"
                  :class="syncSelected.includes(file.path)
                    ? 'text-zinc-200 bg-indigo-500/15'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/6'"
                  @click="toggleSyncTarget(file.path)"
                >
                  <img
                    v-if="file.type === 'char'"
                    :src="portraitUrl(file.id)"
                    class="w-5 h-5 rounded bg-white/5 ring-1 ring-white/10 flex-shrink-0"
                    loading="lazy"
                    @error="($event.target as HTMLImageElement).style.display = 'none'"
                  />
                  <span class="truncate text-xs flex-1">{{ syncTargetLabel(file) }}</span>
                  <span class="text-[10px] text-zinc-600 flex-shrink-0">{{ formatRelative(file.modifiedAt) }}</span>
                  <svg
                    v-if="syncSelected.includes(file.path)"
                    class="w-3.5 h-3.5 text-indigo-300 flex-shrink-0"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <p v-if="syncSearch && !filteredSyncTargets.length" class="text-xs text-zinc-600 py-3 text-center">
                  No matches for "{{ syncSearch }}"
                </p>
              </div>
            </div>

            <!-- Soft vertical separator between the two columns -->
            <div class="col-divider self-stretch" aria-hidden="true"></div>

            <!-- Right: the chosen recipients (a clean summary, not a mirror toolbar) -->
            <div class="w-[240px] flex-shrink-0">
              <div class="flex items-center justify-between mb-2 h-7">
                <span class="text-xs font-medium text-indigo-300/90 uppercase tracking-wide">
                  Selected ({{ syncSelected.length }})
                </span>
              </div>
              <!-- Clear button row, aligned to mirror the left's Select all -->
              <div class="flex items-center justify-end mb-2 h-[34px]">
                <button
                  class="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 ring-1 ring-indigo-400/20 transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-indigo-500/15"
                  :disabled="!syncSelected.length"
                  @click="syncSelected = []"
                >Clear</button>
              </div>
              <div class="glass-well h-[320px] overflow-auto space-y-0.5 rounded-lg p-1">
                <div
                  v-for="file in selectedSyncTargets"
                  :key="'sel-' + file.path"
                  class="flex items-center gap-2 text-xs text-zinc-300 py-1.5 px-2 rounded-md group hover:bg-white/6"
                >
                  <img
                    v-if="file.type === 'char'"
                    :src="portraitUrl(file.id)"
                    class="w-5 h-5 rounded bg-white/5 ring-1 ring-white/10 flex-shrink-0"
                    loading="lazy"
                    @error="($event.target as HTMLImageElement).style.display = 'none'"
                  />
                  <span class="truncate flex-1">{{ syncTargetLabel(file) }}</span>
                  <button
                    class="w-4 h-4 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    @click="toggleSyncTarget(file.path)"
                  >
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <p v-if="!selectedSyncTargets.length" class="text-xs text-zinc-600 py-6 text-center">
                  No characters selected
                </p>
              </div>
            </div>
          </div>

          <!-- Copy sets + auto-backup -->
          <div v-if="syncTargets.length" class="mt-3 flex items-center gap-2 flex-wrap">
            <span class="text-xs text-zinc-500">Sets:</span>
            <button
              v-for="set in relevantCopySets"
              :key="set.name"
              class="group/set flex items-center gap-1 px-2 py-1 text-xs rounded-md glass-well text-zinc-300 hover:text-zinc-100 transition-colors"
              @click="applyCopySet(set.name)"
            >
              {{ set.name }}
              <span class="text-zinc-600">({{ set.ids.length }})</span>
              <span
                class="text-zinc-600 hover:text-red-400 opacity-0 group-hover/set:opacity-100"
                title="Delete set"
                @click.stop="prefsStore.deleteCopySet(set.name)"
              >✕</span>
            </button>
            <button
              class="px-2 py-1 text-xs rounded-md text-indigo-300 hover:bg-indigo-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              :disabled="!syncSelected.length"
              @click="saveCurrentAsSet()"
            >+ Save current as set</button>
          </div>

          <div v-if="!syncTargets.length">
            <p class="text-sm text-zinc-500">{{ t('dialog.syncNoTargets') }}</p>
          </div>

          <!-- Warning + auto-backup -->
          <div v-if="syncTargets.length" class="flex items-center gap-2 mt-4 px-2.5 py-2 bg-amber-400/8 border border-amber-400/15 rounded-lg text-xs text-amber-200/90">
            <svg class="w-4 h-4 flex-shrink-0 text-amber-300/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            {{ t('warn.suggest') }}
          </div>

          <label v-if="syncTargets.length" class="flex items-center gap-2 mt-3 text-sm text-zinc-300 cursor-pointer">
            <input
              v-model="backupFirst"
              type="checkbox"
              class="w-4 h-4 rounded border-zinc-600 bg-zinc-900 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
            />
            Create a restore point before copying (recommended)
          </label>

          <div class="flex justify-end gap-2 mt-4">
            <button class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-white/8 transition-colors" @click="syncDialog = false">
              {{ t('dialog.cancel') }}
            </button>
            <button
              class="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              :disabled="!syncSelected.length"
              @click="confirmSync"
            >
              {{ t('dialog.sync') }} ({{ syncSelected.length }})
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Warning dialog -->
    <Teleport to="body">
      <div v-if="warnDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" @click.self="warnDialog = false">
        <div class="glass-dialog rounded-2xl w-[400px] p-6">
          <h3 class="text-lg font-semibold text-zinc-100 mb-3">{{ warnTitle || t('warn.title') }}</h3>
          <p class="text-sm text-zinc-400">{{ warnDetail }}</p>
          <div class="flex justify-end gap-2 mt-5">
            <button class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-white/8 transition-colors" @click="warnDialog = false">
              {{ t('dialog.cancel') }}
            </button>
            <button
              class="px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors"
              :class="warnType === 'danger' ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'"
              @click="proceedWarn"
            >
              {{ t('warn.proceed') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Profile context menu -->
    <Teleport to="body">
      <div
        v-if="profileMenu"
        class="fixed inset-0 z-40"
        @click="profileMenu = false"
        @contextmenu.prevent="profileMenu = false"
      >
        <div
          class="glass-dialog absolute rounded-xl py-1 min-w-[150px]"
          :style="{ left: profileMenuX + 'px', top: profileMenuY + 'px' }"
        >
          <button class="w-full text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/8" @click="openProfileDialog('rename')">
            {{ t('profile.rename') }}
          </button>
          <button class="w-full text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/8" @click="openProfileDialog('duplicate')">
            {{ t('profile.duplicate') }}
          </button>
          <button class="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-white/8" @click="confirmDeleteProfile()">
            {{ t('profile.delete') }}
          </button>
        </div>
      </div>
    </Teleport>

    <!-- Backup rename dialog -->
    <Teleport to="body">
      <div v-if="renameDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" @click.self="renameDialog = false">
        <div class="glass-dialog rounded-2xl w-[400px] p-6">
          <h3 class="text-lg font-semibold text-zinc-100 mb-4">Rename backup</h3>
          <input
            v-model="renameValue"
            type="text"
            class="glass-input w-full px-3 py-2 rounded-lg text-zinc-100 placeholder-zinc-600"
            autofocus
            @keydown.enter="confirmRename"
          />
          <div class="flex justify-end gap-2 mt-5">
            <button class="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-white/8 transition-colors" @click="renameDialog = false">
              {{ t('dialog.cancel') }}
            </button>
            <button
              class="px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              :disabled="!renameValue.trim()"
              @click="confirmRename"
            >
              {{ t('dialog.save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Help / About dialog -->
    <Teleport to="body">
      <div v-if="helpDialog" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md" @click.self="helpDialog = false">
        <div class="glass-dialog rounded-2xl w-[560px] max-w-[90vw] max-h-[80vh] overflow-auto p-6">
          <h3 class="text-lg font-semibold text-zinc-100 mb-1">EVE Settings Manager</h3>
          <p class="text-xs text-zinc-500 mb-4">Manage your local EVE Online settings — copy layouts between characters, back up profiles, and keep notes on accounts.</p>

          <h4 class="text-sm font-semibold text-zinc-200 mt-4 mb-1">How it works</h4>
          <p class="text-sm text-zinc-400">Configure one character or account in-game, then use <span class="text-indigo-300">Copy to…</span> to apply those settings to your others. A restore point is created before each copy, and you can <span class="text-indigo-300">Undo</span> the last copy from the toast.</p>

          <h4 class="text-sm font-semibold text-zinc-200 mt-4 mb-1">Settings folder locations</h4>
          <div class="glass-well rounded-lg p-3 text-xs text-zinc-400 space-y-1">
            <div class="flex gap-2"><span class="w-16 text-zinc-500 flex-shrink-0">macOS</span><code>~/Library/Application Support/CCP/EVE</code></div>
            <div class="flex gap-2"><span class="w-16 text-zinc-500 flex-shrink-0">Windows</span><code>%LOCALAPPDATA%\CCP\EVE</code></div>
            <div class="flex gap-2"><span class="w-16 text-zinc-500 flex-shrink-0">Linux</span><span>varies by Wine / Proton prefix</span></div>
          </div>

          <h4 class="text-sm font-semibold text-zinc-200 mt-4 mb-1">Data &amp; privacy</h4>
          <p class="text-sm text-zinc-400">Everything is stored locally — nothing is sent to any server (character-name lookups use the official EVE ESI API and contain no personal data). App data lives in:</p>
          <div class="glass-well rounded-lg p-3 text-xs text-zinc-400 space-y-1 mt-1">
            <div class="flex gap-2"><span class="w-16 text-zinc-500 flex-shrink-0">macOS</span><code>~/Library/Application Support/eve-settings-manager</code></div>
            <div class="flex gap-2"><span class="w-16 text-zinc-500 flex-shrink-0">Windows</span><code>%APPDATA%\eve-settings-manager</code></div>
            <div class="flex gap-2"><span class="w-16 text-zinc-500 flex-shrink-0">Linux</span><code>~/.config/eve-settings-manager</code></div>
          </div>

          <div class="flex justify-between items-center mt-5">
            <button class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors" @click="openGitHub()">View on GitHub ↗</button>
            <button class="px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors" @click="helpDialog = false">Close</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Toasts -->
    <Teleport to="body">
      <div class="fixed bottom-6 right-6 z-[60] flex flex-col gap-2 items-end">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="glass-dialog flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-zinc-200 min-w-[240px] max-w-[360px]"
        >
          <span class="flex-1">{{ toast.message }}</span>
          <button
            v-if="toast.action"
            class="px-2.5 py-1 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/15 rounded-md transition-colors"
            @click="toast.action.fn(); dismissToast(toast.id)"
          >{{ toast.action.label }}</button>
          <button class="text-zinc-500 hover:text-zinc-300" @click="dismissToast(toast.id)">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </Teleport>

  </div>
</template>
