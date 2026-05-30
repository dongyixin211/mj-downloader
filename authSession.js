const DAILY_LOGIN_MS = 24 * 60 * 60 * 1000

function isSubscriptionExpired(expiresAt) {
  if (!expiresAt) {
    return false
  }
  const expiryDate = new Date(expiresAt)
  return !Number.isNaN(expiryDate.getTime()) && expiryDate.getTime() <= Date.now()
}

function isDailyLoginRequired(lastLoginAt) {
  if (!lastLoginAt) {
    return true
  }
  const loginDate = new Date(lastLoginAt)
  if (Number.isNaN(loginDate.getTime())) {
    return true
  }
  return Date.now() - loginDate.getTime() >= DAILY_LOGIN_MS
}

function shouldForceReLogin(expiresAt, lastLoginAt) {
  return isSubscriptionExpired(expiresAt) || isDailyLoginRequired(lastLoginAt)
}

function getDailyLoginRemainingMs(lastLoginAt) {
  if (!lastLoginAt) {
    return 0
  }
  const loginDate = new Date(lastLoginAt)
  if (Number.isNaN(loginDate.getTime())) {
    return 0
  }
  return Math.max(0, DAILY_LOGIN_MS - (Date.now() - loginDate.getTime()))
}
