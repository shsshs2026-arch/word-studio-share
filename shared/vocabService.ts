import OpenAI from 'openai'

export type TargetWord = {
  word: string
  meaning?: string
  partOfSpeech?: string
}

export class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

type DeepSeekCompletionRequest = {
  model: string
  temperature: number
  response_format: { type: 'json_object' }
  reasoning_effort: 'high'
  extra_body: { thinking: { type: 'enabled' } }
  messages: Array<{ role: 'system' | 'user'; content: string }>
}

type DeepSeekCompletionResponse = {
  choices: Array<{
    message?: {
      content?: string | null
    }
  }>
}

const aiProvider = 'DeepSeek'
const aiModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'
const aiBaseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'

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

function getAiClient() {
  if (!process.env.DEEPSEEK_API_KEY) return null
  return new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: aiBaseURL })
}

export function getAiStatus() {
  return {
    hasAi: Boolean(process.env.DEEPSEEK_API_KEY),
    provider: aiProvider,
    model: aiModel,
    baseUrl: aiBaseURL,
    pronunciationProviders: {
      merriamWebster: Boolean(process.env.MERRIAM_WEBSTER_API_KEY),
      wordnik: Boolean(process.env.WORDNIK_API_KEY),
      forvo: Boolean(process.env.FORVO_API_KEY),
    },
  }
}

export async function generateReading(payload: { words?: TargetWord[]; model?: string }) {
  const aiClient = getAiClient()
  if (!aiClient) {
    throw new HttpError(503, 'DEEPSEEK_API_KEY is not configured. 背词和导入可用，阅读生成需要先配置 DeepSeek API key。')
  }

  const words = Array.isArray(payload.words) ? payload.words : []
  const model = typeof payload.model === 'string' ? payload.model : aiModel

  if (words.length === 0) {
    throw new HttpError(400, 'No target words were provided.')
  }

  const response = await createJsonCompletion(aiClient, {
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
  })

  return parseJsonResponse(response.choices[0]?.message?.content)
}

export async function analyzeSentence(payload: { sentence?: string; model?: string; knownWords?: unknown[] }) {
  const aiClient = getAiClient()
  if (!aiClient) {
    throw new HttpError(503, 'DEEPSEEK_API_KEY is not configured. 句子深度解析需要先配置 DeepSeek API key。')
  }

  const sentence = typeof payload.sentence === 'string' ? payload.sentence : ''
  const model = typeof payload.model === 'string' ? payload.model : aiModel
  const knownWords = Array.isArray(payload.knownWords) ? payload.knownWords : []

  if (!sentence.trim()) {
    throw new HttpError(400, 'No sentence was provided.')
  }

  const response = await createJsonCompletion(aiClient, {
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
  })

  return parseJsonResponse(response.choices[0]?.message?.content)
}

export async function translateSelection(payload: { text?: string; model?: string }) {
  const aiClient = getAiClient()
  if (!aiClient) {
    throw new HttpError(503, 'DEEPSEEK_API_KEY is not configured. 选中文字翻译需要先配置 DeepSeek API key。')
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const model = typeof payload.model === 'string' ? payload.model : aiModel

  if (!text) {
    throw new HttpError(400, 'No selected text was provided.')
  }

  const response = await createJsonCompletion(aiClient, {
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
  })

  const translated = parseJsonResponse(response.choices[0]?.message?.content)
  return ensureChineseSelectionExplanation(translated, text)
}

export async function getPronunciation(wordInput: string) {
  const word = wordInput.trim().toLowerCase()
  const result = {
    us: null as null | Record<string, string>,
    uk: null as null | Record<string, string>,
    sources: [] as string[],
  }

  await lookupMerriamWebster(word, result)
  await lookupWordnik(word, result)
  await lookupForvo(word, result)

  return result
}

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

async function createJsonCompletion(aiClient: OpenAI, request: DeepSeekCompletionRequest) {
  const create = aiClient.chat.completions.create as unknown as (
    body: DeepSeekCompletionRequest,
  ) => Promise<DeepSeekCompletionResponse>

  return create.call(aiClient.chat.completions, request)
}

function ensureChineseSelectionExplanation(result: unknown, selectedText: string) {
  const payload = isRecord(result) ? result : {}
  const explanation = payload.explanation

  if (typeof explanation === 'string' && /[\u4e00-\u9fa5]/.test(explanation)) {
    return payload
  }

  const isChinese = /[\u4e00-\u9fa5]/.test(selectedText)
  return {
    ...payload,
    explanation: isChinese
      ? '上面是更自然的英文表达；重点看整体意思，不要逐字硬套。'
      : '上面是更自然的中文译法；重点看这段话在上下文里的意思。少量固定搭配可以整块记。',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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
