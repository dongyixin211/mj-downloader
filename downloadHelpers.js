/** 下载 URL / 文件名工具（background 与 content script 共用） */
const MJ_CDN_PATTERN = /cdn\.midjourney\.com/i

const DOWNLOAD_NAMING_MODE_KEY = "bdduckDownloadNamingMode"
const DOWNLOAD_CONFLICT_ACTION_KEY = "bdduckDownloadConflictAction"
const DOWNLOAD_SEQ_DATE_KEY = "bdduckDownloadSeqDate"
const DOWNLOAD_SEQ_COUNTER_KEY = "bdduckDownloadSeqCounter"
const DOWNLOAD_NAMING_SEQUENTIAL = "sequential"
const DOWNLOAD_NAMING_DEFAULT = "default"
const DOWNLOAD_CONFLICT_PROMPT = "prompt"
const DOWNLOAD_CONFLICT_UNIQUIFY = "uniquify"
const DOWNLOAD_CONFLICT_OVERWRITE = "overwrite"
const SEQUENTIAL_INDEX_PAD = 6

function formatDateYmd(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}${m}${d}`
}

function inferDownloadExtension(url, fallback = ".webp") {
  const text = String(url || "")
  const match = text.match(/\.(webp|png|jpe?g|gif)(\?|#|$)/i)
  if (match) return `.${match[1].toLowerCase()}`
  return fallback.startsWith(".") ? fallback : `.${fallback}`
}

function normalizeImageUrl(url) {
  if (!url) return ""
  let normalized = url.trim().replace(/&amp;/g, "&")
  normalized = normalized.split("?")[0].split("#")[0]
  if (MJ_CDN_PATTERN.test(normalized)) {
    normalized = normalized.replace(/\.(png|jpe?g|gif)$/i, ".webp")
  }
  return normalized
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

function sanitizeFilenamePart(part) {
  return String(part)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 100)
}

function sanitizePromptFolder(prompt) {
  return sanitizeFilenamePart(String(prompt || "").slice(0, 48))
}

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

function buildDownloadPath(downloadSubDir, promptFolder, filename) {
  const parts = []
  if (downloadSubDir) parts.push(downloadSubDir.replace(/^\/+|\/+$/g, ""))
  if (promptFolder) parts.push(promptFolder)
  if (filename) parts.push(filename)
  return parts.filter(Boolean).join("/")
}

function buildSequentialBasename(counter, dateYmd, ext) {
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`
  return `${dateYmd}_${String(counter).padStart(SEQUENTIAL_INDEX_PAD, "0")}${safeExt}`
}

/** 顺序命名时 content 侧占位路径（实际序号在 background 分配） */
function buildSequentialPlaceholderPath(downloadSubDir, ext = ".webp") {
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`
  const placeholder = `_bdduck_seq_${safeExt}`
  if (downloadSubDir) {
    return `${downloadSubDir.replace(/^\/+|\/+$/g, "")}/${placeholder}`
  }
  return placeholder
}
