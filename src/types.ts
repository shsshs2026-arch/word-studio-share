export type Accent = 'us' | 'uk'

export type StudyRating = 'known' | 'fuzzy' | 'unknown'

export type Pronunciation = {
  accent: Accent
  phonetic?: string
  audioUrl?: string
  source: string
  fetchedAt: string
}

export type VocabWord = {
  id: string
  word: string
  meaning: string
  partOfSpeech?: string
  notes?: string
  source: string
  createdAt: string
  updatedAt: string
  proficiency: number
  correctCount: number
  fuzzyCount: number
  wrongCount: number
  nextReviewAt: string
  lastStudiedAt?: string
  readingCoveredCount: number
  pronunciations: Partial<Record<Accent, Pronunciation>>
}

export type WordCollection = {
  id: string
  name: string
  description?: string
  color?: string
  wordIds: string[]
  createdAt: string
  updatedAt: string
}

export type ImportCandidate = {
  id: string
  word: string
  meaning: string
  partOfSpeech?: string
  phonetic?: string
  confidence: number
  raw: string
  selected: boolean
  warning?: string
}

export type ReadingSentence = {
  text: string
  usedWords: string[]
  pairs?: Array<{
    english: string
    chinese: string
  }>
}

export type ReadingPassage = {
  id: string
  title: string
  story: string
  sentences: ReadingSentence[]
  collectionId?: string
  targetWordIds: string[]
  coveredWords: string[]
  missingWords: string[]
  notes: string
  createdAt: string
}

export type SentenceAnalysis = {
  translation: string
  structure: string[]
  keyWords: Array<{
    word: string
    meaning: string
    role: string
  }>
  grammar: string[]
  tip: string
}

export type SelectionTranslation = {
  translation: string
  explanation: string
  detectedLanguage: string
}

export type AppSettings = {
  dailyMinutes: number
  dailyNewWords: number
  readingBatchSize: number
  aiModel: string
}

export type AppState = {
  words: VocabWord[]
  collections: WordCollection[]
  activeCollectionId?: string
  readings: ReadingPassage[]
  settings: AppSettings
  lastStudiedDate?: string
  streak: number
}

export type AiStatus = {
  hasAi: boolean
  provider: string
  model: string
  baseUrl: string
  pronunciationProviders: {
    merriamWebster: boolean
    wordnik: boolean
    forvo: boolean
  }
}
