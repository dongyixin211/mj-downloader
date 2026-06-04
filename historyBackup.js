/**
 * 下载/查询记录备份：导出、合并导入、与仓库 data/mj-history-backup.json 同步。
 * 仅在 background service worker 中加载。
 */
const HISTORY_BACKUP_VERSION = 1
const HISTORY_BACKUP_PATH = "data/mj-history-backup.json"
const LAST_IMPORTED_BACKUP_AT_KEY = "bdduckLastImportedBackupExportedAt"

async function exportAllDownloadHistoryRecords() {
  const db = await openDownloadHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_HISTORY_STORE, "readonly")
    const req = tx.objectStore(DOWNLOAD_HISTORY_STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

async function exportAllPromptHistoryRecords() {
  const db = await openPromptHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROMPT_HISTORY_STORE, "readonly")
    const req = tx.objectStore(PROMPT_HISTORY_STORE).getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  })
}

async function buildHistoryBackupPayload() {
  const [downloadHistory, promptHistory] = await Promise.all([
    exportAllDownloadHistoryRecords(),
    exportAllPromptHistoryRecords(),
  ])
  return {
    version: HISTORY_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    downloadHistory,
    promptHistory,
  }
}

/** 仅追加/合并：不删除 IndexedDB 中已有、备份里没有的记录 */
async function importDownloadHistoryRecords(records) {
  if (!Array.isArray(records) || !records.length) {
    return { imported: 0 }
  }
  const db = await openDownloadHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_HISTORY_STORE, "readwrite")
    const store = tx.objectStore(DOWNLOAD_HISTORY_STORE)
    let imported = 0
    for (const rec of records) {
      if (!rec?.key) continue
      store.put({
        key: rec.key,
        downloadedAt: Number(rec.downloadedAt) || Date.now(),
      })
      imported++
    }
    tx.oncomplete = () => resolve({ imported })
    tx.onerror = () => reject(tx.error)
  })
}

async function importPromptHistoryRecords(records) {
  if (!Array.isArray(records) || !records.length) {
    return { imported: 0 }
  }
  const db = await openPromptHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROMPT_HISTORY_STORE, "readwrite")
    const store = tx.objectStore(PROMPT_HISTORY_STORE)
    let imported = 0
    for (const rec of records) {
      if (!rec?.key) continue
      store.put({
        key: rec.key,
        prompt: rec.prompt || rec.key,
        queriedAt: Number(rec.queriedAt) || Date.now(),
        imageCount: Number(rec.imageCount) || 0,
        downloadedCount: Number(rec.downloadedCount) || 0,
      })
      imported++
    }
    tx.oncomplete = () => resolve({ imported })
    tx.onerror = () => reject(tx.error)
  })
}

async function importCombinedHistoryBackup(backup) {
  if (!backup || backup.version !== HISTORY_BACKUP_VERSION) {
    throw new Error("备份格式无效或版本不匹配")
  }
  const [downloadResult, promptResult] = await Promise.all([
    importDownloadHistoryRecords(backup.downloadHistory),
    importPromptHistoryRecords(backup.promptHistory),
  ])
  return {
    downloadImported: downloadResult.imported,
    promptImported: promptResult.imported,
  }
}

async function importBundledHistoryBackupIfNeeded() {
  try {
    const url = chrome.runtime.getURL(HISTORY_BACKUP_PATH)
    const response = await fetch(url)
    if (!response.ok) return { skipped: true, reason: "no_file" }

    const backup = await response.json()
    const total =
      (backup.downloadHistory?.length || 0) +
      (backup.promptHistory?.length || 0)
    if (total === 0) return { skipped: true, reason: "empty" }

    const { [LAST_IMPORTED_BACKUP_AT_KEY]: lastAt } =
      await chrome.storage.local.get(LAST_IMPORTED_BACKUP_AT_KEY)
    if (backup.exportedAt && lastAt === backup.exportedAt) {
      return { skipped: true, reason: "already_imported" }
    }

    const result = await importCombinedHistoryBackup(backup)
    if (backup.exportedAt) {
      await chrome.storage.local.set({
        [LAST_IMPORTED_BACKUP_AT_KEY]: backup.exportedAt,
      })
    }
    return { skipped: false, ...result }
  } catch (error) {
    console.warn("导入仓库历史备份失败:", error)
    return { skipped: true, reason: "error", error: error.message }
  }
}

async function downloadHistoryBackupFile(backup) {
  const json = JSON.stringify(backup, null, 2)
  const blob = new Blob([json], { type: "application/json;charset=utf-8" })
  const objectUrl = URL.createObjectURL(blob)
  const filename = "mj-history-backup.json"
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: objectUrl,
        filename,
        saveAs: false,
        conflictAction: "overwrite",
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        if (!downloadId) {
          URL.revokeObjectURL(objectUrl)
          reject(new Error("导出下载任务创建失败"))
          return
        }
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000)
        resolve({ downloadId, filename })
      },
    )
  })
}
