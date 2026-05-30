const promptsInput = document.getElementById("prompts-input")
const skipQueriedEl = document.getElementById("skip-queried")
const autoDownloadEl = document.getElementById("auto-download")
const skipDownloadedEl = document.getElementById("skip-downloaded")
const parallelEl = document.getElementById("parallel-count")
const maxCollectEl = document.getElementById("max-collect")
const subdirEl = document.getElementById("download-subdir")
const previewList = document.getElementById("preview-list")
const previewStats = document.getElementById("preview-stats")
const startBtn = document.getElementById("start-btn")
const stopBtn = document.getElementById("stop-btn")
const clearHistoryBtn = document.getElementById("clear-history-btn")
const historyCountEl = document.getElementById("history-count")
const progressText = document.getElementById("progress-text")
const progressFill = document.getElementById("progress-fill")
const currentPromptsEl = document.getElementById("current-prompts")
const logList = document.getElementById("log-list")
const openMjBtn = document.getElementById("open-mj-btn")

const PROMPTS_DRAFT_KEY = "bdduck-batch-prompts-draft"

function sendMessage(payload, retries = 4) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error("扩展不可用，请重新加载扩展"))
        return
      }
      chrome.runtime.sendMessage(payload, (response) => {
        const err = chrome.runtime.lastError
        if (err) {
          const msg = err.message || String(err)
          const retriable =
            left > 0 &&
            (msg.includes("message port closed") ||
              msg.includes("Receiving end does not exist") ||
              msg.includes("Could not establish connection"))
          if (retriable) {
            setTimeout(() => attempt(left - 1), 350)
            return
          }
          reject(new Error(msg))
          return
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "请求失败"))
          return
        }
        resolve(response)
      })
    }
    attempt(retries)
  })
}

async function ensureBackgroundReady() {
  await sendMessage({ type: "ping" }, 5)
}

function parsePromptLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

async function refreshHistoryCount() {
  try {
    const { count } = await sendMessage({ type: "get-prompt-history-count" })
    historyCountEl.textContent = String(count ?? 0)
  } catch {
    historyCountEl.textContent = "?"
  }
}

async function refreshPreview() {
  const prompts = parsePromptLines(promptsInput.value)
  previewStats.textContent = `${prompts.length} 条`

  if (!prompts.length) {
    previewList.innerHTML = '<li style="color:#64748b">粘贴提示词后将显示预览</li>'
    return
  }

  try {
    const { queried, notQueried } = await sendMessage({
      type: "filter-prompt-history",
      prompts,
    })
    const queriedSet = new Set(queried || [])
    previewList.innerHTML = prompts
      .map((prompt) => {
        const dup = queriedSet.has(prompt)
        const cls = dup ? "duplicate" : "new"
        const tag = dup ? "已查询" : "新"
        const short =
          prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt
        return `<li class="${cls}"><strong>[${tag}]</strong> ${escapeHtml(short)}</li>`
      })
      .join("")
  } catch {
    previewList.innerHTML = prompts
      .map(
        (p) =>
          `<li>${escapeHtml(p.length > 120 ? `${p.slice(0, 120)}…` : p)}</li>`,
      )
      .join("")
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function renderProgress(progress) {
  const total = progress.total || 0
  const done = (progress.completed || 0) + (progress.failed || 0)
  const pct = total ? Math.round((done / total) * 100) : 0

  progressFill.style.width = `${pct}%`

  if (progress.running) {
    progressText.textContent = `进行中 ${done}/${total}（成功 ${progress.completed || 0}，失败 ${progress.failed || 0}）`
    startBtn.disabled = true
    stopBtn.disabled = false
  } else if (progress.finishedAt) {
    progressText.textContent = `已完成：成功 ${progress.completed || 0}，失败 ${progress.failed || 0}`
    startBtn.disabled = false
    stopBtn.disabled = true
  } else {
    progressText.textContent = "空闲"
    startBtn.disabled = false
    stopBtn.disabled = true
  }

  if (progress.current?.length) {
    currentPromptsEl.textContent = `正在处理：${progress.current.join(" | ")}`
  } else {
    currentPromptsEl.textContent = ""
  }

  const logs = progress.logs || []
  if (!logs.length) {
    logList.innerHTML = '<li style="color:#64748b">暂无日志</li>'
    return
  }

  logList.innerHTML = logs
    .map((log) => {
      if (log.ok) {
        return `<li class="ok">[${formatTime(log.time)}] ✓ ${escapeHtml(log.prompt.slice(0, 80))} — 选中 ${log.selected ?? 0}，下载 ${log.downloaded ?? 0}${log.skipped ? `，跳过 ${log.skipped}` : ""}</li>`
      }
      return `<li class="fail">[${formatTime(log.time)}] ✗ ${escapeHtml(log.prompt.slice(0, 80))} — ${escapeHtml(log.error || "失败")}</li>`
    })
    .join("")
}

async function syncProgress() {
  try {
    const { progress } = await sendMessage({ type: "get-batch-progress" })
    renderProgress(progress || {})
  } catch {
    /* ignore */
  }
}

function saveDraft() {
  try {
    localStorage.setItem(PROMPTS_DRAFT_KEY, promptsInput.value)
  } catch {
    /* ignore */
  }
}

function loadDraft() {
  try {
    const draft = localStorage.getItem(PROMPTS_DRAFT_KEY)
    if (draft) promptsInput.value = draft
  } catch {
    /* ignore */
  }
}

startBtn.addEventListener("click", async () => {
  const prompts = parsePromptLines(promptsInput.value)
  if (!prompts.length) {
    alert("请先输入至少一条提示词")
    return
  }

  startBtn.disabled = true
  try {
    await ensureBackgroundReady()
    await sendMessage({
      type: "start-batch-job",
      prompts,
      skipQueried: skipQueriedEl.checked,
      autoDownload: autoDownloadEl.checked,
      skipDownloaded: skipDownloadedEl.checked,
      parallel: Number(parallelEl.value) || 3,
      maxCollect: Number(maxCollectEl.value) || 1000,
      downloadSubDir: subdirEl.value.trim(),
    })
    saveDraft()
    renderProgress({ running: true, total: prompts.length, completed: 0, failed: 0 })
    refreshHistoryCount()
    refreshPreview()
  } catch (error) {
    alert(error.message || String(error))
    startBtn.disabled = false
  }
})

stopBtn.addEventListener("click", async () => {
  try {
    await sendMessage({ type: "stop-batch-job" })
  } catch (error) {
    alert(error.message || String(error))
  }
})

clearHistoryBtn.addEventListener("click", async () => {
  if (
    !confirm(
      "确定清空全部提示词查询记录吗？清空后相同提示词会再次被批量任务执行。",
    )
  ) {
    return
  }
  try {
    await sendMessage({ type: "clear-prompt-history" })
    await refreshHistoryCount()
    await refreshPreview()
  } catch (error) {
    alert(error.message || String(error))
  }
})

openMjBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.midjourney.com/explore?tab=top" })
})

let previewTimer = null
promptsInput.addEventListener("input", () => {
  saveDraft()
  clearTimeout(previewTimer)
  previewTimer = setTimeout(refreshPreview, 300)
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.batchJobProgress) {
    renderProgress(changes.batchJobProgress.newValue || {})
    if (!changes.batchJobProgress.newValue?.running) {
      refreshHistoryCount()
      refreshPreview()
    }
  }
})

loadDraft()
ensureBackgroundReady()
  .then(() => {
    refreshHistoryCount()
    refreshPreview()
    syncProgress()
  })
  .catch(() => {
    historyCountEl.textContent = "?"
  })
setInterval(syncProgress, 2000)
