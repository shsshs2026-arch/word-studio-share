import { applyAiRateLimit, handleApi, jsonResponse, methodNotAllowed, readJsonBody } from '../_lib/http.ts'
import { generateReading } from '../../shared/vocabService.ts'

export default {
  async fetch(request: Request) {
    if (request.method !== 'POST') return methodNotAllowed('POST')

    const limited = applyAiRateLimit(request)
    if (limited) return limited

    return handleApi(async () => jsonResponse(await generateReading(await readJsonBody(request))))
  },
}
