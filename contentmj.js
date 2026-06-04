let checkInterval,
  scrollTimer,
  selectedImageUrls = []

// 避免在同一页面中重复初始化复选框系统
let isCheckboxSystemInitialized = false

// 自动滚动全选
let isAutoScrollRunning = false
let autoScrollAbort = false

function isMainFrame() {
  try {
    return window.self === window.top
  } catch {
    return false
  }
}

function showAutoScrollToast(message) {
  let toast = document.getElementById("bdduck-auto-scroll-toast")
  if (!toast) {
    toast = document.createElement("div")
    toast.id = "bdduck-auto-scroll-toast"
    toast.style.cssText = `position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:2147483646;max-width:min(90vw,420px);padding:14px 20px;background:rgba(15,15,16,0.92);color:#fff;font-size:14px;font-weight:600;line-height:1.5;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.35);pointer-events:none;text-align:center;`
    document.body.appendChild(toast)
  }
  toast.textContent = message
  toast.style.display = "block"
  clearTimeout(showAutoScrollToast._timer)
  showAutoScrollToast._timer = setTimeout(() => {
    toast.style.display = "none"
  }, 6000)
}

// 批量下载并发数（过多易触发扩展/下载队列失败；重名询问时必须为 1）
const DOWNLOAD_CONCURRENCY = 2
const DOWNLOAD_RETRY_TIMES = 5

// 下载子目录（相对于浏览器下载目录），用户可通过按钮设置
let downloadSubDir = ""
const DOWNLOAD_SUBDIR_STORAGE_KEY = "bdduck-download-subdir"

// 跳过已下载（IndexedDB 记录，默认开启）
const SKIP_DOWNLOADED_KEY = "bdduck-skip-downloaded"
let skipDownloaded = true

// 下载命名 / 重名处理（与 background chrome.storage 同步）
let downloadNamingMode = DOWNLOAD_NAMING_SEQUENTIAL
let downloadConflictAction = DOWNLOAD_CONFLICT_PROMPT
let markDownloadedTimer = null
const downloadedUrlSet = new Set()

// 账号信息 overlay 相关
const ACCOUNT_OVERLAY_ID = "mj-account-info-overlay"
const ACCOUNT_TOGGLE_BUTTON_ID = "mj-account-toggle-btn"
let isAccountOverlayInitialized = false
let mutationDebounceTimer = null
let domObserver = null
let intersectionObserver = null

function parseCssUrl(value) {
  if (!value || value === "none") return ""
  const match = value.match(/url\(["']?(.*?)["']?\)/i)
  return match?.[1] ? decodeURIComponent(match[1].trim()) : ""
}

function extractUrlFromElement(el) {
  if (!el) return ""

  if (el.tagName === "IMG") {
    const srcset = el.srcset || el.getAttribute("srcset")
    if (srcset) {
      const firstSrc = srcset.split(",")[0].trim().split(/\s+/)[0]
      if (firstSrc && MJ_CDN_PATTERN.test(firstSrc)) {
        return normalizeImageUrl(firstSrc)
      }
    }
    const src =
      el.currentSrc || el.src || el.getAttribute("src") || el.dataset?.src
    if (src && MJ_CDN_PATTERN.test(src)) return normalizeImageUrl(src)
  }

  const inlineBg = parseCssUrl(el.style?.backgroundImage)
  if (inlineBg && MJ_CDN_PATTERN.test(inlineBg)) {
    return normalizeImageUrl(inlineBg)
  }

  try {
    const computedBg = parseCssUrl(getComputedStyle(el).backgroundImage)
    if (computedBg && MJ_CDN_PATTERN.test(computedBg)) {
      return normalizeImageUrl(computedBg)
    }
  } catch {
    /* ignore */
  }

  const href = el.href || el.getAttribute("href")
  if (href && MJ_CDN_PATTERN.test(href)) return normalizeImageUrl(href)

  return ""
}

function extractAllImageUrlsFromCard(card) {
  const urls = new Set()
  if (!card) return []

  const selectors = [
    'a[style*="background-image"]',
    'a[style*="cdn.midjourney"]',
    'div[style*="background-image"]',
    'img[src*="cdn.midjourney.com"]',
    'img[srcset*="cdn.midjourney.com"]',
    "img",
    "a",
  ]

  for (const selector of selectors) {
    card.querySelectorAll(selector).forEach((el) => {
      const url = extractUrlFromElement(el)
      if (url && MJ_CDN_PATTERN.test(url)) urls.add(url)
    })
  }

  return [...urls]
}

function extractImageUrlFromCard(card) {
  const all = extractAllImageUrlsFromCard(card)
  return all[0] || ""
}

/** 扫描当前 DOM 中所有可见的 MJ CDN 图片（不依赖 jobCard 结构） */
function harvestAllVisibleImageUrls() {
  const urls = new Set()

  document
    .querySelectorAll(
      'img[src*="cdn.midjourney.com"], img[srcset*="cdn.midjourney.com"], a[href*="cdn.midjourney.com"], a[style*="background-image"], a[style*="cdn.midjourney"], div[style*="background-image"], div[style*="cdn.midjourney"]',
    )
    .forEach((el) => {
      const url = extractUrlFromElement(el)
      if (url) urls.add(url)
    })

  document.querySelectorAll('div[class*="jobCard"]').forEach((card) => {
    extractAllImageUrlsFromCard(card).forEach((url) => urls.add(url))
  })

  return urls
}

function addUrlsToSelection(urlIterable) {
  for (const url of urlIterable) {
    if (url && !selectedImageUrls.includes(url)) {
      selectedImageUrls.push(url)
    }
  }
}

function syncCheckboxesWithSelection() {
  document.querySelectorAll(".image-select-checkbox").forEach((checkbox) => {
    const imageUrl = checkbox.dataset.convertedImageUrl
    const selected = imageUrl && selectedImageUrls.includes(imageUrl)
    checkbox.checked = selected
    if (selected) {
      checkbox.style.backgroundColor = "#007bff"
      checkbox.style.borderColor = "#007bff"
    }
  })
}

function findJobCardEntries() {
  const entries = []
  const seenUrls = new Set()

  const register = (card, url) => {
    if (!card || !url || seenUrls.has(url)) return
    seenUrls.add(url)
    entries.push({ card, url })
  }

  document.querySelectorAll('div[class*="jobCard"]').forEach((card) => {
    extractAllImageUrlsFromCard(card).forEach((url) => register(card, url))
  })

  if (entries.length === 0) {
    document
      .querySelectorAll(
        'img[src*="cdn.midjourney.com"], img[srcset*="cdn.midjourney.com"], a[style*="background-image"], div[style*="background-image"]',
      )
      .forEach((el) => {
        const url = extractUrlFromElement(el)
        if (!url) return
        const card =
          el.closest('div[class*="jobCard"]') ||
          el.closest('div[class*="group/jobCard"]') ||
          el.closest('div[class*="group"]') ||
          el.closest("div.relative") ||
          el.parentElement
        register(card, url)
      })
  }

  return entries
}

function findJobCards() {
  const cardSet = new Set(findJobCardEntries().map((e) => e.card))
  let cards = [...cardSet]
  cards = cards.filter(
    (card) =>
      !cards.some((other) => other !== card && card.contains(other)),
  )
  return cards
}

function attachCheckboxToCard(card, convertedUrl) {
  if (!card || !convertedUrl) return null
  const existing = [
    ...card.querySelectorAll(".image-select-checkbox"),
  ].find((cb) => cb.dataset.convertedImageUrl === convertedUrl)
  if (existing) return existing

  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.className = "image-select-checkbox"
  checkbox.style.cssText = `top:0px;right:0px;width:80px;height:80px;position:absolute;opacity:0.3;background-color:transparent;border:2px solid #007bff;cursor:pointer;z-index:10;`
  checkbox.dataset.convertedImageUrl = convertedUrl
  if (selectedImageUrls.includes(convertedUrl)) {
    checkbox.checked = true
    checkbox.style.backgroundColor = "#007bff"
    checkbox.style.borderColor = "#007bff"
  }
  checkbox.addEventListener("change", function () {
    const imageUrl = this.dataset.convertedImageUrl
    if (this.checked) {
      this.style.backgroundColor = "#007bff"
      this.style.borderColor = "#007bff"
      if (imageUrl && !selectedImageUrls.includes(imageUrl)) {
        selectedImageUrls.push(imageUrl)
        updateSelectedCountDisplay()
      }
    } else {
      this.style.backgroundColor = ""
      this.style.borderColor = "#ddd"
      selectedImageUrls = selectedImageUrls.filter((url) => url !== imageUrl)
      updateSelectedCountDisplay()
    }
  })
  card.insertBefore(checkbox, card.firstChild)
  observeCardInViewport(card)
  return checkbox
}

function observeCardInViewport(card) {
  if (!intersectionObserver || !card) return
  try {
    intersectionObserver.observe(card)
  } catch {
    /* already observed */
  }
}

function setupCardObservers() {
  if (!domObserver) {
    domObserver = new MutationObserver(() => {
      clearTimeout(mutationDebounceTimer)
      mutationDebounceTimer = setTimeout(addCheckboxesToCards, 120)
    })
    domObserver.observe(document.body, {
      childList: true,
      subtree: true,
    })
  }

  if (!intersectionObserver) {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          clearTimeout(mutationDebounceTimer)
          mutationDebounceTimer = setTimeout(addCheckboxesToCards, 80)
        }
      },
      { root: null, rootMargin: "300px", threshold: 0 },
    )
  }
}

function addCheckboxesToCards() {
  setupCardObservers()
  for (const { card, url } of findJobCardEntries()) {
    attachCheckboxToCard(card, url)
  }
  scheduleMarkDownloadedIndicators()
}

function isRetriableExtensionError(message) {
  const msg = String(message || "")
  return (
    msg.includes("message port closed") ||
    msg.includes("Receiving end does not exist") ||
    msg.includes("Could not establish connection") ||
    msg.includes("Extension context invalidated") ||
    msg.includes("The message port closed")
  )
}

function sendExtensionMessage(payload, retries = 5) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error("Extension unavailable"))
        return
      }
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          const msg =
            chrome.runtime.lastError.message || String(chrome.runtime.lastError)
          if (left > 0 && isRetriableExtensionError(msg)) {
            setTimeout(() => attempt(left - 1), 400)
            return
          }
          reject(new Error(msg))
          return
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Request failed"))
          return
        }
        resolve(response)
      })
    }
    attempt(retries)
  })
}

function getEffectiveDownloadConcurrency() {
  return downloadConflictAction === DOWNLOAD_CONFLICT_PROMPT
    ? 1
    : DOWNLOAD_CONCURRENCY
}

async function filterUrlsForDownload(urls) {
  if (!skipDownloaded || !urls.length) {
    return { toDownload: urls, skippedCount: 0 }
  }
  const result = await sendExtensionMessage({
    type: "filter-download-history",
    urls,
  })
  return {
    toDownload: result.notDownloaded || [],
    skippedCount: result.skippedCount || 0,
  }
}

function applyDownloadedIndicator(checkbox, isDownloaded) {
  if (!checkbox) return
  if (isDownloaded) {
    checkbox.dataset.alreadyDownloaded = "1"
    checkbox.style.boxShadow = "inset 4px 0 0 #22c55e"
    checkbox.title = "已下载过（将自动跳过）"
  } else {
    delete checkbox.dataset.alreadyDownloaded
    checkbox.style.boxShadow = ""
    checkbox.title = ""
  }
}

function scheduleMarkDownloadedIndicators() {
  clearTimeout(markDownloadedTimer)
  markDownloadedTimer = setTimeout(markDownloadedIndicators, 500)
}

async function markDownloadedIndicators() {
  const checkboxes = document.querySelectorAll(".image-select-checkbox")
  const urls = []
  const checkboxByUrl = new Map()
  checkboxes.forEach((checkbox) => {
    const url = checkbox.dataset.convertedImageUrl
    if (!url) return
    urls.push(url)
    if (!checkboxByUrl.has(url)) checkboxByUrl.set(url, [])
    checkboxByUrl.get(url).push(checkbox)
  })
  if (!urls.length) return

  try {
    const uniqueUrls = [...new Set(urls)]
    const result = await sendExtensionMessage({
      type: "filter-download-history",
      urls: uniqueUrls,
    })
    const downloaded = new Set(result.downloaded || [])
    downloaded.forEach((url) => downloadedUrlSet.add(url))
    uniqueUrls.forEach((url) => {
      const isDownloaded = downloaded.has(url)
      const boxes = checkboxByUrl.get(url) || []
      boxes.forEach((cb) => applyDownloadedIndicator(cb, isDownloaded))
    })
  } catch (error) {
    console.warn("标记已下载状态失败:", error)
  }
}

function loadSkipDownloaded() {
  try {
    const stored = window.localStorage.getItem(SKIP_DOWNLOADED_KEY)
    skipDownloaded = stored !== "false"
  } catch {
    skipDownloaded = true
  }
}

function saveSkipDownloaded() {
  try {
    window.localStorage.setItem(
      SKIP_DOWNLOADED_KEY,
      skipDownloaded ? "true" : "false",
    )
  } catch (error) {
    console.error("保存跳过已下载设置失败", error)
  }
}

function updateSkipDownloadedButton() {
  const button = document.getElementById("toggle-skip-downloaded")
  if (!button) return
  button.innerText = skipDownloaded ? "跳过已下载: 开" : "跳过已下载: 关"
  button.style.opacity = skipDownloaded ? "1" : "0.75"
}

async function refreshDownloadHistoryButtonLabel() {
  const button = document.getElementById("download-history-manage")
  if (!button) return
  try {
    const { count } = await sendExtensionMessage({
      type: "get-download-history-count",
    })
    button.innerText = `下载记录 (${formatCount(count)})`
  } catch {
    button.innerText = "下载记录"
  }
}

function formatCount(count) {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count ?? 0)
}

function createSelectedCountDisplay() {
  // 如果已经存在计数器 DOM，则直接复用，避免创建多个
  let display = document.getElementById("selected-count-display")
  if (!display) {
    display = document.createElement("div")
    display.id = "selected-count-display"
    display.style.cssText = `position:fixed;bottom:320px;right:20px;z-index:9999;padding:12px 24px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;border:none;border-radius:12px;box-shadow:0 4px 15px rgba(102,126,234,0.4);font-weight:600;font-size:14px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
    display.addEventListener("mouseenter", function () {
      this.style.transform = "translateY(-2px)"
      this.style.boxShadow = "0 6px 20px rgba(102,126,234,0.5)"
    })
    display.addEventListener("mouseleave", function () {
      this.style.transform = "translateY(0)"
      this.style.boxShadow = "0 4px 15px rgba(102,126,234,0.4)"
    })
    document.body.appendChild(display)
  }

  // 初始化/刷新当前显示的数量
  display.innerText = "已选中: " + selectedImageUrls.length
}
function updateSelectedCountDisplay() {
  const display = document.getElementById("selected-count-display")
  if (display) {
    display.innerText = `已选中: ${selectedImageUrls.length}`
  }
}
function handleScroll() {
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => {
    addCheckboxesToCards()
  }, 150)
}
function initializeCheckboxSystem() {
  if (isCheckboxSystemInitialized) {
    // 已经初始化过，避免重复绑定事件和创建按钮 / 计数器
    return
  }
  isCheckboxSystemInitialized = true

  loadDownloadSubDir()
  loadSkipDownloaded()
  loadDownloadNamingSettings()
  bindScrollListeners()
  createSelectCurrentPageButton()
  createAutoScrollSelectAllButton()
  createDeselectCurrentPageButton()
  createClearAllSelectedButton()
  createDownloadSelectedButton()
  createSetDownloadFolderButton()
  createDownloadNamingSettingsButton()
  createExportHistoryBackupButton()
  createSkipDownloadedToggle()
  createDownloadHistoryButton()
  createOpenBatchPageButton()
  createSelectedCountDisplay()
  refreshDownloadHistoryButtonLabel()
  setupCardObservers()
  addCheckboxesToCards()
  checkInterval = setInterval(() => {
    addCheckboxesToCards()
  }, 1000)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      setTimeout(() => addCheckboxesToCards(), 300)
    }
  })
}
async function loadDownloadNamingSettings() {
  try {
    const { settings } = await sendExtensionMessage({
      type: "get-download-settings",
    })
    if (settings?.namingMode) downloadNamingMode = settings.namingMode
    if (settings?.conflictAction) downloadConflictAction = settings.conflictAction
  } catch {
    /* 使用默认值 */
  }
}

async function requestBackgroundDownload(url, filename, sourceUrl) {
  let lastError
  for (let attempt = 0; attempt < DOWNLOAD_RETRY_TIMES; attempt++) {
    try {
      await sendExtensionMessage({
        type: "download-image",
        url,
        filename,
        sourceUrl: sourceUrl || url,
        namingMode: downloadNamingMode,
        conflictAction: downloadConflictAction,
      })
      return
    } catch (error) {
      lastError = error
      if (attempt < DOWNLOAD_RETRY_TIMES - 1) {
        await sleep(600)
      }
    }
  }
  throw lastError
}

async function downloadViaPageFetch(imageUrl, filename) {
  const webpUrl = ensureWebpUrl(imageUrl)
  const response = await fetch(webpUrl, {
    credentials: "include",
    mode: "cors",
  })
  if (!response.ok) {
    throw new Error(`图片请求失败 HTTP ${response.status}`)
  }
  const blob = await response.blob()
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"))
    reader.readAsDataURL(blob)
  })
  await requestBackgroundDownload(dataUrl, filename, imageUrl)
}

function buildDownloadFilenameForImage(webpUrl, imageUrl, ext) {
  if (downloadNamingMode === DOWNLOAD_NAMING_SEQUENTIAL) {
    return buildSequentialPlaceholderPath(downloadSubDir, ext)
  }
  const filename = deriveDownloadFilename(webpUrl, imageUrl)
  return downloadSubDir ? `${downloadSubDir}/${filename}` : filename
}

async function downloadSingleImage(imageUrl) {
  const webpUrl = ensureWebpUrl(imageUrl)
  const candidates = getDownloadUrlCandidates(imageUrl)
  let lastError

  for (const url of candidates) {
    const ext = /\.webp$/i.test(url) ? ".webp" : ".png"
    const nameForUrl =
      downloadNamingMode === DOWNLOAD_NAMING_SEQUENTIAL
        ? buildDownloadFilenameForImage(webpUrl, imageUrl, ext)
        : buildDownloadFilenameForImage(webpUrl, imageUrl, ext).replace(
            /\.(png|webp|jpe?g)$/i,
            ext,
          )
    try {
      await requestBackgroundDownload(url, nameForUrl, imageUrl)
      return
    } catch (error) {
      lastError = error
    }
  }

  try {
    await downloadViaPageFetch(
      imageUrl,
      buildDownloadFilenameForImage(webpUrl, imageUrl, ".webp"),
    )
  } catch (fetchError) {
    throw lastError || fetchError
  }
}
function createSelectCurrentPageButton() {
  const button = document.createElement("button")
  button.id = "select-current-images"
  button.innerText = "选中本页"
  button.style.cssText = `position:fixed;bottom:170px;right:20px;z-index:9999;padding:12px 28px;background:linear-gradient(135deg,#11998e 0%,#38ef7d 100%);color:white;border:none;border-radius:25px;cursor:pointer;box-shadow:0 4px 15px rgba(17,153,142,0.4);font-weight:600;font-size:14px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("mouseenter", function () {
    this.style.transform = "translateY(-2px) scale(1.05)"
    this.style.boxShadow = "0 6px 20px rgba(17,153,142,0.5)"
  })
  button.addEventListener("mouseleave", function () {
    this.style.transform = "translateY(0) scale(1)"
    this.style.boxShadow = "0 4px 15px rgba(17,153,142,0.4)"
  })
  button.addEventListener("click", selectCurrentPageImages)
  document.body.appendChild(button)
}

function findScrollContainer() {
  const scrollingEl = document.scrollingElement || document.documentElement
  if (scrollingEl.scrollHeight > scrollingEl.clientHeight + 80) {
    return {
      element: window,
      scrollToTop: () => {
        window.scrollTo({ top: 0, behavior: "instant" })
      },
      scrollToBottom: () => {
        window.scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: "instant",
        })
      },
      getScrollHeight: () => document.documentElement.scrollHeight,
      getMetrics: () => ({
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: window.innerHeight,
      }),
      scrollStep: (step) => {
        window.scrollBy({ top: step, behavior: "instant" })
      },
    }
  }

  const overflowEls = Array.from(document.querySelectorAll("div")).filter(
    (el) => {
      const style = getComputedStyle(el)
      const scrollable =
        style.overflowY === "auto" || style.overflowY === "scroll"
      return scrollable && el.scrollHeight > el.clientHeight + 80
    },
  )
  overflowEls.sort((a, b) => b.scrollHeight - a.scrollHeight)
  const el = overflowEls[0]
  if (!el) return null

  return {
    element: el,
    scrollToTop: () => {
      el.scrollTop = 0
    },
    scrollToBottom: () => {
      el.scrollTop = el.scrollHeight
    },
    getScrollHeight: () => el.scrollHeight,
    getMetrics: () => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }),
    scrollStep: (step) => {
      el.scrollTop += step
    },
  }
}

function bindScrollListeners() {
  window.addEventListener("scroll", handleScroll, { passive: true })
  const scroller = findScrollContainer()
  if (scroller?.element && scroller.element !== window) {
    scroller.element.addEventListener("scroll", handleScroll, { passive: true })
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runAutoScrollHarvest(scroller, collected, button, options = {}) {
  if (scroller.scrollToTop) {
    scroller.scrollToTop()
    await sleep(500)
  }

  harvestAllVisibleImageUrls().forEach((url) => collected.add(url))

  const stepPx = Math.max(280, Math.floor(window.innerHeight * 0.38))
  let lastScrollTop = -1
  let stuckAtSamePos = 0
  let lastCollectedSize = collected.size
  let stableHarvestRounds = 0
  const needStableRounds = document.hidden ? 8 : 5
  const stuckThreshold = document.hidden ? 10 : 6
  const stepSleepMs = document.hidden ? 1100 : 750
  let iterations = 0
  const maxIterations = options.maxIterations ?? 600

  while (!autoScrollAbort && iterations < maxIterations) {
    if (options.maxCollect && collected.size >= options.maxCollect) break
    iterations++
    harvestAllVisibleImageUrls().forEach((url) => collected.add(url))

    if (button) {
      const hint = document.hidden ? "（后台较慢）" : ""
      button.innerText = `采集中 ${collected.size} 张${hint}（点击停止）`
    }

    if (collected.size === lastCollectedSize) {
      stableHarvestRounds++
    } else {
      stableHarvestRounds = 0
      lastCollectedSize = collected.size
    }

    const metrics = scroller.getMetrics?.() || {
      scrollTop: 0,
      scrollHeight: scroller.getScrollHeight(),
      clientHeight: window.innerHeight,
    }
    const atBottom =
      metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 50

    if (metrics.scrollTop === lastScrollTop) {
      stuckAtSamePos++
    } else {
      stuckAtSamePos = 0
      lastScrollTop = metrics.scrollTop
    }

    if (atBottom && stableHarvestRounds >= needStableRounds) {
      break
    }

    if (stuckAtSamePos >= stuckThreshold) {
      scroller.scrollToBottom()
      await sleep(stepSleepMs + 300)
      stuckAtSamePos = 0
      harvestAllVisibleImageUrls().forEach((url) => collected.add(url))
      continue
    }

    scroller.scrollStep(stepPx)
    await sleep(stepSleepMs)
  }

  scroller.scrollToBottom()
  await sleep(stepSleepMs + 200)
  harvestAllVisibleImageUrls().forEach((url) => collected.add(url))
}

async function autoScrollAndSelectAll() {
  if (!isMainFrame()) return

  if (isAutoScrollRunning) {
    autoScrollAbort = true
    return
  }

  const button = document.getElementById("auto-scroll-select-all")
  const originalText = button?.innerText || "自动滚动全选"
  isAutoScrollRunning = true
  autoScrollAbort = false

  const scroller = findScrollContainer()
  if (!scroller) {
    alert("未找到可滚动区域，请手动滚动后再试")
    isAutoScrollRunning = false
    return
  }

  if (button) {
    button.disabled = false
    button.innerText = "点击停止"
  }

  const collected = new Set(selectedImageUrls)

  try {
    await runAutoScrollHarvest(scroller, collected, button)

    selectedImageUrls = [...collected]
    addCheckboxesToCards()
    syncCheckboxesWithSelection()
    updateSelectedCountDisplay()

    if (!autoScrollAbort) {
      const tabLabel = (document.title || "本页").slice(0, 24)
      showAutoScrollToast(
        `「${tabLabel}」滚动完成，已选 ${collected.size} 张，可下载`,
      )
    }
  } finally {
    isAutoScrollRunning = false
    autoScrollAbort = false
    if (button) {
      button.disabled = false
      button.innerText = originalText
    }
  }
}

function createAutoScrollSelectAllButton() {
  if (document.getElementById("auto-scroll-select-all")) return

  const button = document.createElement("button")
  button.id = "auto-scroll-select-all"
  button.innerText = "自动滚动全选"
  button.style.cssText = `position:fixed;bottom:270px;right:20px;z-index:9999;padding:12px 28px;background:linear-gradient(135deg,#4facfe 0%,#00f2fe 100%);color:white;border:none;border-radius:25px;cursor:pointer;box-shadow:0 4px 15px rgba(79,172,254,0.4);font-weight:600;font-size:14px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("mouseenter", function () {
    this.style.transform = "translateY(-2px) scale(1.05)"
    this.style.boxShadow = "0 6px 20px rgba(79,172,254,0.5)"
  })
  button.addEventListener("mouseleave", function () {
    this.style.transform = "translateY(0) scale(1)"
    this.style.boxShadow = "0 4px 15px rgba(79,172,254,0.4)"
  })
  button.addEventListener("click", autoScrollAndSelectAll)
  document.body.appendChild(button)
}

function createDeselectCurrentPageButton() {
  const button = document.createElement("button")
  button.id = "deselect-current-images"
  button.innerText = "取消当前页"
  button.style.cssText = `position:fixed;bottom:120px;right:20px;z-index:9999;padding:12px 28px;background:linear-gradient(135deg,#eb3349 0%,#f45c43 100%);color:white;border:none;border-radius:25px;cursor:pointer;box-shadow:0 4px 15px rgba(235,51,73,0.4);font-weight:600;font-size:14px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("mouseenter", function () {
    this.style.transform = "translateY(-2px) scale(1.05)"
    this.style.boxShadow = "0 6px 20px rgba(235,51,73,0.5)"
  })
  button.addEventListener("mouseleave", function () {
    this.style.transform = "translateY(0) scale(1)"
    this.style.boxShadow = "0 4px 15px rgba(235,51,73,0.4)"
  })
  button.addEventListener("click", deselectCurrentPageImages)
  document.body.appendChild(button)
}
function createClearAllSelectedButton() {
  const button = document.createElement("button")
  button.id = "clear-all-images"
  button.innerText = "取消所有选中"
  button.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:9999;padding:12px 28px;background:linear-gradient(135deg,#6b7280 0%,#9ca3af 100%);color:white;border:none;border-radius:25px;cursor:pointer;box-shadow:0 4px 15px rgba(107,114,128,0.4);font-weight:600;font-size:14px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("mouseenter", function () {
    this.style.transform = "translateY(-2px) scale(1.05)"
    this.style.boxShadow = "0 6px 20px rgba(107,114,128,0.5)"
  })
  button.addEventListener("mouseleave", function () {
    this.style.transform = "translateY(0) scale(1)"
    this.style.boxShadow = "0 4px 15px rgba(107,114,128,0.4)"
  })
  button.addEventListener("click", clearAllSelectedImages)
  document.body.appendChild(button)
}
function createDownloadSelectedButton() {
  const button = document.createElement("button")
  button.id = "download-selected-images"
  button.innerText = "下载当前选中"
  button.style.cssText = `position:fixed;bottom:70px;right:20px;z-index:9999;padding:12px 28px;background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white;border:none;border-radius:25px;cursor:pointer;box-shadow:0 4px 15px rgba(240,147,251,0.4);font-weight:600;font-size:14px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("mouseenter", function () {
    this.style.transform = "translateY(-2px) scale(1.05)"
    this.style.boxShadow = "0 6px 20px rgba(240,147,251,0.5)"
  })
  button.addEventListener("mouseleave", function () {
    this.style.transform = "translateY(0) scale(1)"
    this.style.boxShadow = "0 4px 15px rgba(240,147,251,0.4)"
  })
  button.addEventListener("click", downloadSelectedImages)
  document.body.appendChild(button)
}
function createSetDownloadFolderButton() {
  const existing = document.getElementById("set-download-folder")
  if (existing) return

  const button = document.createElement("button")
  button.id = "set-download-folder"
  button.innerText = "设置下载子目录"
  button.style.cssText = `position:fixed;bottom:20px;left:20px;z-index:9999;padding:10px 30px;background:linear-gradient(135deg,#0ea5e9 0%,#38bdf8 100%);color:white;border:none;border-radius:20px;cursor:pointer;box-shadow:0 4px 15px rgba(14,165,233,0.4);font-weight:600;font-size:13px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("mouseenter", function () {
    this.style.transform = "translateY(-2px) scale(1.05)"
    this.style.boxShadow = "0 6px 20px rgba(14,165,233,0.5)"
  })
  button.addEventListener("mouseleave", function () {
    this.style.transform = "translateY(0) scale(1)"
    this.style.boxShadow = "0 4px 15px rgba(14,165,233,0.4)"
  })
  button.addEventListener("click", () => {
    const input = prompt(
      "输入下载子目录（相对于浏览器下载目录，可留空）：",
      downloadSubDir || "",
    )
    if (input === null) {
      return
    }
    const normalized = input.trim().replace(/^\/+|\/+$/g, "")
    downloadSubDir = normalized
    saveDownloadSubDir()
    alert(
      downloadSubDir
        ? `已设置下载子目录：${downloadSubDir}\n下载将保存到浏览器下载目录下的该子目录。`
        : "已清空下载子目录，下载将直接放在浏览器下载目录。",
    )
  })
  document.body.appendChild(button)
}

function namingModeLabel(mode) {
  return mode === DOWNLOAD_NAMING_SEQUENTIAL
    ? "日期+六位序号"
    : "默认(任务ID)"
}

function conflictActionLabel(action) {
  if (action === DOWNLOAD_CONFLICT_PROMPT) return "重名询问"
  if (action === DOWNLOAD_CONFLICT_OVERWRITE) return "直接覆盖"
  return "自动重命名"
}

function updateDownloadNamingSettingsButton() {
  const button = document.getElementById("download-naming-settings")
  if (!button) return
  button.innerText = `命名:${namingModeLabel(downloadNamingMode)} · ${conflictActionLabel(downloadConflictAction)}`
}

function createDownloadNamingSettingsButton() {
  if (document.getElementById("download-naming-settings")) return

  const button = document.createElement("button")
  button.id = "download-naming-settings"
  button.style.cssText = `position:fixed;bottom:220px;left:20px;z-index:9999;max-width:min(92vw,320px);padding:10px 16px;background:linear-gradient(135deg,#6366f1 0%,#818cf8 100%);color:white;border:none;border-radius:20px;cursor:pointer;box-shadow:0 4px 15px rgba(99,102,241,0.4);font-weight:600;font-size:12px;line-height:1.35;letter-spacing:0.3px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("click", async () => {
    await loadDownloadNamingSettings()
    const today = formatDateYmd()
    const sample = `${today}_000001.webp`
    const choice = prompt(
      `下载命名与重名处理\n\n` +
        `【命名】输入 1 或 2：\n` +
        `1 = 日期+六位序号（例 ${sample}）\n` +
        `2 = 默认（任务ID+指纹）\n\n` +
        `【重名】输入 A / B / C：\n` +
        `A = 询问是否覆盖（推荐）\n` +
        `B = 自动重命名 (1)(2)…\n` +
        `C = 直接覆盖旧文件\n\n` +
        `输入 R = 重置今日序号（下一张从 ${today}_000001 开始）\n` +
        `可组合输入，如 1A；留空取消`,
      `${downloadNamingMode === DOWNLOAD_NAMING_SEQUENTIAL ? "1" : "2"}${downloadConflictAction === DOWNLOAD_CONFLICT_PROMPT ? "A" : downloadConflictAction === DOWNLOAD_CONFLICT_UNIQUIFY ? "B" : "C"}`,
    )
    if (choice === null) return

    const normalized = choice.trim().toUpperCase()
    if (!normalized) return

    if (normalized.includes("R")) {
      await sendExtensionMessage({ type: "reset-download-sequence" })
    }

    const patch = {}
    if (normalized.includes("1")) patch.namingMode = DOWNLOAD_NAMING_SEQUENTIAL
    if (normalized.includes("2")) patch.namingMode = DOWNLOAD_NAMING_DEFAULT
    if (normalized.includes("A")) patch.conflictAction = DOWNLOAD_CONFLICT_PROMPT
    if (normalized.includes("B")) patch.conflictAction = DOWNLOAD_CONFLICT_UNIQUIFY
    if (normalized.includes("C")) patch.conflictAction = DOWNLOAD_CONFLICT_OVERWRITE

    if (Object.keys(patch).length) {
      const { settings } = await sendExtensionMessage({
        type: "set-download-settings",
        ...patch,
      })
      if (settings?.namingMode) downloadNamingMode = settings.namingMode
      if (settings?.conflictAction) {
        downloadConflictAction = settings.conflictAction
      }
    }

    updateDownloadNamingSettingsButton()
    alert(
      `已保存：\n` +
        `• 命名：${namingModeLabel(downloadNamingMode)}\n` +
        `• 重名：${conflictActionLabel(downloadConflictAction)}` +
        (normalized.includes("R") ? `\n• 今日序号已重置` : ""),
    )
  })
  document.body.appendChild(button)
  updateDownloadNamingSettingsButton()
}

function createSkipDownloadedToggle() {
  if (document.getElementById("toggle-skip-downloaded")) return

  const button = document.createElement("button")
  button.id = "toggle-skip-downloaded"
  button.style.cssText = `position:fixed;bottom:70px;left:20px;z-index:9999;padding:10px 22px;background:linear-gradient(135deg,#f59e0b 0%,#fbbf24 100%);color:white;border:none;border-radius:20px;cursor:pointer;box-shadow:0 4px 15px rgba(245,158,11,0.4);font-weight:600;font-size:13px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("click", () => {
    skipDownloaded = !skipDownloaded
    saveSkipDownloaded()
    updateSkipDownloadedButton()
  })
  document.body.appendChild(button)
  updateSkipDownloadedButton()
}

async function exportHistoryBackupToDownloads() {
  const result = await sendExtensionMessage({
    type: "export-history-backup",
    downloadToFile: true,
  })
  const dl = result.counts?.downloadHistory ?? 0
  const pr = result.counts?.promptHistory ?? 0
  alert(
    `已导出 mj-history-backup.json 到浏览器下载目录。\n\n` +
      `下载记录 ${dl} 条，查询记录 ${pr} 条。\n\n` +
      `提交 Git 前请将该文件复制到项目目录：\n` +
      `data/mj-history-backup.json\n\n` +
      `也可运行：scripts\\copy-backup-from-downloads.ps1`,
  )
}

function createExportHistoryBackupButton() {
  if (document.getElementById("export-history-backup-btn")) return

  const button = document.createElement("button")
  button.id = "export-history-backup-btn"
  button.innerText = "导出历史备份"
  button.title = "导出 IndexedDB 到 JSON，用于提交到 Git data/ 目录"
  button.style.cssText = `position:fixed;bottom:270px;left:20px;z-index:9999;padding:10px 18px;background:linear-gradient(135deg,#14b8a6 0%,#2dd4bf 100%);color:#0f172a;border:none;border-radius:20px;cursor:pointer;box-shadow:0 4px 15px rgba(20,184,166,0.4);font-weight:600;font-size:12px;letter-spacing:0.3px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("click", async () => {
    button.disabled = true
    try {
      await exportHistoryBackupToDownloads()
    } catch (error) {
      alert("导出失败: " + (error.message || error))
    } finally {
      button.disabled = false
    }
  })
  document.body.appendChild(button)
}

function createDownloadHistoryButton() {
  if (document.getElementById("download-history-manage")) return

  const button = document.createElement("button")
  button.id = "download-history-manage"
  button.innerText = "下载记录"
  button.style.cssText = `position:fixed;bottom:120px;left:20px;z-index:9999;padding:10px 22px;background:linear-gradient(135deg,#8b5cf6 0%,#a78bfa 100%);color:white;border:none;border-radius:20px;cursor:pointer;box-shadow:0 4px 15px rgba(139,92,246,0.4);font-weight:600;font-size:13px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("click", async () => {
    try {
      const { count } = await sendExtensionMessage({
        type: "get-download-history-count",
      })
      alert(
        `已记录 ${count} 张已下载图片。\n\n数据保存在扩展本地 IndexedDB，仅追加、不可删除。`,
      )
    } catch (error) {
      alert("读取失败: " + (error.message || error))
    }
  })
  document.body.appendChild(button)
}

function createOpenBatchPageButton() {
  if (document.getElementById("open-batch-page-btn")) return

  const button = document.createElement("button")
  button.id = "open-batch-page-btn"
  button.innerText = "批量提示词"
  button.style.cssText = `position:fixed;bottom:170px;left:20px;z-index:9999;padding:10px 22px;background:linear-gradient(135deg,#06b6d4 0%,#22d3ee 100%);color:#0f172a;border:none;border-radius:20px;cursor:pointer;box-shadow:0 4px 15px rgba(6,182,212,0.4);font-weight:600;font-size:13px;letter-spacing:0.5px;transition:all 0.3s ease;backdrop-filter:blur(10px);`
  button.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("batch.html") })
  })
  document.body.appendChild(button)
}

async function selectCurrentPageImages(updateDisplay = true) {
  addCheckboxesToCards()
  addUrlsToSelection(harvestAllVisibleImageUrls())

  for (const { card, url } of findJobCardEntries()) {
    attachCheckboxToCard(card, url)
  }

  syncCheckboxesWithSelection()

  if (updateDisplay) {
    updateSelectedCountDisplay()
  }
}

async function downloadImagesWithConcurrency(urls, onProgress) {
  let nextIndex = 0
  let successCount = 0
  let failCount = 0
  let completed = 0

  async function worker() {
    while (nextIndex < urls.length) {
      const i = nextIndex++
      const imageUrl = urls[i]
      try {
        await downloadSingleImage(imageUrl)
        successCount++
        console.log(`已下载图片 ${imageUrl}`)
      } catch (error) {
        failCount++
        console.error(
          `下载图片失败 ${i + 1}/${urls.length}: ${imageUrl}`,
          error,
        )
      }
      completed++
      onProgress(completed, urls.length)
      await sleep(60)
    }
  }

  const workerCount = Math.min(getEffectiveDownloadConcurrency(), urls.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return { successCount, failCount }
}

async function downloadAllSelectedSilent(options = {}) {
  const useSkipDownloaded =
    options.skipDownloaded !== undefined ? options.skipDownloaded : skipDownloaded

  if (selectedImageUrls.length === 0) {
    return {
      selectedCount: 0,
      successCount: 0,
      failCount: 0,
      skippedCount: 0,
    }
  }

  const totalSelected = selectedImageUrls.length
  let urlsToDownload = [...selectedImageUrls]
  let skippedCount = 0

  if (useSkipDownloaded) {
    try {
      const filtered = await filterUrlsForDownload(urlsToDownload)
      urlsToDownload = filtered.toDownload
      skippedCount = filtered.skippedCount
    } catch (error) {
      console.warn("检查下载记录失败，将下载全部选中项:", error)
    }
  }

  if (urlsToDownload.length === 0) {
    return {
      selectedCount: totalSelected,
      successCount: 0,
      failCount: 0,
      skippedCount,
    }
  }

  const { successCount, failCount } = await downloadImagesWithConcurrency(
    urlsToDownload,
    options.onProgress || (() => {}),
  )

  return {
    selectedCount: totalSelected,
    successCount,
    failCount,
    skippedCount,
  }
}

async function downloadSelectedImages() {
  if (selectedImageUrls.length === 0) {
    alert("请先选择要下载的图片")
    return
  }
  const button = document.getElementById("download-selected-images")
  const originalText = button.innerText
  button.disabled = true

  const stats = await downloadAllSelectedSilent({
    onProgress: (done, total) => {
      button.innerText = `下载中... (${done}/${total})`
    },
  })

  button.disabled = false
  button.innerText = originalText
  refreshDownloadHistoryButtonLabel()
  markDownloadedIndicators()

  const skipMsg =
    stats.skippedCount > 0 ? `，跳过已下载 ${stats.skippedCount} 张` : ""
  if (stats.failCount === 0) {
    alert(`成功下载 ${stats.successCount} 张图片${skipMsg}`)
  } else {
    alert(
      `下载完成：成功 ${stats.successCount} 张，失败 ${stats.failCount} 张${skipMsg}`,
    )
  }
}
function deselectCurrentPageImages() {
  const checkboxes = document.querySelectorAll(".image-select-checkbox")
  checkboxes.forEach((checkbox) => {
    if (checkbox.checked) {
      checkbox.checked = false
      checkbox.style.backgroundColor = ""
      checkbox.style.borderColor = "#ddd"
      selectedImageUrls = selectedImageUrls.filter(
        (url) => url !== checkbox.dataset.convertedImageUrl,
      )
    }
  })
  updateSelectedCountDisplay()
}
function clearAllSelectedImages() {
  const checkboxes = document.querySelectorAll(".image-select-checkbox")
  checkboxes.forEach((checkbox) => {
    checkbox.checked = false
    checkbox.style.backgroundColor = ""
    checkbox.style.borderColor = "#ddd"
  })
  selectedImageUrls = []
  updateSelectedCountDisplay()
}
function saveDownloadSubDir() {
  try {
    window.localStorage.setItem(DOWNLOAD_SUBDIR_STORAGE_KEY, downloadSubDir)
  } catch (error) {
    console.error("保存下载子目录失败", error)
  }
}
function loadDownloadSubDir() {
  try {
    const stored = window.localStorage.getItem(DOWNLOAD_SUBDIR_STORAGE_KEY)
    if (typeof stored === "string") {
      downloadSubDir = stored
    }
  } catch (error) {
    console.error("读取下载子目录失败", error)
  }
}
function handleMidjourneyJobPage() {
  if (window.location.href.startsWith("https://www.midjourney.com/jobs/")) {
    const image = document.evaluate(
      "//button[@title='Close']//preceding-sibling::div/img[@class='absolute w-full h-full'][@draggable='true']",
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue
    if (image) {
      const imageUrl = image.src
      let downloadButton = document.querySelector("#bdduck-download-img-btn")
      if (!downloadButton) {
        downloadButton = document.createElement("button")
        downloadButton.className = "absolute"
        downloadButton.innerText = "下载"
        downloadButton.id = "bdduck-download-img-btn"
        downloadButton.style.cssText = `top:20px;position:absolute;right:20px;z-index:9999;padding:10px 20px;background-color:#007bff;color:white;border:none;border-radius:5px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.2);`
        const container = image.closest("div")
        if (container) {
          container.appendChild(downloadButton)
          downloadButton.dataset.imgUrl = imageUrl
          downloadButton.onclick = async function (event) {
            event.stopPropagation()
            const imgUrl = this.dataset.imgUrl
            if (imgUrl) {
              try {
                await downloadSingleImage(imgUrl)
              } catch (error) {
                console.error("下载失败:", error)
              }
            }
          }
        }
      }
    }
  }
}
// 初始化账号信息 overlay
function initAccountOverlay() {
  if (isAccountOverlayInitialized) {
    return
  }
  isAccountOverlayInitialized = true

  // 确保 DOM 已加载
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      createAccountOverlay()
      createAccountToggleButton()
      syncAccountOverlayData()
    })
  } else {
    createAccountOverlay()
    createAccountToggleButton()
    syncAccountOverlayData()
  }

  // 监听 storage 变化
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return
      }
      if (changes.cookies || changes.expiresAt || changes.lastLoginAt) {
        syncAccountOverlayData()
      }
    })
  }

  setInterval(syncAccountOverlayData, 60000)
}

// 隐藏账号信息 overlay
function hideAccountOverlay() {
  const overlay = document.getElementById(ACCOUNT_OVERLAY_ID)
  const toggleBtn = document.getElementById(ACCOUNT_TOGGLE_BUTTON_ID)

  if (overlay) {
    overlay.style.display = "none"
  }

  if (toggleBtn) {
    toggleBtn.style.display = "block"
  }
}

// 显示账号信息 overlay
function showAccountOverlay() {
  const overlay = document.getElementById(ACCOUNT_OVERLAY_ID)
  const toggleBtn = document.getElementById(ACCOUNT_TOGGLE_BUTTON_ID)

  if (overlay) {
    overlay.style.display = "block"
  }

  if (toggleBtn) {
    toggleBtn.style.display = "none"
  }
}

// 创建右侧触发按钮
function createAccountToggleButton() {
  if (document.getElementById(ACCOUNT_TOGGLE_BUTTON_ID)) {
    return
  }

  const button = document.createElement("button")
  button.id = ACCOUNT_TOGGLE_BUTTON_ID
  button.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 12C14.7614 12 17 9.76142 17 7C17 4.23858 14.7614 2 12 2C9.23858 2 7 4.23858 7 7C7 9.76142 9.23858 12 12 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M20.59 22C20.59 18.13 16.74 15 12 15C7.26 15 3.41 18.13 3.41 22" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `
  button.style.cssText = `
    position: fixed;
    top: 24px;
    right: 24px;
    z-index: 2147483647;
    padding: 10px 10px;
    background: rgba(15, 15, 16, 0.9);
    color: #fff;
    font-family: Inter, "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    backdrop-filter: blur(6px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    transition: all 0.2s ease;
    display: none;
  `

  button.addEventListener("click", showAccountOverlay)
  button.addEventListener("mouseenter", function () {
    this.style.background = "rgba(30, 30, 32, 0.95)"
    this.style.transform = "translateY(-1px)"
    this.style.boxShadow = "0 6px 16px rgba(0, 0, 0, 0.3)"
  })
  button.addEventListener("mouseleave", function () {
    this.style.background = "rgba(15, 15, 16, 0.9)"
    this.style.transform = "translateY(0)"
    this.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.2)"
  })

  document.body.appendChild(button)
}

// 创建账号信息 overlay
function createAccountOverlay() {
  if (document.getElementById(ACCOUNT_OVERLAY_ID)) {
    return
  }

  const container = document.createElement("div")
  container.id = ACCOUNT_OVERLAY_ID
  container.style.cssText = `
    position: fixed;
    top: 24px;
    right: 24px;
    z-index: 2147483647;
    width: 280px;
    padding: 16px;
    background: rgba(15, 15, 16, 0.9);
    color: #fff;
    font-family: Inter, "Segoe UI", system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    border-radius: 12px;
    backdrop-filter: blur(6px);
    box-shadow: 0 15px 30px rgba(0, 0, 0, 0.25);
    pointer-events: auto;
    user-select: text;
  `

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <strong style="font-size: 14px; color: #fff;">账号状态</strong>
      <span id="mj-status-pill" style="padding: 4px 12px; border-radius: 999px; background: #22c55e; font-size: 12px; font-weight: 600;">已登录</span>
    </div>
    <div style="margin-bottom: 10px;">
      <div style="color: #a5b1c2; font-size: 12px; margin-bottom: 4px;">最后登录时间</div>
      <div id="mj-last-login" style="color: #fff; font-size: 13px;">-</div>
    </div>
    <div style="margin-bottom: 12px;">
      <div style="color: #a5b1c2; font-size: 12px; margin-bottom: 4px;">账号到期时间</div>
      <div id="mj-expiry" style="color: #fff; font-size: 13px; font-weight: 500;">未知</div>
    </div>
    <div style="display: flex; gap: 8px;">
      <button id="mj-cancel-btn" style="
        flex: 1;
        padding: 10px 0;
        border: none;
        border-radius: 8px;
        background: #6b7280;
        color: #fff;
        font-weight: 600;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s ease;
      ">取消</button>
      <button id="mj-logout-btn" style="
        flex: 1;
        padding: 10px 0;
        border: none;
        border-radius: 8px;
        background: #ef4444;
        color: #fff;
        font-weight: 600;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s ease;
      ">退出登录</button>
    </div>
  `

  document.body.appendChild(container)

  // 添加取消按钮事件
  const cancelBtn = document.getElementById("mj-cancel-btn")
  if (cancelBtn) {
    cancelBtn.addEventListener("click", hideAccountOverlay)
    cancelBtn.addEventListener("mouseenter", function () {
      this.style.background = "#4b5563"
      this.style.transform = "translateY(-1px)"
    })
    cancelBtn.addEventListener("mouseleave", function () {
      this.style.background = "#6b7280"
      this.style.transform = "translateY(0)"
    })
  }

  // 添加退出登录按钮事件
  const logoutBtn = document.getElementById("mj-logout-btn")
  if (logoutBtn) {
    logoutBtn.addEventListener("click", handleLogout)
    logoutBtn.addEventListener("mouseenter", function () {
      this.style.background = "#dc2626"
      this.style.transform = "translateY(-1px)"
    })
    logoutBtn.addEventListener("mouseleave", function () {
      this.style.background = "#ef4444"
      this.style.transform = "translateY(0)"
    })
  }
}

let isExpiryLogoutInProgress = false

async function handleExpiredAccount() {
  if (isExpiryLogoutInProgress) {
    return
  }
  isExpiryLogoutInProgress = true
  try {
    if (chrome?.runtime?.sendMessage) {
      await chrome.runtime.sendMessage({ type: "logout" })
    }
    window.location.reload()
  } catch (error) {
    console.error("账号过期自动退出失败:", error)
  } finally {
    isExpiryLogoutInProgress = false
  }
}

// 同步账号信息 overlay 数据
async function syncAccountOverlayData() {
  if (!chrome?.storage?.local) {
    return
  }

  try {
    const result = await chrome.storage.local.get([
      "cookies",
      "token",
      "expiresAt",
      "lastLoginAt",
    ])

    const statusPill = document.getElementById("mj-status-pill")
    const lastLoginEl = document.getElementById("mj-last-login")
    const expiryEl = document.getElementById("mj-expiry")
    const logoutBtn = document.getElementById("mj-logout-btn")

    if (!statusPill || !lastLoginEl || !expiryEl || !logoutBtn) {
      return
    }

    const sessionInvalid = shouldForceReLogin(
      result?.expiresAt,
      result?.lastLoginAt,
    )
    const hasStoredAuth = Boolean(result?.cookies || result?.token)

    if (sessionInvalid && hasStoredAuth) {
      await handleExpiredAccount()
      return
    }

    const hasToken = hasStoredAuth && !sessionInvalid

    if (hasToken) {
      statusPill.textContent = "已登录"
      statusPill.style.background = "#22c55e"
      logoutBtn.disabled = false
      logoutBtn.style.opacity = "1"
      logoutBtn.style.cursor = "pointer"
    } else {
      statusPill.textContent = "未登录"
      statusPill.style.background = "#f97316"
      logoutBtn.disabled = true
      logoutBtn.style.opacity = "0.6"
      logoutBtn.style.cursor = "not-allowed"
    }

    lastLoginEl.textContent = result?.lastLoginAt
      ? formatDate(result.lastLoginAt)
      : "-"

    if (result?.expiresAt) {
      const expiryDate = new Date(result.expiresAt)
      const now = new Date()
      const timeLeft = expiryDate - now

      if (timeLeft > 0) {
        const days = Math.floor(timeLeft / (1000 * 60 * 60 * 24))
        const hours = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
        expiryEl.textContent = formatDate(result.expiresAt)
        expiryEl.style.color = days < 7 ? "#f97316" : "#22c55e"
      } else {
        expiryEl.textContent = "已过期"
        expiryEl.style.color = "#ef4444"
      }
    } else {
      expiryEl.textContent = "未知"
      expiryEl.style.color = "#a5b1c2"
    }
  } catch (error) {
    console.error("同步账号信息失败:", error)
  }
}

// 处理退出登录
async function handleLogout() {
  if (!confirm("确定要退出登录吗？")) {
    return
  }

  try {
    if (chrome?.runtime?.sendMessage) {
      await chrome.runtime.sendMessage({ type: "logout" })
    }
  } catch (error) {
    console.error("退出登录失败:", error)
  }

  // 刷新页面
  window.location.reload()
}

// 格式化日期
function formatDate(value) {
  if (!value) {
    return "-"
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function isVisibleElement(el) {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const style = getComputedStyle(el)
  return style.visibility !== "hidden" && style.display !== "none"
}

function setNativeInputValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

function getInputHint(el) {
  return `${el.placeholder || ""} ${el.getAttribute("aria-label") || ""} ${el.name || ""} ${el.className || ""}`.toLowerCase()
}

function isMainCreatePromptInput(el) {
  const hint = getInputHint(el)
  return (
    hint.includes("imagine") ||
    hint.includes("what will you") ||
    hint.includes("describe") ||
    (hint.includes("prompt") && !hint.includes("search"))
  )
}

function scoreExploreSearchInput(el) {
  const hint = getInputHint(el)
  if (isMainCreatePromptInput(el)) return -100
  let score = 0
  if (hint.includes("search images")) score = 100
  else if (hint.includes("search image")) score = 95
  else if (el.type === "search") score = 80
  else if (hint.includes("search")) score = 70
  else if (hint.includes("explore")) score = 40
  else if (hint.includes("filter")) score = 30
  else return 0

  const rect = el.getBoundingClientRect()
  if (rect.left > window.innerWidth * 0.55) score += 20
  if (rect.top < 140) score += 8
  return score
}

function findExploreSearchInput() {
  const selectors = [
    'input[placeholder*="Search Images" i]',
    'input[aria-label*="Search Images" i]',
    'input[type="search"]',
    'input[placeholder*="Search" i]',
    'input[aria-label*="Search" i]',
    '[role="searchbox"]',
    '[class*="search"] input',
    '[data-testid*="search"] input',
    "input",
  ]

  const seen = new Set()
  const candidates = []

  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (!(el instanceof HTMLInputElement) || seen.has(el)) continue
      seen.add(el)
      if (!isVisibleElement(el)) continue
      const score = scoreExploreSearchInput(el)
      if (score > 0) candidates.push({ el, score })
    }
  }

  for (const el of document.querySelectorAll('[role="searchbox"], [contenteditable="true"]')) {
    if (seen.has(el) || !isVisibleElement(el)) continue
    seen.add(el)
    const hint = getInputHint(el)
    if (isMainCreatePromptInput(el)) continue
    if (hint.includes("search images") || hint.includes("search")) {
      candidates.push({ el, score: hint.includes("search images") ? 100 : 75 })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.el || null
}

function clickExploreSearchImagesTrigger() {
  const directSelectors = [
    'button[aria-label*="Search Images" i]',
    'a[aria-label*="Search Images" i]',
    '[role="button"][aria-label*="Search Images" i]',
    'input[placeholder*="Search Images" i]',
    'input[aria-label*="Search Images" i]',
  ]
  for (const selector of directSelectors) {
    const el = document.querySelector(selector)
    if (el && isVisibleElement(el)) {
      el.focus?.()
      el.click()
      return true
    }
  }

  for (const el of document.querySelectorAll("button, a, [role='button'], label")) {
    if (!isVisibleElement(el)) continue
    const label = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`
      .trim()
      .toLowerCase()
    if (label === "search images" || /\bsearch images\b/.test(label)) {
      el.click()
      return true
    }
  }

  for (const el of document.querySelectorAll("span, div, p")) {
    if (!isVisibleElement(el)) continue
    if ((el.textContent || "").trim().toLowerCase() !== "search images") continue
    const clickable = el.closest("button, a, label, [role='button']") || el
    clickable.click()
    return true
  }

  return false
}

async function openExploreImageSearchInput(maxWaitMs = 20000) {
  const start = Date.now()

  while (Date.now() - start < maxWaitMs) {
    const ready = findExploreSearchInput()
    if (ready && scoreExploreSearchInput(ready) >= 95) return ready

    clickExploreSearchImagesTrigger()
    await sleep(700)

    const input = findExploreSearchInput()
    if (input && scoreExploreSearchInput(input) >= 70) return input

    await sleep(450)
  }

  const fallback = findExploreSearchInput()
  if (fallback && scoreExploreSearchInput(fallback) >= 70) return fallback
  return null
}

async function ensureExplorePage() {
  if (location.pathname.includes("/explore")) return
  window.location.href = "https://www.midjourney.com/explore?tab=top"
  await sleep(3500)
}

function clickSearchSubmitNear(input) {
  const container =
    input.closest("form") ||
    input.closest('[class*="search"]') ||
    input.parentElement?.parentElement
  if (!container) return false

  const buttons = container.querySelectorAll("button")
  for (const btn of buttons) {
    const label = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.toLowerCase()
    if (
      label.includes("search") ||
      label.includes("apply") ||
      label.includes("filter")
    ) {
      btn.click()
      return true
    }
  }
  return false
}

function dispatchEnterKey(input) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    input.dispatchEvent(
      new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    )
  }
}

function parseExploreJobsPayload(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.jobs)) return data.jobs
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data?.results)) return data.results
  return []
}

function extractCdnUrlsFromJob(job) {
  const urls = new Set()
  const jobId = job?.id || job?.job_id || job?.jobId
  if (jobId && /^[0-9a-f-]{36}$/i.test(String(jobId))) {
    urls.add(
      normalizeImageUrl(`https://cdn.midjourney.com/${String(jobId)}/0_0.webp`),
    )
  }

  for (const field of [
    job?.imageUrl,
    job?.image_url,
    job?.url,
    job?.event?.url,
  ]) {
    if (field && MJ_CDN_PATTERN.test(field)) {
      urls.add(normalizeImageUrl(field))
    }
  }

  if (Array.isArray(job?.events)) {
    for (const ev of job.events) {
      if (ev?.url && MJ_CDN_PATTERN.test(ev.url)) {
        urls.add(normalizeImageUrl(ev.url))
      }
    }
  }

  if (urls.size === 0 && job) {
    const json = JSON.stringify(job)
    const matches = json.match(
      /https:\/\/cdn\.midjourney\.com\/[0-9a-f-]+\/\d+_\d+\.webp/gi,
    )
    matches?.forEach((url) => urls.add(normalizeImageUrl(url)))
  }

  return [...urls]
}

function jobMatchesPrompt(job, prompt) {
  const text = JSON.stringify(job || {}).toLowerCase()
  const terms = prompt
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ""))
    .filter((w) => w.length > 3)
  if (terms.length < 2) return true
  const hits = terms.filter((t) => text.includes(t)).length
  return hits >= Math.min(2, Math.ceil(terms.length * 0.3))
}

const EXPLORE_API_AMOUNT = 100
const EXPLORE_API_MAX_PAGES = 100

function getExploreApiTemplates(prompt) {
  const q = encodeURIComponent(prompt)
  const qurl = encodeURIComponent("https://www.midjourney.com/explore?tab=top")
  const amount = EXPLORE_API_AMOUNT
  const mk =
    (extra) =>
    (page) =>
      `https://www.midjourney.com/api/app/recent-jobs/?amount=${amount}&page=${page}&dedupe=true&jobStatus=completed&${extra}&_qurl=${qurl}`

  return [
    mk(
      `jobType=upscale&orderBy=top&service=main&search=${q}&searchType=text`,
    ),
    mk(`orderBy=top&service=explore&query=${q}`),
    mk(`orderBy=hot&service=main&prompt=${q}`),
    mk(`orderBy=top&service=main&search=${q}`),
    mk(`orderBy=top&search=${q}`),
  ]
}

async function fetchExploreJobsFromApi(prompt, apiUrl) {
  const response = await fetch(apiUrl, {
    credentials: "include",
    headers: { accept: "application/json, text/plain, */*" },
  })
  if (!response.ok) return { jobs: [], urls: [] }
  const data = await response.json()
  const jobs = parseExploreJobsPayload(data)
  const urls = new Set()
  const trustFilter = /[?&](search|query|prompt)=/i.test(apiUrl)
  for (const job of jobs) {
    if (!trustFilter && !jobMatchesPrompt(job, prompt)) continue
    extractCdnUrlsFromJob(job).forEach((url) => urls.add(url))
  }
  if (urls.size === 0 && jobs.length > 0 && trustFilter) {
    for (const job of jobs) {
      extractCdnUrlsFromJob(job).forEach((url) => urls.add(url))
    }
  }
  return { jobs, urls: [...urls] }
}

async function searchExploreViaApi(prompt, options = {}) {
  const maxCollect = options.maxCollect ?? 1000
  const collected = options.collected ?? new Set()
  const templates = getExploreApiTemplates(prompt)
  let activeTemplate = null

  for (let page = 0; page < EXPLORE_API_MAX_PAGES; page++) {
    if (collected.size >= maxCollect) break

    let jobs = []

    if (activeTemplate !== null) {
      const apiUrl = templates[activeTemplate](page)
      try {
        const result = await fetchExploreJobsFromApi(prompt, apiUrl)
        jobs = result.jobs
        for (const url of result.urls) {
          if (collected.size >= maxCollect) break
          collected.add(url)
        }
      } catch {
        break
      }
    } else {
      for (let t = 0; t < templates.length; t++) {
        try {
          const apiUrl = templates[t](page)
          const result = await fetchExploreJobsFromApi(prompt, apiUrl)
          if (result.jobs.length > 0) {
            activeTemplate = t
            jobs = result.jobs
            for (const url of result.urls) {
              if (collected.size >= maxCollect) break
              collected.add(url)
            }
            break
          }
        } catch {
          /* try next template */
        }
      }
      if (activeTemplate === null) break
    }

    if (jobs.length === 0) break

    reportBatchStep(
      `API 第 ${page + 1} 页，已 ${collected.size}/${maxCollect} 张`,
    )

    if (jobs.length < EXPLORE_API_AMOUNT) break
  }

  return [...collected]
}

async function harvestExplorePageUrls(prompt, options = {}) {
  const maxIterations = options.maxIterations ?? 600
  const maxCollect = options.maxCollect ?? 5000
  const collected = options.collected ?? new Set()

  const scroller = findScrollContainer()
  if (scroller && collected.size < maxCollect) {
    const prevAbort = autoScrollAbort
    autoScrollAbort = false
    await runAutoScrollHarvest(scroller, collected, null, {
      maxIterations,
      maxCollect,
    })
    autoScrollAbort = prevAbort
  } else if (collected.size < maxCollect) {
    harvestAllVisibleImageUrls().forEach((url) => {
      if (collected.size < maxCollect) collected.add(url)
    })
  }

  const terms = prompt
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ""))
    .filter((w) => w.length > 3)
  if (terms.length >= 2 && !options.collected) {
    const filtered = [...collected].filter((url) => {
      const hay = url.toLowerCase()
      return terms.some((t) => hay.includes(t))
    })
    if (filtered.length >= 2) {
      collected.clear()
      filtered.slice(0, maxCollect).forEach((url) => collected.add(url))
    }
  }
  return [...collected]
}

async function runExplorePageSearch(prompt) {
  try {
    const mainWorld = await sendExtensionMessage({
      type: "main-world-explore-search",
      prompt,
    })
    if (mainWorld?.ok) {
      await sleep(2200)
      return true
    }
  } catch {
    /* fallback below */
  }

  await searchExploreByPrompt(prompt)
  await sleep(1200)
  return true
}

async function collectBatchImageUrls(prompt, maxCollect = 1000) {
  maxCollect = Math.min(Math.max(Number(maxCollect) || 1000, 50), 5000)
  const collected = new Set()

  reportBatchStep(`API 分页采集 0/${maxCollect}…`)
  await searchExploreViaApi(prompt, { maxCollect, collected })

  if (collected.size < maxCollect) {
    reportBatchStep(`页面滚动补采 ${collected.size}/${maxCollect}…`)
    await runExplorePageSearch(prompt)
    await waitForSearchResults()
    await harvestExplorePageUrls(prompt, {
      maxIterations: 600,
      maxCollect,
      collected,
    })
  }

  const urls = [...collected].slice(0, maxCollect)
  if (urls.length >= maxCollect) {
    showAutoScrollToast(`已达采集上限 ${maxCollect} 张`)
  } else if (urls.length > 0) {
    showAutoScrollToast(`采集完成，共 ${urls.length} 张`)
  }

  if (urls.length === 0) {
    throw new Error("未采集到图片，请确认 Explore Search Images 可手动搜索")
  }
  return urls
}

async function withExploreSearchNetworkProbe(run) {
  let apiHit = false
  const mark = (url) => {
    const u = String(url || "")
    if (!/midjourney\.com/i.test(u)) return
    if (/(search|explore|feed|prompt|job|rank)/i.test(u)) apiHit = true
  }

  const origFetch = window.fetch
  window.fetch = async (...args) => {
    try {
      mark(typeof args[0] === "string" ? args[0] : args[0]?.url)
    } catch {
      /* ignore */
    }
    return origFetch.apply(window, args)
  }

  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      mark(url)
    } catch {
      /* ignore */
    }
    return origOpen.call(this, method, url, ...rest)
  }

  try {
    return await run(() => apiHit)
  } finally {
    window.fetch = origFetch
    XMLHttpRequest.prototype.open = origOpen
  }
}

function exploreResultsMatchPrompt(prompt) {
  const terms = prompt
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ""))
    .filter((w) => w.length > 3)
  if (terms.length < 2) return false

  const need = Math.min(2, Math.ceil(terms.length * 0.35))
  let matchedCards = 0
  for (const card of document.querySelectorAll(
    'a[href*="/jobs/"], div[class*="jobCard"], div[class*="grid"] a',
  )) {
    const text = (card.textContent || card.getAttribute("aria-label") || "").toLowerCase()
    const hits = terms.filter((t) => text.includes(t)).length
    if (hits >= need) matchedCards++
  }
  return matchedCards >= 2
}

async function typePromptIntoSearchField(field, prompt) {
  field.focus()
  field.click()
  await sleep(200)

  if (field.isContentEditable) {
    field.textContent = ""
  } else {
    setNativeInputValue(field, "")
  }
  field.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
  )
  await sleep(120)

  try {
    field.focus()
    if (typeof field.select === "function") field.select()
    document.execCommand("insertText", false, prompt)
  } catch {
    /* execCommand may fail on some fields */
  }

  if (field.isContentEditable) {
    if (!(field.textContent || "").includes(prompt.slice(0, 8))) {
      field.textContent = prompt
    }
  } else if (!(field.value || "").includes(prompt.slice(0, 8))) {
    await typePromptCharByChar(field, prompt)
  }

  field.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertFromPaste",
      data: prompt,
    }),
  )
  field.dispatchEvent(new Event("change", { bubbles: true }))
}

async function typePromptCharByChar(field, prompt) {
  setNativeInputValue(field, "")
  for (const char of prompt) {
    setNativeInputValue(field, (field.value || "") + char)
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: char,
        inputType: "insertText",
      }),
    )
    await sleep(10)
  }
}

function clickNearbySearchIcon(input) {
  const roots = [
    input.closest("form"),
    input.closest('[class*="search"]'),
    input.closest("header"),
    input.parentElement?.parentElement,
    input.parentElement,
  ].filter(Boolean)

  for (const root of roots) {
    for (const btn of root.querySelectorAll("button, [role='button']")) {
      const label = `${btn.textContent || ""} ${btn.getAttribute("aria-label") || ""}`.toLowerCase()
      if (label.includes("search images")) {
        btn.click()
        return true
      }
      if (label.includes("search") && btn !== input) {
        btn.click()
        return true
      }
    }
    const svgBtn = root.querySelector("button svg, [role='button'] svg")
    svgBtn?.closest("button")?.click()
  }
  return false
}

async function submitExploreSearch(input, prompt) {
  clickExploreSearchImagesTrigger()
  await sleep(350)
  input.focus()
  input.click()

  await typePromptIntoSearchField(input, prompt)
  await sleep(900)

  dispatchEnterKey(input)
  await sleep(350)
  clickNearbySearchIcon(input)
  clickSearchSubmitNear(input)

  const form = input.closest("form")
  if (form?.requestSubmit) {
    try {
      form.requestSubmit()
    } catch {
      /* ignore */
    }
  }
}

async function waitForExploreSearchApplied(prompt, beforeUrl, getApiHit, maxWaitMs = 30000) {
  const baselineUrls = [...harvestAllVisibleImageUrls()].slice(0, 12).sort().join("|")
  const needle = prompt.trim().toLowerCase()
  const start = Date.now()

  while (Date.now() - start < maxWaitMs) {
    if (location.href !== beforeUrl) return true
    if (getApiHit()) {
      await sleep(1200)
      return true
    }
    if (exploreResultsMatchPrompt(prompt)) return true

    const urlLower = location.href.toLowerCase()
    if (
      needle &&
      (urlLower.includes(encodeURIComponent(needle.slice(0, 12))) ||
        /[?&](q|query|search|prompt)=/.test(urlLower))
    ) {
      return true
    }

    const currentUrls = [...harvestAllVisibleImageUrls()].slice(0, 12).sort().join("|")
    if (currentUrls && baselineUrls && currentUrls !== baselineUrls) {
      await sleep(800)
      if (exploreResultsMatchPrompt(prompt) || getApiHit()) return true
    }

    await sleep(450)
  }

  return exploreResultsMatchPrompt(prompt)
}

async function searchExploreByPrompt(prompt) {
  await ensureExplorePage()
  await sleep(800)

  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      reportBatchStep(
        attempt === 0
          ? "打开 Explore Search Images…"
          : `重试搜索 (${attempt + 1}/3)…`,
      )

      clickExploreSearchImagesTrigger()
      await sleep(700)

      const input = await openExploreImageSearchInput()
      if (!input) {
        throw new Error(
          "未找到 Explore「Search Images」搜索框，请确认页面右上角 Search Images 可点击",
        )
      }

      showAutoScrollToast(`批量搜索：${prompt.slice(0, 48)}…`)
      const beforeUrl = location.href

      const applied = await withExploreSearchNetworkProbe(async (getApiHit) => {
        await submitExploreSearch(input, prompt)
        return waitForExploreSearchApplied(prompt, beforeUrl, getApiHit)
      })

      if (!applied) {
        throw new Error(
          "Explore 搜索未生效，请手动点击右上角 Search Images 输入提示词试一下",
        )
      }

      await sleep(1000)
      return true
    } catch (error) {
      lastError = error
      await sleep(900)
    }
  }

  throw lastError || new Error("Explore 搜索失败")
}

async function waitForSearchResults(maxWaitMs = 20000) {
  let lastCount = -1
  let stableRounds = 0
  const start = Date.now()

  while (Date.now() - start < maxWaitMs) {
    addCheckboxesToCards()
    const count = harvestAllVisibleImageUrls().size

    if (count === lastCount) stableRounds++
    else {
      stableRounds = 0
      lastCount = count
    }

    if (stableRounds >= 4) return count
    await sleep(700)
  }

  return harvestAllVisibleImageUrls().size
}

function reportBatchStep(step) {
  if (!chrome?.runtime?.sendMessage) return
  chrome.runtime.sendMessage({ type: "batch-step-progress", step }).catch(() => {})
}

function runBatchPromptTaskWithTimeout(message) {
  const maxCollect = Math.min(
    Math.max(Number(message.maxCollect) || 1000, 50),
    5000,
  )
  const timeoutMs = Math.max(600000, maxCollect * 800)
  return Promise.race([
    runBatchPromptTask(message),
    sleep(timeoutMs).then(() => {
      throw new Error(
        `单条提示词执行超时（${Math.round(timeoutMs / 60000)} 分钟），已跳过`,
      )
    }),
  ])
}

async function runBatchPromptTask(message) {
  if (!isMainFrame()) {
    throw new Error("请在主页面运行批量任务")
  }

  const prompt = String(message.prompt || "").trim()
  if (!prompt) throw new Error("提示词为空")

  if (!isCheckboxSystemInitialized) {
    initializeCheckboxSystem()
  }

  const prevSubDir = downloadSubDir
  const prevSkipDownloaded = skipDownloaded

  try {
    if (message.downloadSubDir) {
      downloadSubDir = message.downloadSubDir
    }
    const promptFolder = sanitizeFilenamePart(prompt.slice(0, 48))
    if (promptFolder) {
      downloadSubDir = downloadSubDir
        ? `${downloadSubDir}/${promptFolder}`
        : promptFolder
    }

    if (message.skipDownloaded !== undefined) {
      skipDownloaded = message.skipDownloaded
    }

    showAutoScrollToast(`批量任务：${prompt.slice(0, 48)}…`)
    const maxCollect = Math.min(
      Math.max(Number(message.maxCollect) || 1000, 50),
      5000,
    )
    const collectedUrls = await collectBatchImageUrls(prompt, maxCollect)
    selectedImageUrls = [...collectedUrls]
    syncCheckboxesWithSelection()

    let downloadStats = {
      successCount: 0,
      failCount: 0,
      skippedCount: 0,
    }

    if (message.autoDownload !== false && selectedImageUrls.length > 0) {
      downloadStats = await downloadAllSelectedSilent({
        skipDownloaded: message.skipDownloaded,
      })
    }

    return {
      ok: true,
      selectedCount: collectedUrls.length,
      imageUrls: collectedUrls,
      successCount: downloadStats.successCount,
      failCount: downloadStats.failCount,
      skippedCount: downloadStats.skippedCount,
    }
  } finally {
    downloadSubDir = prevSubDir
    skipDownloaded = prevSkipDownloaded
  }
}

function init() {
  if (!isMainFrame()) return

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init)
  } else {
    // 初始化账号信息 overlay
    initAccountOverlay()

    if (window.location.href.startsWith("https://www.midjourney.com/jobs/")) {
      handleMidjourneyJobPage()
      setInterval(handleMidjourneyJobPage, 1000)
    } else {
      initializeCheckboxSystem()
    }
  }
}
init()
let lastUrl = location.href
new MutationObserver(() => {
  if (!isMainFrame()) return

  const url = location.href
  if (url !== lastUrl) {
    lastUrl = url
    setTimeout(() => {
      // 确保账号信息 overlay 已初始化
      if (!isAccountOverlayInitialized) {
        initAccountOverlay()
      }

      if (url.startsWith("https://www.midjourney.com/jobs/")) {
        handleMidjourneyJobPage()
      } else {
        initializeCheckboxSystem()
      }
    }, 500)
  }
}).observe(document, { subtree: true, childList: true })

if (chrome?.runtime?.onMessage && !globalThis.__bdduckMjBatchListener) {
  globalThis.__bdduckMjBatchListener = true
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "content-ping") {
      sendResponse({ ok: true })
      return false
    }
    if (message?.type === "batch-run-prompt") {
      runBatchPromptTaskWithTimeout(message)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ ok: false, error: error.message || String(error) }),
        )
      return true
    }
    return false
  })
}
