/**
 * 批量提示词：两阶段执行
 * 1) 标签页内仅查询/滚动采集 URL，完成后立即关标签
 * 2) 后台统一下载，避免多标签同时下载导致其他页面查询被中断
 */
const MJ_EXPLORE_URL = "https://www.midjourney.com/explore?tab=top"
const BATCH_PROGRESS_KEY = "batchJobProgress"
const BATCH_ABORT_KEY = "batchJobAbort"
const BATCH_DOWNLOAD_CONCURRENCY = 2
const BATCH_KEEPALIVE_ALARM = "bdduck-batch-keepalive"

let batchRunnerPromise = null
let keepAliveTimer = null

function pingServiceWorker() {
  chrome.runtime.getPlatformInfo(() => {})
  chrome.storage.session.get(BATCH_PROGRESS_KEY, () => {})
}

function startServiceWorkerKeepAlive() {
  if (keepAliveTimer) return
  keepAliveTimer = setInterval(pingServiceWorker, 4000)
  pingServiceWorker()
  chrome.alarms.create(BATCH_KEEPALIVE_ALARM, { periodInMinutes: 1 })
}

function stopServiceWorkerKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
  chrome.alarms.clear(BATCH_KEEPALIVE_ALARM)
}

async function getBatchDownloadConcurrency() {
  const settings = await getDownloadSettings()
  return settings.conflictAction === DOWNLOAD_CONFLICT_PROMPT
    ? 1
    : BATCH_DOWNLOAD_CONCURRENCY
}

/** 扩展后台被系统回收后，避免批量页一直显示“进行中” */
async function reconcileStaleBatchProgress() {
  const progress = await getBatchProgress()
  if (!progress.running || batchRunnerPromise) return
  const logs = progress.logs || []
  logs.unshift({
    time: Date.now(),
    prompt: "(系统)",
    ok: false,
    error:
      "扩展后台已休眠，任务中断。请在 chrome://extensions 重新加载扩展后重新开始。",
  })
  await updateBatchProgress({
    running: false,
    current: [],
    logs: logs.slice(0, 100),
    finishedAt: Date.now(),
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function updateBatchProgress(patch) {
  const current = (await chrome.storage.session.get(BATCH_PROGRESS_KEY))[
    BATCH_PROGRESS_KEY
  ] || {}
  const next = { ...current, ...patch, updatedAt: Date.now() }
  await chrome.storage.session.set({ [BATCH_PROGRESS_KEY]: next })
  return next
}

async function isBatchAborted() {
  const data = await chrome.storage.session.get(BATCH_ABORT_KEY)
  return Boolean(data[BATCH_ABORT_KEY])
}

async function clearBatchAbort() {
  await chrome.storage.session.remove(BATCH_ABORT_KEY)
}

async function requestBatchAbort() {
  await chrome.storage.session.set({ [BATCH_ABORT_KEY]: true })
}

function waitTabComplete(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
          return
        }
        if (tab.status === "complete") {
          resolve(tab)
          return
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error("页面加载超时"))
          return
        }
        setTimeout(check, 300)
      })
    }
    check()
  })
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "content-ping",
    })
    return response?.ok === true
  } catch {
    return false
  }
}

/**
 * 等待 Midjourney 页面 content script 就绪（由 manifest 注入，勿重复 executeScript 以免重复声明报错）。
 */
async function ensureContentScriptReady(tabId, timeoutMs = 120000) {
  const start = Date.now()
  let activated = false

  while (Date.now() - start < timeoutMs) {
    if (await pingContentScript(tabId)) return

    if (!activated && Date.now() - start > 2500) {
      try {
        await chrome.tabs.update(tabId, { active: true })
        activated = true
        await sleep(800)
      } catch {
        /* tab may be closed */
      }
    }

    await sleep(450)
  }

  throw new Error(
    "无法连接 Midjourney 页面脚本，请确认已登录 Midjourney，并在 chrome://extensions 重新加载本扩展后重试",
  )
}

async function sendTabMessage(tabId, message, timeoutMs = 600000) {
  const start = Date.now()
  let lastError = null
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message)
      if (response !== undefined) return response
    } catch (error) {
      lastError = error
      await sleep(400)
    }
  }
  throw lastError || new Error("内容脚本无响应")
}

async function tryMainWorldExploreSearch(tabId, prompt) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (searchPrompt) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

      const isVisible = (el) => {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }

      const clickSearchImages = () => {
        for (const el of document.querySelectorAll(
          "button,a,[role=button],label,span,div",
        )) {
          if (!isVisible(el)) continue
          const text = (el.textContent || "").trim().toLowerCase()
          const aria = (el.getAttribute("aria-label") || "").toLowerCase()
          if (
            text === "search images" ||
            aria.includes("search images") ||
            /\bsearch images\b/.test(`${text} ${aria}`)
          ) {
            const btn = el.closest("button,a,[role=button],label") || el
            btn.click()
            return true
          }
        }
        return false
      }

      clickSearchImages()
      await sleep(900)

      let input = null
      let bestScore = -1
      for (const el of document.querySelectorAll(
        'input, [role="searchbox"], [contenteditable="true"]',
      )) {
        if (!isVisible(el)) continue
        const hint = `${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase()
        if (hint.includes("imagine") || hint.includes("what will you")) continue
        let score = 0
        if (hint.includes("search images")) score = 100
        else if (hint.includes("search")) score = 70
        else continue
        const rect = el.getBoundingClientRect()
        if (rect.left > window.innerWidth * 0.5) score += 20
        if (score > bestScore) {
          bestScore = score
          input = el
        }
      }

      if (!input) return { ok: false, error: "input_not_found" }

      input.focus()
      input.click()
      await sleep(200)

      if (input.isContentEditable) {
        input.textContent = searchPrompt
      } else {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set
        setter?.call(input, searchPrompt)
      }

      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromPaste",
          data: searchPrompt,
        }),
      )
      input.dispatchEvent(new Event("change", { bubbles: true }))

      for (const type of ["keydown", "keypress", "keyup"]) {
        input.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
          }),
        )
      }

      await sleep(2500)
      return {
        ok: true,
        value: input.value || input.textContent || "",
        href: location.href,
      }
    },
    args: [prompt],
  })
  return result?.result || { ok: false, error: "main_world_no_result" }
}

async function createExploreTab(activate) {
  const tab = await new Promise((resolve, reject) => {
    chrome.tabs.create({ url: MJ_EXPLORE_URL, active: Boolean(activate) }, (created) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(created)
    })
  })
  await waitTabComplete(tab.id)
  await sleep(3500)
  return tab
}

/** 阶段1：仅查询采集，不在标签页内下载 */
async function queryPromptInTab(prompt, options) {
  const tab = await createExploreTab(options.activateTab)
  const maxCollect = Math.min(
    Math.max(Number(options.maxCollect) || 1000, 50),
    5000,
  )

  try {
    await updateBatchProgress({
      current: [`连接 Midjourney 页面: ${prompt.slice(0, 40)}…`],
    })
    await ensureContentScriptReady(tab.id)

    const result = await sendTabMessage(tab.id, {
      type: "batch-run-prompt",
      prompt,
      autoDownload: false,
      skipDownloaded: false,
      downloadSubDir: "",
      maxCollect,
    })

    if (!result?.ok) {
      throw new Error(result?.error || "页面查询失败")
    }

    return {
      prompt,
      selectedCount: result.selectedCount || 0,
      imageUrls: result.imageUrls || [],
    }
  } finally {
    try {
      await chrome.tabs.remove(tab.id)
    } catch {
      /* tab may already be closed */
    }
  }
}

/** 阶段2：后台下载（标签页已关闭） */
async function downloadImageUrlInBackground(imageUrl, pathPrefix) {
  const settings = await getDownloadSettings()
  const webpUrl = ensureWebpUrl(imageUrl)
  const candidates = getDownloadUrlCandidates(imageUrl)
  let lastError = null

  for (const url of candidates) {
    const ext = /\.webp$/i.test(url) ? ".webp" : ".png"
    const finalFilename =
      settings.namingMode === DOWNLOAD_NAMING_SEQUENTIAL
        ? buildSequentialPlaceholderPath(pathPrefix || "", ext)
        : pathPrefix
          ? `${pathPrefix}/${deriveDownloadFilename(webpUrl, imageUrl)}`
          : deriveDownloadFilename(webpUrl, imageUrl)
    const nameForUrl =
      settings.namingMode === DOWNLOAD_NAMING_SEQUENTIAL
        ? finalFilename
        : finalFilename.replace(/\.(png|webp|jpe?g)$/i, ext)
    try {
      await downloadImage(url, nameForUrl, imageUrl, settings)
      try {
        await markImageDownloaded(imageUrl)
      } catch (error) {
        console.error("记录下载历史失败:", error)
      }
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError || new Error("下载失败")
}

async function downloadUrlsForPrompt(imageUrls, options) {
  if (!imageUrls?.length) {
    return { successCount: 0, failCount: 0, skippedCount: 0 }
  }

  let urlsToDownload = imageUrls
  let skippedCount = 0

  if (options.skipDownloaded !== false) {
    const filtered = await filterUrlsNotDownloaded(imageUrls)
    urlsToDownload = filtered.notDownloaded
    skippedCount = filtered.skippedCount
  }

  if (!urlsToDownload.length) {
    return { successCount: 0, failCount: 0, skippedCount }
  }

  const pathPrefix =
    buildDownloadPath(options.downloadSubDir, options.promptFolder, "") ||
    undefined

  let successCount = 0
  let failCount = 0
  let nextIndex = 0

  async function worker() {
    while (nextIndex < urlsToDownload.length) {
      if (await isBatchAborted()) return
      const i = nextIndex++
      const imageUrl = urlsToDownload[i]
      try {
        await downloadImageUrlInBackground(imageUrl, pathPrefix)
        successCount++
      } catch {
        failCount++
      }
      await sleep(60)
    }
  }

  const concurrency = await getBatchDownloadConcurrency()
  const workers = Math.min(concurrency, urlsToDownload.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))

  return { successCount, failCount, skippedCount }
}

async function processOnePrompt(prompt, config, options = {}) {
  const queryResult = await queryPromptInTab(prompt, {
    activateTab: options.activateTab ?? config.parallel === 1,
    maxCollect: config.maxCollect,
  })

  let downloadStats = { successCount: 0, failCount: 0, skippedCount: 0 }

  if (config.autoDownload !== false && queryResult.imageUrls.length > 0) {
    await updateBatchProgress({
      current: [`下载: ${prompt.slice(0, 40)}…`],
    })
    downloadStats = await downloadUrlsForPrompt(queryResult.imageUrls, {
      downloadSubDir: config.downloadSubDir,
      promptFolder: sanitizePromptFolder(prompt),
      skipDownloaded: config.skipDownloaded,
    })
  }

  await markPromptQueried(prompt, {
    imageCount: queryResult.selectedCount,
    downloadedCount: downloadStats.successCount,
  })

  return {
    selectedCount: queryResult.selectedCount,
    ...downloadStats,
  }
}

async function runBatchJob(config) {
  if (batchRunnerPromise) {
    throw new Error("已有批量任务在运行")
  }

  await reconcileStaleBatchProgress()
  await clearBatchAbort()

  let prompts = (config.prompts || [])
    .map((p) => String(p).trim())
    .filter(Boolean)

  if (config.skipQueried) {
    const filtered = await filterPromptsNotQueried(prompts)
    prompts = filtered.notQueried
  }

  if (!prompts.length) {
    throw new Error("没有可执行的提示词（可能均已查询过）")
  }

  const parallel = Math.min(Math.max(config.parallel || 1, 1), 3)
  const total = prompts.length
  let completed = 0
  let failed = 0
  const logs = []

  await updateBatchProgress({
    running: true,
    total,
    completed: 0,
    failed: 0,
    current: [],
    logs: [],
    startedAt: Date.now(),
    mode: parallel === 1 ? "sequential" : "parallel-query",
  })

  startServiceWorkerKeepAlive()

  batchRunnerPromise = (async () => {
    try {
      if (parallel === 1) {
        for (const prompt of prompts) {
          if (await isBatchAborted()) break

          await updateBatchProgress({
            current: [`查询: ${prompt.slice(0, 50)}`],
            completed,
            failed,
            logs,
          })

          try {
            const result = await processOnePrompt(prompt, config, {
              activateTab: true,
            })
            completed++
            logs.unshift({
              time: Date.now(),
              prompt,
              ok: true,
              selected: result.selectedCount,
              downloaded: result.successCount,
              failed: result.failCount,
              skipped: result.skippedCount,
            })
          } catch (error) {
            failed++
            logs.unshift({
              time: Date.now(),
              prompt,
              ok: false,
              error: error.message || String(error),
            })
          }

          await updateBatchProgress({
            completed,
            failed,
            logs: logs.slice(0, 100),
            current: [],
          })
        }
      } else {
        for (let i = 0; i < prompts.length; i += parallel) {
          if (await isBatchAborted()) break

          const chunk = prompts.slice(i, i + parallel)
          await updateBatchProgress({
            current: chunk.map((p) => `查询: ${p.slice(0, 30)}…`),
            completed,
            failed,
            logs,
          })

          const queryResults = await Promise.allSettled(
            chunk.map((prompt) =>
              queryPromptInTab(prompt, {
                activateTab: false,
                maxCollect: config.maxCollect,
              }),
            ),
          )

          for (let j = 0; j < chunk.length; j++) {
            if (await isBatchAborted()) break

            const prompt = chunk[j]
            const queryOutcome = queryResults[j]

            if (queryOutcome.status !== "fulfilled") {
              failed++
              logs.unshift({
                time: Date.now(),
                prompt,
                ok: false,
                error:
                  queryOutcome.reason?.message || String(queryOutcome.reason),
              })
              continue
            }

            const queryResult = queryOutcome.value
            let downloadStats = {
              successCount: 0,
              failCount: 0,
              skippedCount: 0,
            }

            try {
              if (config.autoDownload !== false && queryResult.imageUrls.length) {
                await updateBatchProgress({
                  current: [`下载: ${prompt.slice(0, 40)}…`],
                })
                downloadStats = await downloadUrlsForPrompt(
                  queryResult.imageUrls,
                  {
                    downloadSubDir: config.downloadSubDir,
                    promptFolder: sanitizePromptFolder(prompt),
                    skipDownloaded: config.skipDownloaded,
                  },
                )
              }

              await markPromptQueried(prompt, {
                imageCount: queryResult.selectedCount,
                downloadedCount: downloadStats.successCount,
              })

              completed++
              logs.unshift({
                time: Date.now(),
                prompt,
                ok: true,
                selected: queryResult.selectedCount,
                downloaded: downloadStats.successCount,
                failed: downloadStats.failCount,
                skipped: downloadStats.skippedCount,
              })
            } catch (error) {
              failed++
              logs.unshift({
                time: Date.now(),
                prompt,
                ok: false,
                error: error.message || String(error),
              })
            }
          }

          await updateBatchProgress({
            completed,
            failed,
            logs: logs.slice(0, 100),
            current: [],
          })
        }
      }
    } finally {
      stopServiceWorkerKeepAlive()
      await updateBatchProgress({
        running: false,
        completed,
        failed,
        current: [],
        logs: logs.slice(0, 100),
        finishedAt: Date.now(),
      })
      batchRunnerPromise = null
      await clearBatchAbort()
    }
  })()

  return { started: true, total, mode: parallel === 1 ? "sequential" : "parallel-query" }
}

async function startBatchJob(config) {
  return runBatchJob(config)
}

reconcileStaleBatchProgress().catch(() => {})

async function getBatchProgress() {
  const data = await chrome.storage.session.get(BATCH_PROGRESS_KEY)
  return data[BATCH_PROGRESS_KEY] || { running: false }
}

async function stopBatchJob() {
  await requestBatchAbort()
  await updateBatchProgress({ running: false, current: [] })
}
