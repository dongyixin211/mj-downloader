/**
 * 将 IndexedDB 记录同步到项目 data/ 目录（可提交 Git）。
 * 需在批量页绑定本项目的 data 文件夹；绑定后每次新增记录会自动写入。
 */
const PROJECT_SYNC_DB = "bdduck_project_sync"
const PROJECT_SYNC_STORE = "handles"
const PROJECT_DATA_DIR_HANDLE_KEY = "dataDir"
const PROJECT_DATA_DIR_NAME_KEY = "bdduckProjectDataDirName"
const PROJECT_HISTORY_VERSION = 1
const DOWNLOAD_HISTORY_FILE = "download-history.json"
const PROMPT_HISTORY_FILE = "prompt-history.json"
const LAST_IMPORTED_DOWNLOAD_AT_KEY = "bdduckLastImportedDownloadHistoryAt"
const LAST_IMPORTED_PROMPT_AT_KEY = "bdduckLastImportedPromptHistoryAt"

let projectSyncDebounceTimer = null

function openProjectSyncDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROJECT_SYNC_DB, 1)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = (event) => {
      const db = event.target.result
      if (!db.objectStoreNames.contains(PROJECT_SYNC_STORE)) {
        db.createObjectStore(PROJECT_SYNC_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

async function saveProjectDataDirHandle(handle, displayName) {
  const db = await openProjectSyncDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_SYNC_STORE, "readwrite")
    tx.objectStore(PROJECT_SYNC_STORE).put(handle, PROJECT_DATA_DIR_HANDLE_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  await chrome.storage.local.set({
    [PROJECT_DATA_DIR_NAME_KEY]: displayName || "",
  })
}

async function getProjectDataDirHandle() {
  const db = await openProjectSyncDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_SYNC_STORE, "readonly")
    const req = tx.objectStore(PROJECT_SYNC_STORE).get(PROJECT_DATA_DIR_HANDLE_KEY)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}

async function ensureProjectDirPermission(handle) {
  if (!handle) return false
  let permission = await handle.queryPermission({ mode: "readwrite" })
  if (permission === "granted") return true
  permission = await handle.requestPermission({ mode: "readwrite" })
  return permission === "granted"
}

async function writeJsonToProjectDir(handle, filename, payload) {
  const fileHandle = await handle.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(payload, null, 2))
  await writable.close()
}

async function buildDownloadHistoryFilePayload() {
  const records = await exportAllDownloadHistoryRecords()
  return {
    version: PROJECT_HISTORY_VERSION,
    updatedAt: new Date().toISOString(),
    recordCount: records.length,
    records,
  }
}

async function buildPromptHistoryFilePayload() {
  const records = await exportAllPromptHistoryRecords()
  return {
    version: PROJECT_HISTORY_VERSION,
    updatedAt: new Date().toISOString(),
    recordCount: records.length,
    records,
  }
}

async function syncAllHistoryToProjectFiles() {
  const handle = await getProjectDataDirHandle()
  if (!handle) {
    return { ok: false, reason: "no_dir" }
  }
  if (!(await ensureProjectDirPermission(handle))) {
    return { ok: false, reason: "permission_denied" }
  }

  const [downloadPayload, promptPayload] = await Promise.all([
    buildDownloadHistoryFilePayload(),
    buildPromptHistoryFilePayload(),
  ])

  await writeJsonToProjectDir(handle, DOWNLOAD_HISTORY_FILE, downloadPayload)
  await writeJsonToProjectDir(handle, PROMPT_HISTORY_FILE, promptPayload)

  return {
    ok: true,
    downloadCount: downloadPayload.recordCount,
    promptCount: promptPayload.recordCount,
    updatedAt: downloadPayload.updatedAt,
  }
}

function scheduleProjectHistorySync() {
  clearTimeout(projectSyncDebounceTimer)
  projectSyncDebounceTimer = setTimeout(() => {
    syncAllHistoryToProjectFiles().catch((error) => {
      console.warn("同步记录到项目 data/ 失败:", error)
    })
  }, 1500)
}

async function getProjectSyncStatus() {
  const { [PROJECT_DATA_DIR_NAME_KEY]: dirName } =
    await chrome.storage.local.get(PROJECT_DATA_DIR_NAME_KEY)
  const handle = await getProjectDataDirHandle()
  const [downloadCount, promptCount] = await Promise.all([
    getDownloadHistoryCount(),
    getPromptHistoryCount(),
  ])
  return {
    bound: Boolean(handle),
    dirName: dirName || "",
    downloadCount,
    promptCount,
    files: {
      download: `data/${DOWNLOAD_HISTORY_FILE}`,
      prompt: `data/${PROMPT_HISTORY_FILE}`,
    },
  }
}

async function importHistoryFileFromBundled(relativePath, importFn, lastImportedKey) {
  try {
    const url = chrome.runtime.getURL(relativePath)
    const response = await fetch(url)
    if (!response.ok) return { skipped: true, reason: "no_file" }

    const payload = await response.json()
    const records = payload.records || payload.downloadHistory || payload.promptHistory
    if (!Array.isArray(records) || !records.length) {
      return { skipped: true, reason: "empty" }
    }

    const { [lastImportedKey]: lastAt } = await chrome.storage.local.get(lastImportedKey)
    if (payload.updatedAt && lastAt === payload.updatedAt) {
      return { skipped: true, reason: "already_imported", count: records.length }
    }

    const result = await importFn(records)
    if (payload.updatedAt) {
      await chrome.storage.local.set({ [lastImportedKey]: payload.updatedAt })
    }
    return { skipped: false, imported: result.imported, count: records.length }
  } catch (error) {
    console.warn(`导入 ${relativePath} 失败:`, error)
    return { skipped: true, reason: "error", error: error.message }
  }
}

async function importProjectHistoryFromBundledFiles() {
  const [downloadResult, promptResult] = await Promise.all([
    importHistoryFileFromBundled(
      `data/${DOWNLOAD_HISTORY_FILE}`,
      importDownloadHistoryRecords,
      LAST_IMPORTED_DOWNLOAD_AT_KEY,
    ),
    importHistoryFileFromBundled(
      `data/${PROMPT_HISTORY_FILE}`,
      importPromptHistoryRecords,
      LAST_IMPORTED_PROMPT_AT_KEY,
    ),
  ])
  return { download: downloadResult, prompt: promptResult }
}
