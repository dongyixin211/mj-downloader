/**
 * 下载历史：IndexedDB 持久化，按「任务ID/索引」短 key 存储，适合大量图片。
 * 仅在 background service worker 中通过 importScripts 加载。
 */
const DOWNLOAD_HISTORY_DB = "bdduck_mj_download_history"
const DOWNLOAD_HISTORY_STORE = "images"
const DOWNLOAD_HISTORY_VERSION = 1

/** 从 CDN URL 生成稳定短 key（webp/png 同一 key） */
function imageKeyFromUrl(url) {
  if (!url) return ""
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split("/").filter(Boolean)
    if (segments.length >= 2) {
      const jobId = segments[segments.length - 2]
      const fileStem = segments[segments.length - 1].replace(
        /\.(webp|png|jpe?g|gif)$/i,
        "",
      )
      return `${jobId}/${fileStem}`
    }
    return parsed.pathname || url
  } catch {
    return url
  }
}

let downloadHistoryDbPromise = null

function openDownloadHistoryDb() {
  if (!downloadHistoryDbPromise) {
    downloadHistoryDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(
        DOWNLOAD_HISTORY_DB,
        DOWNLOAD_HISTORY_VERSION,
      )
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
      request.onupgradeneeded = (event) => {
        const db = event.target.result
        if (!db.objectStoreNames.contains(DOWNLOAD_HISTORY_STORE)) {
          const store = db.createObjectStore(DOWNLOAD_HISTORY_STORE, {
            keyPath: "key",
          })
          store.createIndex("downloadedAt", "downloadedAt", { unique: false })
        }
      }
    })
  }
  return downloadHistoryDbPromise
}

async function markImageDownloaded(url) {
  const key = imageKeyFromUrl(url)
  if (!key) return null
  const db = await openDownloadHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_HISTORY_STORE, "readwrite")
    tx.objectStore(DOWNLOAD_HISTORY_STORE).put({
      key,
      downloadedAt: Date.now(),
    })
    tx.oncomplete = () => resolve(key)
    tx.onerror = () => reject(tx.error)
  })
}

async function isImageDownloaded(url) {
  const key = imageKeyFromUrl(url)
  if (!key) return false
  const db = await openDownloadHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_HISTORY_STORE, "readonly")
    const req = tx.objectStore(DOWNLOAD_HISTORY_STORE).get(key)
    req.onsuccess = () => resolve(Boolean(req.result))
    req.onerror = () => reject(req.error)
  })
}

/** 批量筛选：返回未下载的 URL 列表（单次事务内多次 get，适合大批量） */
async function filterUrlsNotDownloaded(urls) {
  if (!urls?.length) {
    return { notDownloaded: [], downloaded: [], skippedCount: 0 }
  }

  const db = await openDownloadHistoryDb()
  const entries = urls.map((url) => ({ url, key: imageKeyFromUrl(url) }))

  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_HISTORY_STORE, "readonly")
    const store = tx.objectStore(DOWNLOAD_HISTORY_STORE)
    const notDownloaded = []
    const downloaded = []
    let pending = entries.length

    const finishOne = () => {
      pending--
      if (pending === 0) {
        resolve({
          notDownloaded,
          downloaded,
          skippedCount: downloaded.length,
        })
      }
    }

    for (const { url, key } of entries) {
      if (!key) {
        notDownloaded.push(url)
        finishOne()
        continue
      }
      const req = store.get(key)
      req.onsuccess = () => {
        if (req.result) downloaded.push(url)
        else notDownloaded.push(url)
        finishOne()
      }
      req.onerror = () => reject(req.error)
    }
  })
}

async function getDownloadHistoryCount() {
  const db = await openDownloadHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_HISTORY_STORE, "readonly")
    const req = tx.objectStore(DOWNLOAD_HISTORY_STORE).count()
    req.onsuccess = () => resolve(req.result ?? 0)
    req.onerror = () => reject(req.error)
  })
}

async function clearDownloadHistory() {
  const db = await openDownloadHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOWNLOAD_HISTORY_STORE, "readwrite")
    tx.objectStore(DOWNLOAD_HISTORY_STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
