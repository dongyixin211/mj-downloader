/**
 * 提示词查询历史：IndexedDB 持久化，避免重复查询。
 */
const PROMPT_HISTORY_DB = "bdduck_mj_prompt_history"
const PROMPT_HISTORY_STORE = "prompts"
const PROMPT_HISTORY_VERSION = 1

function normalizePromptKey(prompt) {
  if (!prompt) return ""
  return String(prompt).trim().replace(/\s+/g, " ").toLowerCase()
}

let promptHistoryDbPromise = null

function openPromptHistoryDb() {
  if (!promptHistoryDbPromise) {
    promptHistoryDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(PROMPT_HISTORY_DB, PROMPT_HISTORY_VERSION)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
      request.onupgradeneeded = (event) => {
        const db = event.target.result
        if (!db.objectStoreNames.contains(PROMPT_HISTORY_STORE)) {
          const store = db.createObjectStore(PROMPT_HISTORY_STORE, {
            keyPath: "key",
          })
          store.createIndex("queriedAt", "queriedAt", { unique: false })
        }
      }
    })
  }
  return promptHistoryDbPromise
}

async function markPromptQueried(prompt, meta = {}) {
  const key = normalizePromptKey(prompt)
  if (!key) return null
  const db = await openPromptHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROMPT_HISTORY_STORE, "readwrite")
    tx.objectStore(PROMPT_HISTORY_STORE).put({
      key,
      prompt: String(prompt).trim(),
      queriedAt: Date.now(),
      imageCount: meta.imageCount ?? 0,
      downloadedCount: meta.downloadedCount ?? 0,
    })
    tx.oncomplete = () => resolve(key)
    tx.onerror = () => reject(tx.error)
  })
}

async function isPromptQueried(prompt) {
  const key = normalizePromptKey(prompt)
  if (!key) return false
  const db = await openPromptHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROMPT_HISTORY_STORE, "readonly")
    const req = tx.objectStore(PROMPT_HISTORY_STORE).get(key)
    req.onsuccess = () => resolve(Boolean(req.result))
    req.onerror = () => reject(req.error)
  })
}

async function filterPromptsNotQueried(prompts) {
  if (!prompts?.length) {
    return { notQueried: [], queried: [], skippedCount: 0 }
  }
  const db = await openPromptHistoryDb()
  const entries = prompts.map((prompt) => ({
    prompt,
    key: normalizePromptKey(prompt),
  }))

  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROMPT_HISTORY_STORE, "readonly")
    const store = tx.objectStore(PROMPT_HISTORY_STORE)
    const notQueried = []
    const queried = []
    let pending = entries.length

    const finishOne = () => {
      pending--
      if (pending === 0) {
        resolve({
          notQueried,
          queried,
          skippedCount: queried.length,
        })
      }
    }

    for (const { prompt, key } of entries) {
      if (!key) {
        notQueried.push(prompt)
        finishOne()
        continue
      }
      const req = store.get(key)
      req.onsuccess = () => {
        if (req.result) queried.push(prompt)
        else notQueried.push(prompt)
        finishOne()
      }
      req.onerror = () => reject(req.error)
    }
  })
}

async function getPromptHistoryCount() {
  const db = await openPromptHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROMPT_HISTORY_STORE, "readonly")
    const req = tx.objectStore(PROMPT_HISTORY_STORE).count()
    req.onsuccess = () => resolve(req.result ?? 0)
    req.onerror = () => reject(req.error)
  })
}

async function getRecentPrompts(limit = 50) {
  const db = await openPromptHistoryDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROMPT_HISTORY_STORE, "readonly")
    const store = tx.objectStore(PROMPT_HISTORY_STORE)
    const index = store.index("queriedAt")
    const req = index.openCursor(null, "prev")
    const results = []
    req.onsuccess = (event) => {
      const cursor = event.target.result
      if (cursor && results.length < limit) {
        results.push(cursor.value)
        cursor.continue()
      } else {
        resolve(results)
      }
    }
    req.onerror = () => reject(req.error)
  })
}
