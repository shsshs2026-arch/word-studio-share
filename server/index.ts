import cors from 'cors'
import 'dotenv/config'
import express from 'express'
import OpenAI from 'openai'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = express()
const port = Number(process.env.PORT ?? 8787)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const clientDistPath = path.resolve(__dirname, '../dist')
const aiProvider = 'DeepSeek'
const aiModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'
const aiBaseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const aiClient = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: aiBaseURL })
  : null
const aiRateLimitWindowMs = Number(process.env.AI_RATE_LIMIT_WINDOW_MS ?? 60 * 60 * 1000)
const aiRateLimitMax = Number(process.env.AI_RATE_LIMIT_MAX ?? 60)
const aiRateLimitBuckets = new Map<string, { count: number; resetAt: number }>()

app.set('trust proxy', 1)
app.use(cors({ origin: true }))
app.use(express.json({ limit: '4mb' }))

function aiRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const now = Date.now()
  const key = req.ip || req.socket.remoteAddress || 'unknown'
  const bucket = aiRateLimitBuckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    aiRateLimitBuckets.set(key, { count: 1, resetAt: now + aiRateLimitWindowMs })
    next()
    return
  }

  if (bucket.count >= aiRateLimitMax) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    res.setHeader('Retry-After', String(retryAfterSeconds))
    res.status(429).json({ message: '请求太频繁，稍后再试。' })
    return
  }

  bucket.count += 1
  next()
}

setInterval(() => {
  const now = Date.now()
  aiRateLimitBuckets.forEach((bucket, key) => {
    if (bucket.resetAt <= now) aiRateLimitBuckets.delete(key)
  })
}, Math.min(aiRateLimitWindowMs, 15 * 60 * 1000)).unref()

type TargetWord = {
  word: string
  meaning?: string
  partOfSpeech?: string
}

const readingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'story', 'sentences', 'coveredWords', 'missingWords', 'notes'],
  properties: {
    title: { type: 'string' },
    story: { type: 'string' },
    sentences: {
      type: 'array',
      minItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'usedWords', 'pairs'],
        properties: {
          text: { type: 'string' },
          usedWords: { type: 'array', items: { type: 'string' } },
          pairs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['english', 'chinese'],
              properties: {
                english: { type: 'string' },
                chinese: { type: 'string' },
              },
            },
          },
        },
      },
    },
    coveredWords: { type: 'array', items: { type: 'string' } },
    missingWords: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const analysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['translation', 'structure', 'keyWords', 'grammar', 'tip'],
  properties: {
    translation: { type: 'string' },
    structure: { type: 'array', items: { type: 'string' } },
    keyWords: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['word', 'meaning', 'role'],
        properties: {
          word: { type: 'string' },
          meaning: { type: 'string' },
          role: { type: 'string' },
        },
      },
    },
    grammar: { type: 'array', items: { type: 'string' } },
    tip: { type: 'string' },
  },
}

const selectionTranslationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['translation', 'explanation', 'detectedLanguage'],
  properties: {
    translation: { type: 'string' },
    explanation: { type: 'string' },
    detectedLanguage: { type: 'string' },
  },
}

const readingSystemPrompt = [
  'You are writing for a Chinese learner using a vocabulary learning website.',
  'Create smooth, textbook-style English mini lessons, similar in clarity to beginner textbook passages.',
  'The passage must read like one coherent little text, not a list of example sentences.',
  'Use a simple daily-life scene, very easy grammar, short sentences, and natural transitions.',
  'Use all target words at least once when possible. Do not force words into unnatural sentences.',
  'Avoid obscure non-target words. Prefer repeated simple patterns.',
  'For every sentence, return word-by-word English-Chinese pairs in visible order.',
  'All Chinese glosses, notes, and missing-word explanations must be in natural simplified Chinese.',
  'Return only valid JSON matching this schema:',
  JSON.stringify(readingSchema),
].join('\n')

const sentenceAnalysisPrompt = [
  'You are a patient English tutor for a Chinese vocabulary learner.',
  'Explain in concise, beginner-friendly simplified Chinese.',
  'Avoid stiff AI-style wording. Use practical classroom language.',
  'Focus only on what helps the learner understand this exact sentence.',
  'Return only valid JSON matching this schema:',
  JSON.stringify(analysisSchema),
].join('\n')

const selectionTranslationPrompt = [
  'You translate selected text for a Chinese vocabulary learner.',
  'If selected text is English, translate it into smooth, natural simplified Chinese.',
  'If selected text is Chinese, translate it into simple, natural English.',
  'The explanation field must always be written in simplified Chinese, even when translating Chinese into English.',
  'Do not write English explanations. Do not use stiff AI-style phrases.',
  'Explain only the useful point: meaning, tone, grammar, or a natural usage note.',
  'Keep the explanation short and practical, usually one or two Chinese sentences.',
  'Return only valid JSON matching this schema:',
  JSON.stringify(selectionTranslationSchema),
].join('\n')

app.get('/api/status', (_req, res) => {
  res.json({
    hasAi: Boolean(aiClient),
    provider: aiProvider,
    model: aiModel,
    baseUrl: aiBaseURL,
    pronunciationProviders: {
      merriamWebster: Boolean(process.env.MERRIAM_WEBSTER_API_KEY),
      wordnik: Boolean(process.env.WORDNIK_API_KEY),
      forvo: Boolean(process.env.FORVO_API_KEY),
    },
  })
})

app.post('/api/ai/generate-reading', aiRateLimit, async (req, res) => {
  if (!aiClient) {
    res.status(503).json({
      message: 'DEEPSEEK_API_KEY is not configured. 背词和导入可用，阅读生成需要先配置 DeepSeek API key。',
    })
    return
  }

  const words = Array.isArray(req.body.words) ? (req.body.words as TargetWord[]) : []
  const model = typeof req.body.model === 'string' ? req.body.model : aiModel

  if (words.length === 0) {
    res.status(400).json({ message: 'No target words were provided.' })
    return
  }

  try {
    const response = await aiClient.chat.completions.create({
      model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
      extra_body: { thinking: { type: 'enabled' } },
      messages: [
        {
          role: 'system',
          content: readingSystemPrompt,
        },
        {
          role: 'user',
          content: JSON.stringify({
            task:
              'Write one very easy English mini text with 8 to 12 short sentences. Make it fluent and readable as a small lesson text. Use every target word at least once exactly as a visible English word when possible. For every sentence, provide pairs for the visible English words in order, each with a short Chinese gloss. Keep all explanations and glosses in simplified Chinese.',
            targetWords: words.slice(0, 15),
          }),
        },
      ],
    } as any)

    res.json(parseJsonResponse(response.choices[0]?.message?.content))
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to generate reading.',
    })
  }
})

app.post('/api/ai/analyze-sentence', aiRateLimit, async (req, res) => {
  if (!aiClient) {
    res.status(503).json({
      message: 'DEEPSEEK_API_KEY is not configured. 句子深度解析需要先配置 DeepSeek API key。',
    })
    return
  }

  const sentence = typeof req.body.sentence === 'string' ? req.body.sentence : ''
  const model = typeof req.body.model === 'string' ? req.body.model : aiModel
  const knownWords = Array.isArray(req.body.knownWords) ? req.body.knownWords : []

  if (!sentence.trim()) {
    res.status(400).json({ message: 'No sentence was provided.' })
    return
  }

  try {
    const response = await aiClient.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
      extra_body: { thinking: { type: 'enabled' } },
      messages: [
        {
          role: 'system',
          content: sentenceAnalysisPrompt,
        },
        {
          role: 'user',
          content: JSON.stringify({
            sentence,
            knownWords,
            requirements: [
              'Give a natural Chinese translation.',
              'Explain the sentence structure in simple Chinese.',
              'Explain important vocabulary from the sentence.',
              'Point out only useful grammar for understanding this sentence.',
              'Keep it short and practical.',
            ],
          }),
        },
      ],
    } as any)

    res.json(parseJsonResponse(response.choices[0]?.message?.content))
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to analyze sentence.',
    })
  }
})

app.post('/api/ai/translate-selection', aiRateLimit, async (req, res) => {
  if (!aiClient) {
    res.status(503).json({
      message: 'DEEPSEEK_API_KEY is not configured. 选中文字翻译需要先配置 DeepSeek API key。',
    })
    return
  }

  const text = typeof req.body.text === 'string' ? req.body.text.trim() : ''
  const model = typeof req.body.model === 'string' ? req.body.model : aiModel

  if (!text) {
    res.status(400).json({ message: 'No selected text was provided.' })
    return
  }

  try {
    const response = await aiClient.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
      extra_body: { thinking: { type: 'enabled' } },
      messages: [
        {
          role: 'system',
          content: selectionTranslationPrompt,
        },
        {
          role: 'user',
          content: JSON.stringify({ selectedText: text.slice(0, 1200) }),
        },
      ],
    } as any)

    const translated = parseJsonResponse(response.choices[0]?.message?.content)
    res.json(ensureChineseSelectionExplanation(translated, text))
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to translate selected text.',
    })
  }
})

function parseJsonResponse(content?: string | null) {
  if (!content) {
    throw new Error('AI returned an empty response.')
  }

  try {
    return JSON.parse(content)
  } catch {
    const match = content.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error('AI did not return valid JSON.')
  }
}

function ensureChineseSelectionExplanation(result: any, selectedText: string) {
  if (typeof result?.explanation === 'string' && /[\u4e00-\u9fa5]/.test(result.explanation)) {
    return result
  }

  const isChinese = /[\u4e00-\u9fa5]/.test(selectedText)
  return {
    ...result,
    explanation: isChinese
      ? '上面是更自然的英文表达；重点看整体意思，不要逐字硬套。'
      : '上面是更自然的中文译法；重点看这段话在上下文里的意思。少量固定搭配可以整块记。',
  }
}

app.get('/api/pronunciation/:word', async (req, res) => {
  const word = req.params.word.trim().toLowerCase()
  const result = {
    us: null as null | Record<string, string>,
    uk: null as null | Record<string, string>,
    sources: [] as string[],
  }

  await lookupMerriamWebster(word, result)
  await lookupWordnik(word, result)
  await lookupForvo(word, result)

  res.json(result)
})

async function lookupMerriamWebster(word: string, result: { us: null | Record<string, string>; sources: string[] }) {
  const key = process.env.MERRIAM_WEBSTER_API_KEY
  if (!key || result.us?.audioUrl) return

  try {
    const response = await fetch(
      `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(word)}?key=${key}`,
    )
    const data = await response.json()
    const entries = Array.isArray(data) ? data : []
    const sound = entries.find((entry) => entry?.hwi?.prs?.[0]?.sound?.audio)?.hwi?.prs?.[0]
    const audio = sound?.sound?.audio
    if (!audio) return

    const subdir = audio.startsWith('bix')
      ? 'bix'
      : audio.startsWith('gg')
        ? 'gg'
        : /^[^a-z]/i.test(audio)
          ? 'number'
          : audio[0]

    result.us = {
      audioUrl: `https://media.merriam-webster.com/audio/prons/en/us/mp3/${subdir}/${audio}.mp3`,
      phonetic: sound.mw || '',
      source: 'Merriam-Webster',
    }
    result.sources.push('Merriam-Webster')
  } catch {
    // Optional provider failures should not block other pronunciation sources.
  }
}

async function lookupWordnik(word: string, result: { us: null | Record<string, string>; sources: string[] }) {
  const key = process.env.WORDNIK_API_KEY
  if (!key || result.us?.audioUrl) return

  try {
    const response = await fetch(
      `https://api.wordnik.com/v4/word.json/${encodeURIComponent(
        word,
      )}/audio?useCanonical=true&limit=5&api_key=${key}`,
    )
    const data = await response.json()
    const audio = Array.isArray(data) ? data.find((item) => item.fileUrl)?.fileUrl : ''
    if (!audio) return

    result.us = {
      audioUrl: audio,
      source: 'Wordnik',
    }
    result.sources.push('Wordnik')
  } catch {
    // Optional provider failures should not block other pronunciation sources.
  }
}

async function lookupForvo(
  word: string,
  result: { us: null | Record<string, string>; uk: null | Record<string, string>; sources: string[] },
) {
  const key = process.env.FORVO_API_KEY
  if (!key) return

  try {
    const response = await fetch(
      `https://apifree.forvo.com/key/${key}/format/json/action/word-pronunciations/word/${encodeURIComponent(
        word,
      )}/language/en/order/rate-desc/limit/8`,
    )
    const data = (await response.json()) as {
      items?: Array<{
        country?: string
        pathmp3?: string
      }>
    }
    const items = Array.isArray(data.items) ? data.items : []
    const us = items.find((item) => String(item.country || '').toLowerCase().includes('united states'))
    const uk = items.find((item) => String(item.country || '').toLowerCase().includes('united kingdom'))
    const fallback = items.find((item) => item.pathmp3)

    const usAudio = us?.pathmp3 ?? fallback?.pathmp3
    if (!result.us?.audioUrl && usAudio) {
      result.us = { audioUrl: usAudio, source: 'Forvo' }
    }
    if (!result.uk?.audioUrl && uk?.pathmp3) {
      result.uk = { audioUrl: uk.pathmp3, source: 'Forvo' }
    }
    if (us?.pathmp3 || uk?.pathmp3 || fallback?.pathmp3) {
      result.sources.push('Forvo')
    }
  } catch {
    // Optional provider failures should not block other pronunciation sources.
  }
}

app.use(express.static(clientDistPath))
app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'))
})

app.listen(port, () => {
  console.log(`Vocab helper server running on http://localhost:${port}`)
})
