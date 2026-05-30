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

async function resolveUniqueFilename(requestedFilename, sourceUrl) {
  let resolved
  resolveFilenameChain = resolveFilenameChain.then(() => {
    const withFingerprint = ensureUniqueDownloadFilename(
      requestedFilename,
      sourceUrl,
    )
    resolved = reserveFilename(withFingerprint)
  })
  await resolveFilenameChain
  return resolved
}

async function downloadImage(url, filename, sourceUrl) {
  if (!url) {
    throw new Error("Download URL is required")
  }
  const uniqueFilename = await resolveUniqueFilename(filename, sourceUrl)
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename: uniqueFilename,
        saveAs: false,
        conflictAction: "uniquify",
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
})

chrome.runtime.onStartup.addListener(() => {
  enforceExpiryIfNeeded()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === EXPIRY_CHECK_ALARM) {
    enforceExpiryIfNeeded()
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
    downloadImage(message.url, message.filename, message.sourceUrl)
      .then(async () => {
        try {
          await markImageDownloaded(message.url)
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
  if (message?.type === "clear-download-history") {
    clearDownloadHistory()
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
  if (message?.type === "clear-prompt-history") {
    clearPromptHistory()
      .then(() => sendResponse({ ok: true }))
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
  return false
})

scheduleExpiryChecks()
enforceExpiryIfNeeded()
