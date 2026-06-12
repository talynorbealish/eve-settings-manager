import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface CopySet {
  name: string
  type: 'char' | 'user'
  ids: string[]
}

/**
 * Generic local UI preferences, persisted via the main-process electron-store
 * (store:get-pref / store:set-pref). Covers copy sets, favorite source
 * characters, the last source used per profile, and the last active tab.
 */
export const usePrefsStore = defineStore('prefs', () => {
  const copySets = ref<CopySet[]>([])
  const favorites = ref<string[]>([])          // character ids pinned as sources
  const lastSource = ref<Record<string, string>>({}) // profilePath → source file path
  const lastTab = ref<'characters' | 'accounts' | 'backups'>('characters')

  async function load() {
    copySets.value = (await window.ipcRenderer.invoke('store:get-pref', 'copySets')) ?? []
    favorites.value = (await window.ipcRenderer.invoke('store:get-pref', 'favorites')) ?? []
    lastSource.value = (await window.ipcRenderer.invoke('store:get-pref', 'lastSource')) ?? {}
    lastTab.value = (await window.ipcRenderer.invoke('store:get-pref', 'lastTab')) ?? 'characters'
  }

  async function setLastTab(tab: 'characters' | 'accounts' | 'backups') {
    lastTab.value = tab
    await window.ipcRenderer.invoke('store:set-pref', 'lastTab', tab)
  }

  async function toggleFavorite(id: string) {
    const i = favorites.value.indexOf(id)
    if (i >= 0) favorites.value.splice(i, 1)
    else favorites.value.push(id)
    await window.ipcRenderer.invoke('store:set-pref', 'favorites', [...favorites.value])
  }

  function isFavorite(id: string): boolean {
    return favorites.value.includes(id)
  }

  async function setLastSource(profilePath: string, sourcePath: string) {
    lastSource.value = { ...lastSource.value, [profilePath]: sourcePath }
    await window.ipcRenderer.invoke('store:set-pref', 'lastSource', { ...lastSource.value })
  }

  async function saveCopySet(set: CopySet) {
    const existing = copySets.value.findIndex(s => s.name.toLowerCase() === set.name.toLowerCase())
    if (existing >= 0) copySets.value.splice(existing, 1, set)
    else copySets.value.push(set)
    await window.ipcRenderer.invoke('store:set-pref', 'copySets', JSON.parse(JSON.stringify(copySets.value)))
  }

  async function deleteCopySet(name: string) {
    copySets.value = copySets.value.filter(s => s.name !== name)
    await window.ipcRenderer.invoke('store:set-pref', 'copySets', JSON.parse(JSON.stringify(copySets.value)))
  }

  return {
    copySets, favorites, lastSource, lastTab,
    load, setLastTab, toggleFavorite, isFavorite, setLastSource, saveCopySet, deleteCopySet,
  }
})
