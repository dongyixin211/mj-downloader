/**
 * 从项目 data/*.json 合并导入 IndexedDB（仅追加/更新）。
 */
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
