import { handleApi, jsonResponse, methodNotAllowed } from '../_lib/http.ts'
import { getPronunciation } from '../../shared/vocabService.ts'

export default {
  async fetch(request: Request) {
    if (request.method !== 'GET') return methodNotAllowed('GET')

    const pathname = new URL(request.url).pathname
    const word = decodeURIComponent(pathname.split('/').pop() || '')
    return handleApi(async () => jsonResponse(await getPronunciation(word)))
  },
}
