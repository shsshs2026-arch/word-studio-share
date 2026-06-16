import type { Accent, Pronunciation } from './types'

type PronunciationResult = Partial<Record<Accent, Pronunciation>>

type FreeDictionaryPhonetic = {
  text?: string
  audio?: string
  sourceUrl?: string
}

type WiktionaryEntry = {
  pronunciations?: Array<{
    text?: string
    tags?: string[]
  }>
}

export async function lookupPronunciations(word: string): Promise<PronunciationResult> {
  const now = new Date().toISOString()
  const result: PronunciationResult = {}

  await Promise.allSettled([lookupFreeDictionary(word, result, now), lookupWiktionaryData(word, result, now)])

  try {
    const response = await fetch(`/api/pronunciation/${encodeURIComponent(word)}`)
    if (response.ok) {
      const data = await response.json()
      if (data.us?.audioUrl && !result.us?.audioUrl) {
        result.us = {
          accent: 'us',
          audioUrl: data.us.audioUrl,
          phonetic: data.us.phonetic || result.us?.phonetic,
          source: data.us.source || 'optional provider',
          fetchedAt: now,
        }
      }
      if (data.uk?.audioUrl && !result.uk?.audioUrl) {
        result.uk = {
          accent: 'uk',
          audioUrl: data.uk.audioUrl,
          phonetic: data.uk.phonetic || result.uk?.phonetic,
          source: data.uk.source || 'optional provider',
          fetchedAt: now,
        }
      }
    }
  } catch {
    // Local backend may be unavailable during static preview; speech synthesis still works.
  }

  return result
}

export function speakWord(word: string, accent: Accent) {
  const synth = window.speechSynthesis
  if (!synth) return

  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(word)
  utterance.lang = accent === 'uk' ? 'en-GB' : 'en-US'
  utterance.rate = 0.82
  const voices = synth.getVoices()
  const preferredVoice = voices.find((voice) => voice.lang === utterance.lang) || voices.find((voice) => voice.lang.startsWith('en'))
  if (preferredVoice) utterance.voice = preferredVoice
  synth.speak(utterance)
}

async function lookupFreeDictionary(word: string, result: PronunciationResult, fetchedAt: string) {
  const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)
  if (!response.ok) return
  const data = await response.json()
  const entry = Array.isArray(data) ? data[0] : null
  const phonetics = Array.isArray(entry?.phonetics) ? entry.phonetics : []

  ;(phonetics as FreeDictionaryPhonetic[]).forEach((phonetic) => {
    const audio = normalizeAudioUrl(phonetic.audio)
    const text = typeof phonetic.text === 'string' ? phonetic.text : undefined
    const sourceUrl = String(phonetic.sourceUrl || phonetic.audio || '').toLowerCase()
    const accent: Accent = sourceUrl.includes('_gb_') || sourceUrl.includes('uk') ? 'uk' : 'us'

    if (!result[accent]?.audioUrl && (audio || text)) {
      result[accent] = {
        accent,
        audioUrl: audio,
        phonetic: text || result[accent]?.phonetic,
        source: 'Free Dictionary API',
        fetchedAt,
      }
    }
  })
}

async function lookupWiktionaryData(word: string, result: PronunciationResult, fetchedAt: string) {
  const response = await fetch(`https://freedictionaryapi.com/api/v1/entries/en/${encodeURIComponent(word)}`)
  if (!response.ok) return
  const data = await response.json()
  const entries = Array.isArray(data?.entries) ? (data.entries as WiktionaryEntry[]) : []
  const pronunciations = entries.flatMap((entry) => (Array.isArray(entry.pronunciations) ? entry.pronunciations : []))

  pronunciations.forEach((item) => {
    const text = typeof item.text === 'string' ? item.text : ''
    const tags = Array.isArray(item.tags) ? item.tags.join(' ').toLowerCase() : ''
    const accent: Accent = tags.includes('uk') || tags.includes('britain') || tags.includes('received') ? 'uk' : 'us'

    if (text && !result[accent]?.phonetic) {
      result[accent] = {
        accent,
        ...result[accent],
        phonetic: text,
        source: result[accent]?.source || 'Wiktionary',
        fetchedAt,
      }
    }
  })
}

function normalizeAudioUrl(url?: string) {
  if (!url) return undefined
  if (url.startsWith('//')) return `https:${url}`
  return url
}
