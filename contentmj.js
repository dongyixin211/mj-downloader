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

// 批量下载并发数（过多易触发扩展/下载队列失败）
const DOWNLOAD_CONCURRENCY = 2
const DOWNLOAD_RETRY_TIMES = 2

// 下载子目录（相对于浏览器下载目录），用户可通过按钮设置
let downloadSubDir = ""
const DOWNLOAD_SUBDIR_STORAGE_KEY = "bdduck-download-subdir"

// 跳过已下载（IndexedDB 记录，默认开启）
const SKIP_DOWNLOADED_KEY = "bdduck-skip-downloaded"
let skipDownloaded = true
let markDownloadedTimer = null
const downloadedUrlSet = new Set()

// 账号信息 overlay 相关
const ACCOUNT_OVERLAY_ID = "mj-account-info-overlay"
const ACCOUNT_TOGGLE_BUTTON_ID = "mj-account-toggle-btn"
let isAccountOverlayInitialized = false
let mutationDebounceTimer = null
let domObserver = null
let intersectionObserver = null

const MJ_CDN_PATTERN = /cdn\.midjourney\.com/i

function normalizeImageUrl(url) {
  if (!url) return ""
  let normalized = url.trim().replace(/&amp;/g, "&")
  normalized = normalized.split("?")[0].split("#")[0]
  // 仅统一扩展名，保留完整路径，避免不同变体被合并成同一张
  if (MJ_CDN_PATTERN.test(normalized)) {
    normalized = normalized.replace(/\.(png|jpe?g|gif)$/i, ".webp")
  }
  return normalized
}

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

function sendExtensionMessage(payload) {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      reject(new Error("Extension unavailable"))
      return
    }
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError)
        return
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed"))
        return
      }
      resolve(response)
    })
  })
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
  bindScrollListeners()
  createSelectCurrentPageButton()
  createAutoScrollSelectAllButton()
  createDeselectCurrentPageButton()
  createClearAllSelectedButton()
  createDownloadSelectedButton()
  createSetDownloadFolderButton()
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
function ensureWebpUrl(imageUrl) {
  if (/\.webp$/i.test(imageUrl)) return imageUrl
  if (/\.png$/i.test(imageUrl)) return imageUrl.replace(/\.png$/i, ".webp")
  return `${imageUrl.replace(/\/$/, "")}.webp`
}

function getDownloadUrlCandidates(imageUrl) {
  const webpUrl = ensureWebpUrl(imageUrl)
  const candidates = [webpUrl]
  const gridPng = webpUrl.replace(
    /(\/[a-f0-9-]+\/\d+_\d+)(_[^/]*)?\.webp$/i,
    "$1.png",
  )
  if (gridPng !== webpUrl && !candidates.includes(gridPng)) {
    candidates.push(gridPng)
  }
  return candidates
}

function hashUrlFingerprint(url) {
  const text = String(url || "")
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
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
      })
      return
    } catch (error) {
      lastError = error
      if (attempt < DOWNLOAD_RETRY_TIMES - 1) {
        await sleep(400)
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

async function downloadSingleImage(imageUrl) {
  const webpUrl = ensureWebpUrl(imageUrl)
  const filename = deriveDownloadFilename(webpUrl, imageUrl)
  const finalFilename = downloadSubDir
    ? `${downloadSubDir}/${filename}`
    : filename

  const candidates = getDownloadUrlCandidates(imageUrl)
  let lastError

  for (const url of candidates) {
    const ext = /\.webp$/i.test(url) ? ".webp" : ".png"
    const nameForUrl = finalFilename.replace(/\.(png|webp|jpe?g)$/i, ext)
    try {
      await requestBackgroundDownload(url, nameForUrl, imageUrl)
      return
    } catch (error) {
      lastError = error
    }
  }

  try {
    await downloadViaPageFetch(imageUrl, finalFilename)
  } catch (fetchError) {
    throw lastError || fetchError
  }
}
function sanitizeFilenamePart(part) {
  return String(part)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 100)
}

/** 从 CDN URL 生成唯一文件名：任务ID + 索引 + URL指纹，避免 0_0_384_N 重名 */
function deriveDownloadFilename(url, sourceUrlForFingerprint) {
  const fingerprint = hashUrlFingerprint(
    normalizeImageUrl(sourceUrlForFingerprint || url),
  )

  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split("/").filter(Boolean)
    const lastSeg = segments[segments.length - 1] || "image.webp"
    const extMatch = lastSeg.match(/\.(webp|png|jpe?g|gif)$/i)
    const ext = extMatch ? extMatch[1].toLowerCase() : "webp"
    const fileStem = sanitizeFilenamePart(
      lastSeg.replace(/\.(webp|png|jpe?g|gif)$/i, ""),
    )

    const uuidSeg = segments.find((s) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        s,
      ),
    )

    if (uuidSeg) {
      return `${sanitizeFilenamePart(uuidSeg)}_${fileStem}_${fingerprint}.${ext}`
    }

    if (segments.length >= 2) {
      const parent = sanitizeFilenamePart(segments[segments.length - 2])
      return `${parent}_${fileStem}_${fingerprint}.${ext}`
    }

    return `${fileStem}_${fingerprint}.${ext}`
  } catch {
    return `mj_${fingerprint}_${Date.now()}.webp`
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

async function runAutoScrollHarvest(scroller, collected, button) {
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
  const maxIterations = 600

  while (!autoScrollAbort && iterations < maxIterations) {
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
      const shouldClear = confirm(
        `已记录 ${count} 张已下载图片（扩展本地 IndexedDB，可长期保存大量记录）。\n\n• 点「确定」→ 清空全部记录（之后可重新下载）\n• 点「取消」→ 仅查看，不做改动`,
      )
      if (!shouldClear) return
      await sendExtensionMessage({ type: "clear-download-history" })
      downloadedUrlSet.clear()
      document
        .querySelectorAll(".image-select-checkbox[data-already-downloaded]")
        .forEach((cb) => applyDownloadedIndicator(cb, false))
      refreshDownloadHistoryButtonLabel()
      alert("下载记录已清空")
    } catch (error) {
      alert("操作失败: " + (error.message || error))
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

  const workerCount = Math.min(DOWNLOAD_CONCURRENCY, urls.length)
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

function findExploreSearchInput() {
  const scopedSelectors = [
    'header input[type="search"]',
    'header input[type="text"]',
    'nav input[type="search"]',
    '[class*="search"] input',
    '[data-testid*="search"] input',
  ]

  for (const selector of scopedSelectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (isVisibleElement(el)) return el
    }
  }

  const selectors = [
    'input[type="search"]',
    'input[placeholder*="Search" i]',
    'input[placeholder*="search" i]',
    'input[placeholder*="Explore" i]',
    'input[placeholder*="style" i]',
    'input[placeholder*="prompt" i]',
    'input[aria-label*="search" i]',
    'input[aria-label*="Search" i]',
    '[role="searchbox"]',
  ]

  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (isVisibleElement(el)) return el
    }
  }

  return [...document.querySelectorAll("input")]
    .filter(isVisibleElement)
    .find((el) => {
      const hint = `${el.placeholder || ""} ${el.getAttribute("aria-label") || ""} ${el.className || ""}`.toLowerCase()
      return (
        hint.includes("search") ||
        hint.includes("explore") ||
        hint.includes("style") ||
        hint.includes("prompt") ||
        hint.includes("filter")
      )
    })
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

async function searchExploreByPrompt(prompt) {
  await ensureExplorePage()

  const input = findExploreSearchInput()
  if (!input) {
    throw new Error("未找到 Explore 搜索框，请确认已登录并在 Explore 页面")
  }

  input.focus()
  setNativeInputValue(input, "")
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await sleep(200)

  setNativeInputValue(input, prompt)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))

  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
    }),
  )

  if (!clickSearchSubmitNear(input)) {
    const submitBtn = document.querySelector(
      'button[type="submit"], button[aria-label*="Search" i]',
    )
    submitBtn?.click()
  }

  await sleep(1800)
  return true
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

    await searchExploreByPrompt(prompt)
    await waitForSearchResults()

    selectedImageUrls = []
    const collected = new Set()
    const scroller = findScrollContainer()
    if (!scroller) {
      throw new Error("未找到可滚动区域")
    }

    const prevAbort = autoScrollAbort
    autoScrollAbort = false
    await runAutoScrollHarvest(scroller, collected, null)
    autoScrollAbort = prevAbort

    selectedImageUrls = [...collected]
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
      selectedCount: collected.size,
      imageUrls: [...collected],
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

if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "batch-run-prompt") {
      runBatchPromptTask(message)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ ok: false, error: error.message || String(error) }),
        )
      return true
    }
    return false
  })
}
