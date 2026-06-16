import { aiRateLimitMessage, consumeAiRateLimit } from '../../shared/rateLimit.ts'
import { HttpError } from '../../shared/vocabService.ts'

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  })
}

export function methodNotAllowed(allowedMethod: string) {
  return jsonResponse(
    { message: `Method not allowed. Use ${allowedMethod}.` },
    405,
    { Allow: allowedMethod },
  )
}

export async function readJsonBody(request: Request) {
  const text = await request.text()
  if (!text.trim()) return {}

  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.')
  }
}

export function applyAiRateLimit(request: Request) {
  const result = consumeAiRateLimit(getClientIp(request))
  if (result.allowed) return null

  return jsonResponse(
    { message: aiRateLimitMessage },
    429,
    { 'Retry-After': String(result.retryAfterSeconds) },
  )
}

export async function handleApi(handler: () => Promise<Response> | Response) {
  try {
    return await handler()
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ message: error.message }, error.status)
    }

    return jsonResponse(
      { message: error instanceof Error ? error.message : 'Internal server error.' },
      500,
    )
  }
}

function getClientIp(request: Request) {
  const forwardedFor = request.headers.get('x-forwarded-for')
  if (forwardedFor) return forwardedFor.split(',')[0]?.trim() || 'unknown'

  return request.headers.get('x-real-ip') || 'unknown'
}
