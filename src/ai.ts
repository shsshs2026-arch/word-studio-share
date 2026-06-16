import type { ReadingSentence, SelectionTranslation, SentenceAnalysis, VocabWord } from './types'

export type GenerateReadingResponse = {
  title: string
  story: string
  sentences: ReadingSentence[]
  coveredWords: string[]
  missingWords: string[]
  notes: string
}

export async function fetchAiStatus() {
  const response = await fetch('/api/status')
  if (!response.ok) throw new Error('AI status is unavailable.')
  return response.json()
}

export async function generateReading(words: VocabWord[], model: string): Promise<GenerateReadingResponse> {
  const response = await fetch('/api/ai/generate-reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      words: words.map((item) => ({
        word: item.word,
        meaning: item.meaning,
        partOfSpeech: item.partOfSpeech,
      })),
    }),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.message || '阅读生成失败。')
  }
  return data
}

export async function analyzeSentence(
  sentence: string,
  knownWords: VocabWord[],
  model: string,
): Promise<SentenceAnalysis> {
  const response = await fetch('/api/ai/analyze-sentence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sentence,
      model,
      knownWords: knownWords.slice(0, 120).map((item) => ({
        word: item.word,
        meaning: item.meaning,
      })),
    }),
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.message || '句子解析失败。')
  }
  return data
}

export async function translateSelection(text: string, model: string, signal?: AbortSignal): Promise<SelectionTranslation> {
  const response = await fetch('/api/ai/translate-selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model }),
    signal,
  })

  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.message || '选中文字翻译失败。')
  }
  return data
}
