importScripts(
  "authSession.js",
  "downloadHelpers.js",
  "downloadHistory.js",
  "promptHistory.js",
  "batchOrchestrator.js",
)

const MIDJOURNEY_URL = "https://www.midjourney.com/"
const AUTH_COOKIE_NAMES = [
  "__Host-Midjourney.AuthUserTokenV3_i",
  "__Host-Midjourney.AuthUserTokenV3_r",
]
const EXPIRY_CHECK_ALARM = "check-account-expiry"

async function getStoredCookiesArray() {
  const { cookies } = await chrome.storage.local.get(["cookies"])
  if (!cookies) {
    return []
  }
  try {
    const parsed = JSON.parse(cookies)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function clearMidjourneyCookies(storedCookies = []) {
  const namesToRemove = new Set(AUTH_COOKIE_NAMES)
  for (const cookie of storedCookies) {
    if (cookie?.name) {
      namesToRemove.add(cookie.name)
    }
  }

  for (const name of namesToRemove) {
    try {
      await chrome.cookies.remove({
        url: MIDJOURNEY_URL,
        name,
      })
    } catch (error) {
      console.error(`删除 cookie ${name} 失败:`, error)
    }
  }
}

async function clearStoredToken() {
  const storedCookies = await getStoredCookiesArray()
  await chrome.storage.local.remove(["cookies", "token", "expiresAt", "lastLoginAt"])
  await clearMidjourneyCookies(storedCookies)
}

async function enforceExpiryIfNeeded() {
  const { expiresAt, lastLoginAt, cookies, token } = await chrome.storage.local.get([
    "expiresAt",
    "lastLoginAt",
    "cookies",
    "token",
  ])
  if (!(cookies || token)) {
    return false
  }
  if (!shouldForceReLogin(expiresAt, lastLoginAt)) {
    return false
  }
  await clearStoredToken()
  return true
}

async function handleToken(cookies, expiresAt) {
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("Cookies array is required")
  }
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value) {
      throw new Error("Invalid cookie: missing name or value")
    }
  }
  await chrome.storage.local.set({
    cookies: JSON.stringify(cookies),
    expiresAt: expiresAt || null,
    lastLoginAt: new Date().toISOString(),
  })
  await openMidjourneyWithCookies(cookies)
}

async function openMidjourneyWithCookies(cookies) {
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
    throw new Error("Cookies array is required")
  }
  for (const cookie of cookies) {
    try {
      const details = {
        url: `https://www.midjourney.com${cookie.path || "/"}`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || "/",
        sameSite: cookie.sameSite || "lax",
        secure: cookie.secure !== false,
      }
      await chrome.cookies.set(details)
    } catch (error) {
      throw new Error(`设置 cookie ${cookie.name} 失败: ${error.message}`)
    }
  }
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: MIDJOURNEY_URL, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      if (tab?.id) {
        resolve()
        return
      }
      reject(new Error("Failed to create tab"))
    })
  })
}

let resolveFilenameChain = Promise.resolve()
let downloadSequence = 0
const usedDownloadFilenames = new Set()

function normalizeFilenameKey(filename) {
  return filename.replace(/\\/g, "/").toLowerCase()
}

function splitFilenameParts(filename) {
  const normalized = filename.replace(/\\/g, "/")
  const slash = normalized.lastIndexOf("/")
  const dir = slash >= 0 ? normalized.slice(0, slash + 1) : ""
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized
  const dot = base.lastIndexOf(".")
  const stem = dot >= 0 ? base.slice(0, dot) : base
  const ext = dot >= 0 ? base.slice(dot) : ".png"
  return { dir, stem, ext }
}

function ensureUniqueDownloadFilename(requestedFilename, sourceUrl) {
  const { dir, stem, ext } = splitFilenameParts(requestedFilename)
  const fingerprint = hashUrlFingerprint(sourceUrl || requestedFilename)

  if (new RegExp(`_${fingerprint}$`, "i").test(stem)) {
    return requestedFilename
  }

  if (/_\w{8,12}$/i.test(stem)) {
    return requestedFilename
  }

  return `${dir}${stem}_${fingerprint}${ext}`
}

function reserveFilename(requestedFilename) {
  downloadSequence++
  const { dir, stem, ext } = splitFilenameParts(requestedFilename)
  let candidate = requestedFilename
  let key = normalizeFilenameKey(candidate)

  if (!usedDownloadFilenames.has(key)) {
    usedDownloadFilenames.add(key)
    return candidate
  }

  let index = 2
  while (index < 10000) {
    candidate = `${dir}${stem}_${index}${ext}`
    key = normalizeFilenameKey(candidate)
    if (!usedDownloadFilenames.has(key)) {
      usedDownloadFilenames.add(key)
      return candidate
    }
    index++
  }

  candidate = `${dir}${stem}_${Date.now()}_${downloadSequence}${ext}`
  usedDownloadFilenames.add(normalizeFilenameKey(candidate))
  return candidate
}

function releaseFilename(filename) {
  usedDownloadFilenames.delete(normalizeFilenameKey(filename))
}

async function getDownloadSettings(overrides = {}) {
  const stored = await chrome.storage.local.get([
    DOWNLOAD_NAMING_MODE_KEY,
    DOWNLOAD_CONFLICT_ACTION_KEY,
  ])
  return {
    namingMode:
      overrides.namingMode ||
      stored[DOWNLOAD_NAMING_MODE_KEY] ||
      DOWNLOAD_NAMING_SEQUENTIAL,
    conflictAction:
      overrides.conflictAction ||
      stored[DOWNLOAD_CONFLICT_ACTION_KEY] ||
      DOWNLOAD_CONFLICT_PROMPT,
  }
}

async function allocateSequentialFilenameInStorage(dir, ext) {
  const today = formatDateYmd()
  const stored = await chrome.storage.local.get([
    DOWNLOAD_SEQ_DATE_KEY,
    DOWNLOAD_SEQ_COUNTER_KEY,
  ])
  let counter = Number(stored[DOWNLOAD_SEQ_COUNTER_KEY]) || 0
  if (stored[DOWNLOAD_SEQ_DATE_KEY] !== today) {
    counter = 0
  }
  counter += 1
  await chrome.storage.local.set({
    [DOWNLOAD_SEQ_DATE_KEY]: today,
    [DOWNLOAD_SEQ_COUNTER_KEY]: counter,
  })
  const base = buildSequentialBasename(counter, today, ext)
  return dir ? `${dir}/${base}` : base
}

async function resolveDownloadFilename(requestedFilename, sourceUrl, options) {
  let resolved
  resolveFilenameChain = resolveFilenameChain.then(async () => {
    if (options.namingMode === DOWNLOAD_NAMING_SEQUENTIAL) {
      const { dir, ext } = splitFilenameParts(requestedFilename)
      resolved = await allocateSequentialFilenameInStorage(
        dir,
        ext || ".webp",
      )
      return
    }
    const withFingerprint = ensureUniqueDownloadFilename(
      requestedFilename,
      sourceUrl,
    )
    resolved = reserveFilename(withFingerprint)
  })
  await resolveFilenameChain
  return resolved
}

async function downloadImage(url, filename, sourceUrl, downloadOptions = {}) {
  if (!url) {
    throw new Error("Download URL is required")
  }
  const options = await getDownloadSettings(downloadOptions)
  const uniqueFilename = await resolveDownloadFilename(
    filename,
    sourceUrl,
    options,
  )
  const conflictAction =
    options.conflictAction === DOWNLOAD_CONFLICT_OVERWRITE
      ? "overwrite"
      : options.conflictAction === DOWNLOAD_CONFLICT_UNIQUIFY
        ? "uniquify"
        : "prompt"
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename: uniqueFilename,
        saveAs: false,
        conflictAction,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          releaseFilename(uniqueFilename)
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        if (downloadId) {
          resolve()
          return
        }
        releaseFilename(uniqueFilename)
        reject(new Error("下载任务创建失败"))
      },
    )
  })
}

function scheduleExpiryChecks() {
  chrome.alarms.create(EXPIRY_CHECK_ALARM, { periodInMinutes: 1 })
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleExpiryChecks()
  enforceExpiryIfNeeded()
  reconcileStaleBatchProgress().catch(() => {})
})

chrome.runtime.onStartup.addListener(() => {
  enforceExpiryIfNeeded()
  reconcileStaleBatchProgress().catch(() => {})
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXPIRY_CHECK_ALARM) {
    enforceExpiryIfNeeded()
  }
  if (alarm.name === BATCH_KEEPALIVE_ALARM) {
    chrome.runtime.getPlatformInfo(() => {})
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const safeRespond = (payload) => {
    try {
      sendResponse(payload)
    } catch (error) {
      console.error("sendResponse failed:", error)
    }
  }

  if (message?.type === "ping") {
    safeRespond({ ok: true })
    return false
  }

  if (message?.type === "store-token") {
    handleToken(message.cookies, message.expiresAt)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "logout") {
    clearStoredToken()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "check-expiry") {
    enforceExpiryIfNeeded()
      .then((cleared) => sendResponse({ ok: true, cleared }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "download-image") {
    downloadImage(message.url, message.filename, message.sourceUrl, {
      namingMode: message.namingMode,
      conflictAction: message.conflictAction,
    })
      .then(async () => {
        try {
          await markImageDownloaded(message.sourceUrl || message.url)
        } catch (error) {
          console.error("记录下载历史失败:", error)
        }
        sendResponse({ ok: true })
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "filter-download-history") {
    filterUrlsNotDownloaded(message.urls || [])
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "get-download-history-count") {
    getDownloadHistoryCount()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "get-download-settings") {
    getDownloadSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "set-download-settings") {
    const patch = {}
    if (message.namingMode) patch[DOWNLOAD_NAMING_MODE_KEY] = message.namingMode
    if (message.conflictAction) {
      patch[DOWNLOAD_CONFLICT_ACTION_KEY] = message.conflictAction
    }
    chrome.storage.local
      .set(patch)
      .then(() => getDownloadSettings())
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "reset-download-sequence") {
    chrome.storage.local
      .remove([DOWNLOAD_SEQ_DATE_KEY, DOWNLOAD_SEQ_COUNTER_KEY])
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "filter-prompt-history") {
    filterPromptsNotQueried(message.prompts || [])
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "get-prompt-history-count") {
    getPromptHistoryCount()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "start-batch-job") {
    ;(async () => {
      try {
        const result = await startBatchJob({
          prompts: message.prompts,
          skipQueried: message.skipQueried,
          autoDownload: message.autoDownload,
          skipDownloaded: message.skipDownloaded,
          parallel: message.parallel,
          maxCollect: message.maxCollect,
          downloadSubDir: message.downloadSubDir,
        })
        safeRespond({ ok: true, ...result })
      } catch (error) {
        safeRespond({ ok: false, error: error.message })
      }
    })()
    return true
  }
  if (message?.type === "stop-batch-job") {
    stopBatchJob()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "get-batch-progress") {
    getBatchProgress()
      .then((progress) => sendResponse({ ok: true, progress }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "batch-step-progress") {
    updateBatchProgress({ current: [message.step || "处理中…"] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }))
    return true
  }
  if (message?.type === "main-world-explore-search") {
    const tabId = sender.tab?.id
    if (!tabId) {
      safeRespond({ ok: false, error: "无法获取 Midjourney 标签页" })
      return false
    }
    tryMainWorldExploreSearch(tabId, message.prompt || "")
      .then((result) => safeRespond({ ok: Boolean(result?.ok), ...result }))
      .catch((error) => safeRespond({ ok: false, error: error.message }))
    return true
  }
  return false
})

scheduleExpiryChecks()
enforceExpiryIfNeeded()
