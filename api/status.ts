import { jsonResponse } from './_lib/http.ts'
import { getAiStatus } from '../shared/vocabService.ts'

export default {
  fetch() {
    return jsonResponse(getAiStatus())
  },
}
