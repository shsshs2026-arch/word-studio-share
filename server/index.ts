import cors from 'cors'
import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiRateLimitMessage, consumeAiRateLimit } from '../shared/rateLimit.ts'
import {
  analyzeSentence,
  generateReading,
  getAiStatus,
  getPronunciation,
  HttpError,
  translateSelection,
} from '../shared/vocabService.ts'

const app = express()
const port = Number(process.env.PORT ?? 8787)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const clientDistPath = path.resolve(__dirname, '../dist')

app.set('trust proxy', 1)
app.use(cors({ origin: true }))
app.use(express.json({ limit: '4mb' }))

function aiRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const result = consumeAiRateLimit(req.ip || req.socket.remoteAddress)
  if (result.allowed) {
    next()
    return
  }

  res.setHeader('Retry-After', String(result.retryAfterSeconds))
  res.status(429).json({ message: aiRateLimitMessage })
}

async function sendJson(res: express.Response, action: () => Promise<unknown> | unknown) {
  try {
    res.json(await action())
  } catch (error) {
    sendError(res, error)
  }
}

function sendError(res: express.Response, error: unknown) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ message: error.message })
    return
  }

  res.status(500).json({
    message: error instanceof Error ? error.message : 'Internal server error.',
  })
}

app.get('/api/status', (_req, res) => {
  res.json(getAiStatus())
})

app.post('/api/ai/generate-reading', aiRateLimit, async (req, res) => {
  await sendJson(res, () => generateReading(req.body))
})

app.post('/api/ai/analyze-sentence', aiRateLimit, async (req, res) => {
  await sendJson(res, () => analyzeSentence(req.body))
})

app.post('/api/ai/translate-selection', aiRateLimit, async (req, res) => {
  await sendJson(res, () => translateSelection(req.body))
})

app.get('/api/pronunciation/:word', async (req, res) => {
  await sendJson(res, () => getPronunciation(req.params.word))
})

app.use(express.static(clientDistPath))
app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'))
})

app.listen(port, () => {
  console.log(`Vocab helper server running on http://localhost:${port}`)
})
