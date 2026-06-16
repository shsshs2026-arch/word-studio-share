export const aiRateLimitWindowMs = Number(process.env.AI_RATE_LIMIT_WINDOW_MS ?? 60 * 60 * 1000)
export const aiRateLimitMax = Number(process.env.AI_RATE_LIMIT_MAX ?? 60)
export const aiRateLimitMessage = '请求太频繁，稍后再试。'

const aiRateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

export function consumeAiRateLimit(keyInput: string | undefined) {
  const now = Date.now()
  const key = keyInput || 'unknown'
  const bucket = aiRateLimitBuckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    aiRateLimitBuckets.set(key, { count: 1, resetAt: now + aiRateLimitWindowMs })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  if (bucket.count >= aiRateLimitMax) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }

  bucket.count += 1
  return { allowed: true, retryAfterSeconds: 0 }
}

setInterval(() => {
  const now = Date.now()
  aiRateLimitBuckets.forEach((bucket, key) => {
    if (bucket.resetAt <= now) aiRateLimitBuckets.delete(key)
  })
}, Math.min(aiRateLimitWindowMs, 15 * 60 * 1000)).unref()
