import type { AppState, ImportCandidate, StudyRating, VocabWord, WordCollection } from './types'

const STORAGE_KEY = 'gaokao-vocab-helper-state-v1'
export const ALL_WORDS_COLLECTION_ID = 'all'

export const defaultState: AppState = {
  words: [],
  collections: [],
  activeCollectionId: ALL_WORDS_COLLECTION_ID,
  readings: [],
  settings: {
    dailyMinutes: 40,
    dailyNewWords: 30,
    readingBatchSize: 12,
    aiModel: 'deepseek-v4-pro',
  },
  streak: 0,
}

export function createId(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

export function normalizeWord(word: string) {
  return word.trim().toLowerCase().replace(/[’]/g, "'")
}

export function loadAppState(): AppState {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return defaultState

  try {
    const parsed = JSON.parse(raw) as AppState
    const settings = { ...defaultState.settings, ...parsed.settings }
    if (!settings.aiModel || settings.aiModel.startsWith('gpt-')) {
      settings.aiModel = defaultState.settings.aiModel
    }
    const words = Array.isArray(parsed.words) ? parsed.words : []
    const collections = normalizeCollections(parsed.collections, words)
    return {
      ...defaultState,
      ...parsed,
      settings,
      words: words.map(sanitizeLoadedWord),
      collections,
      activeCollectionId: getSafeCollectionId(parsed.activeCollectionId, collections),
      readings: Array.isArray(parsed.readings) ? parsed.readings : [],
    }
  } catch {
    return defaultState
  }
}

export function saveAppState(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function getActiveCollectionId(state: Pick<AppState, 'activeCollectionId' | 'collections'>) {
  return getSafeCollectionId(state.activeCollectionId, state.collections)
}

export function getCollectionWords(words: VocabWord[], collectionId: string, collections: WordCollection[]) {
  if (collectionId === ALL_WORDS_COLLECTION_ID) return words
  const collection = collections.find((item) => item.id === collectionId)
  if (!collection) return words

  const ids = new Set(collection.wordIds)
  return words.filter((word) => ids.has(word.id))
}

export function getCollectionName(collectionId: string, collections: WordCollection[]) {
  if (collectionId === ALL_WORDS_COLLECTION_ID) return '总词库'
  return collections.find((item) => item.id === collectionId)?.name || '总词库'
}

export function createWordCollection(name: string, wordIds: string[] = []): WordCollection {
  const now = new Date().toISOString()
  return {
    id: createId('collection'),
    name: name.trim() || '未命名词库',
    description: '',
    color: '#007aff',
    wordIds: Array.from(new Set(wordIds)),
    createdAt: now,
    updatedAt: now,
  }
}

export function addWordsToCollection(collections: WordCollection[], collectionId: string, wordIds: string[]) {
  if (collectionId === ALL_WORDS_COLLECTION_ID || wordIds.length === 0) return collections
  const now = new Date().toISOString()
  return collections.map((collection) =>
    collection.id === collectionId
      ? {
          ...collection,
          wordIds: Array.from(new Set([...collection.wordIds, ...wordIds])),
          updatedAt: now,
        }
      : collection,
  )
}

export function mergeImportCandidates(words: VocabWord[], candidates: ImportCandidate[]) {
  const now = new Date().toISOString()
  const byWord = new Map(words.map((item) => [normalizeWord(item.word), item]))
  const touchedWordIds: string[] = []
  let added = 0
  let updated = 0

  candidates
    .filter((item) => item.selected && item.word.trim())
    .forEach((candidate) => {
      const key = normalizeWord(candidate.word)
      const existing = byWord.get(key)
      if (existing) {
        existing.meaning = cleanImportedMeaning(existing.word, candidate.meaning || existing.meaning)
        existing.partOfSpeech = candidate.partOfSpeech || existing.partOfSpeech
        existing.updatedAt = now
        touchedWordIds.push(existing.id)
        updated += 1
        return
      }

      const nextWord: VocabWord = {
        id: createId('word'),
        word: candidate.word.trim(),
        meaning: cleanImportedMeaning(candidate.word.trim(), candidate.meaning.trim()),
        partOfSpeech: candidate.partOfSpeech,
        notes: candidate.warning,
        source: 'import',
        createdAt: now,
        updatedAt: now,
        proficiency: 0,
        correctCount: 0,
        fuzzyCount: 0,
        wrongCount: 0,
        nextReviewAt: now,
        readingCoveredCount: 0,
        pronunciations: candidate.phonetic
          ? {
              us: {
                accent: 'us',
                phonetic: candidate.phonetic,
                source: 'import',
                fetchedAt: now,
              },
            }
          : {},
      }
      byWord.set(key, nextWord)
      touchedWordIds.push(nextWord.id)
      added += 1
    })

  return {
    words: Array.from(byWord.values()).sort((a, b) => a.word.localeCompare(b.word)),
    added,
    updated,
    touchedWordIds: Array.from(new Set(touchedWordIds)),
  }
}

export function applyStudyRating(word: VocabWord, rating: StudyRating): VocabWord {
  const now = new Date()
  const next = new Date(now)
  let proficiency = word.proficiency
  let correctCount = word.correctCount
  let fuzzyCount = word.fuzzyCount
  let wrongCount = word.wrongCount

  if (rating === 'known') {
    proficiency = Math.min(100, proficiency + 18)
    correctCount += 1
    const reviewStepsInDays = [1, 2, 4, 7, 15, 30, 60]
    const step = Math.min(reviewStepsInDays.length - 1, correctCount)
    next.setDate(next.getDate() + reviewStepsInDays[step])
  }

  if (rating === 'fuzzy') {
    proficiency = Math.min(100, Math.max(8, proficiency + 5))
    fuzzyCount += 1
    next.setHours(next.getHours() + (fuzzyCount > 2 ? 3 : 8))
  }

  if (rating === 'unknown') {
    proficiency = Math.max(0, proficiency - 10)
    wrongCount += 1
    next.setMinutes(next.getMinutes() + (wrongCount > 2 ? 10 : 25))
  }

  return {
    ...word,
    proficiency,
    correctCount,
    fuzzyCount,
    wrongCount,
    lastStudiedAt: now.toISOString(),
    nextReviewAt: next.toISOString(),
    updatedAt: now.toISOString(),
  }
}

export function getDueWords(words: VocabWord[]) {
  const now = Date.now()
  return words
    .filter((word) => new Date(word.nextReviewAt).getTime() <= now)
    .sort((a, b) => {
      const aScore = a.wrongCount * 5 + a.fuzzyCount * 2 - a.proficiency
      const bScore = b.wrongCount * 5 + b.fuzzyCount * 2 - b.proficiency
      return bScore - aScore
    })
}

export function createReviewDeck(words: VocabWord[]) {
  return [...words]
    .map((word) => {
      const lastStudied = word.lastStudiedAt ? new Date(word.lastStudiedAt).getTime() : 0
      const ageHours = lastStudied ? (Date.now() - lastStudied) / 36e5 : 999
      const priority =
        (100 - word.proficiency) * 1.2 +
        word.wrongCount * 12 +
        word.fuzzyCount * 5 +
        Math.min(ageHours, 72) * 0.4 +
        Math.random() * 80
      return { word, priority }
    })
    .sort((a, b) => b.priority - a.priority)
    .map((item) => item.word)
}

export function cleanImportedMeaning(word: string, meaning: string) {
  const value = meaning.replace(/\s+/g, ' ').trim()
  if (value.length < 80) return value

  const englishTokens = value.match(/\b[A-Za-z][A-Za-z'.-]*\b/g) || []
  if (englishTokens.length < 4 || !/[\u4e00-\u9fa5]/.test(value)) return value

  const nextEntryPattern =
    /\s(?:[A-Za-z][A-Za-z'’-]*(?:-[A-Za-z][A-Za-z'’-]*)?|[A-Za-z](?:\.[A-Za-z])+\.?)(?:\s*\/\s*(?:[A-Za-z][A-Za-z'’-]*(?:-[A-Za-z][A-Za-z'’-]*)?|[A-Za-z](?:\.[A-Za-z])+\.?))*\s+(?=[\u4e00-\u9fa5])/g
  const match = nextEntryPattern.exec(value)
  if (!match || match.index < 2) return value

  const trimmed = value.slice(0, match.index).replace(/[、，,;；\s]+$/, '').trim()
  if (!trimmed || trimmed.length < 2 || trimmed.toLowerCase() === normalizeWord(word)) return value
  return trimmed
}

export function chooseReadingTargets(words: VocabWord[], count: number) {
  return [...words]
    .sort((a, b) => {
      const aScore = a.readingCoveredCount * 10 + a.proficiency - a.wrongCount * 3
      const bScore = b.readingCoveredCount * 10 + b.proficiency - b.wrongCount * 3
      return aScore - bScore
    })
    .slice(0, count)
}

export function exportStateFile(state: AppState) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `gaokao-vocab-backup-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function getSafeCollectionId(collectionId: string | undefined, collections: WordCollection[]) {
  if (!collectionId || collectionId === ALL_WORDS_COLLECTION_ID) return ALL_WORDS_COLLECTION_ID
  return collections.some((item) => item.id === collectionId) ? collectionId : ALL_WORDS_COLLECTION_ID
}

function normalizeCollections(collections: WordCollection[] | undefined, words: VocabWord[]) {
  if (!Array.isArray(collections)) return []

  const validWordIds = new Set(words.map((word) => word.id))
  const seenCollectionIds = new Set<string>()

  return collections
    .filter((collection) => collection?.id && collection.id !== ALL_WORDS_COLLECTION_ID && collection.name?.trim())
    .filter((collection) => {
      if (seenCollectionIds.has(collection.id)) return false
      seenCollectionIds.add(collection.id)
      return true
    })
    .map((collection) => ({
      ...collection,
      wordIds: Array.from(new Set((collection.wordIds || []).filter((id) => validWordIds.has(id)))),
      description: collection.description || '',
      updatedAt: collection.updatedAt || collection.createdAt || new Date().toISOString(),
      createdAt: collection.createdAt || new Date().toISOString(),
    }))
}

function sanitizeLoadedWord(word: VocabWord) {
  return {
    ...word,
    meaning: cleanImportedMeaning(word.word, word.meaning || ''),
  }
}
