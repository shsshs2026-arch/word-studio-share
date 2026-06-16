import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertCircle,
  BarChart3,
  BookOpen,
  Brain,
  Check,
  FileText,
  Headphones,
  Library,
  Loader2,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Upload,
  Volume2,
  Wand2,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import './App.css'
import { analyzeSentence, fetchAiStatus, generateReading, translateSelection } from './ai'
import { extractTextFromFile, parseVocabularyText, type ImportProgress } from './importers'
import { lookupPronunciations, speakWord } from './pronunciation'
import {
  addWordsToCollection,
  ALL_WORDS_COLLECTION_ID,
  applyStudyRating,
  chooseReadingTargets,
  cleanImportedMeaning,
  createId,
  createReviewDeck,
  createWordCollection,
  defaultState,
  exportStateFile,
  getActiveCollectionId,
  getCollectionName,
  getCollectionWords,
  getDueWords,
  loadAppState,
  mergeImportCandidates,
  normalizeWord,
  saveAppState,
} from './storage'
import type {
  Accent,
  AiStatus,
  AppState,
  ImportCandidate,
  ReadingPassage,
  SelectionTranslation,
  SentenceAnalysis,
  StudyRating,
  VocabWord,
  WordCollection,
} from './types'

type TabId = 'today' | 'library' | 'reading' | 'mistakes' | 'import' | 'settings'

type SelectionToolState = {
  text: string
  x: number
  y: number
  loading: boolean
  result?: SelectionTranslation
  error?: string
}

type InspectorState =
  | {
      kind: 'sentence'
      title: string
      text: string
      loading: boolean
      result?: SentenceAnalysis
      error?: string
    }
  | {
      kind: 'selection'
      title: string
      text: string
      loading: boolean
      result?: SelectionTranslation
      error?: string
    }

const tabs: Array<{ id: TabId; label: string; icon: typeof Brain }> = [
  { id: 'today', label: '今日学习', icon: Brain },
  { id: 'library', label: '词库', icon: Library },
  { id: 'reading', label: '阅读', icon: BookOpen },
  { id: 'mistakes', label: '错词', icon: AlertCircle },
  { id: 'import', label: '导入', icon: Upload },
  { id: 'settings', label: '设置', icon: Settings },
]

const sampleWords: ImportCandidate[] = [
  { id: 's1', word: 'achieve', meaning: '实现；达到', confidence: 100, raw: 'achieve 实现；达到', selected: true },
  { id: 's2', word: 'effort', meaning: '努力', confidence: 100, raw: 'effort 努力', selected: true },
  { id: 's3', word: 'habit', meaning: '习惯', confidence: 100, raw: 'habit 习惯', selected: true },
  { id: 's4', word: 'improve', meaning: '提高；改善', confidence: 100, raw: 'improve 提高；改善', selected: true },
  { id: 's5', word: 'simple', meaning: '简单的', confidence: 100, raw: 'simple 简单的', selected: true },
]

function App() {
  const [state, setState] = useState<AppState>(() => loadAppState())
  const [activeTab, setActiveTab] = useState<TabId>('today')
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [toast, setToast] = useState('')
  const [pronunciationLoading, setPronunciationLoading] = useState<string | null>(null)
  const [selectionTool, setSelectionTool] = useState<SelectionToolState | null>(null)
  const [inspector, setInspector] = useState<InspectorState | null>(null)
  const selectionAbortRef = useRef<AbortController | null>(null)
  const selectionRunRef = useRef(0)

  useEffect(() => saveAppState(state), [state])

  useEffect(() => {
    fetchAiStatus()
      .then(setAiStatus)
      .catch(() => setAiStatus(null))
  }, [])

  function cancelSelectionContext() {
    selectionRunRef.current += 1
    selectionAbortRef.current?.abort()
    selectionAbortRef.current = null
    setSelectionTool(null)
    setInspector((current) => (current?.kind === 'selection' ? null : current))
    window.speechSynthesis?.cancel()
  }

  useEffect(() => {
    let selectionTimer = 0

    function captureSelection(event?: MouseEvent | KeyboardEvent) {
      const target = event?.target
      if (target instanceof Element && target.closest('.selection-popover')) return
      if (!event && document.activeElement instanceof Element && document.activeElement.closest('.selection-popover')) return

      const selection = window.getSelection()
      const text = selection?.toString().trim()
      if (!selection || !text || text.length < 2) {
        cancelSelectionContext()
        return
      }

      const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      const rect = range?.getBoundingClientRect()
      const x = rect ? Math.min(Math.max(rect.left + rect.width / 2, 180), window.innerWidth - 180) : window.innerWidth / 2
      const y = rect ? Math.min(rect.bottom + 12, window.innerHeight - 220) : 120

      setSelectionTool({
        text: text.slice(0, 1200),
        x,
        y: Math.max(80, y),
        loading: false,
      })
    }

    function scheduleSelectionCapture() {
      window.clearTimeout(selectionTimer)
      selectionTimer = window.setTimeout(captureSelection, 120)
    }

    document.addEventListener('mouseup', captureSelection)
    document.addEventListener('keyup', captureSelection)
    document.addEventListener('selectionchange', scheduleSelectionCapture)
    return () => {
      window.clearTimeout(selectionTimer)
      selectionAbortRef.current?.abort()
      document.removeEventListener('mouseup', captureSelection)
      document.removeEventListener('keyup', captureSelection)
      document.removeEventListener('selectionchange', scheduleSelectionCapture)
    }
  }, [])

  const activeCollectionId = useMemo(() => getActiveCollectionId(state), [state])
  const activeCollectionName = useMemo(() => getCollectionName(activeCollectionId, state.collections), [activeCollectionId, state.collections])
  const activeWords = useMemo(
    () => getCollectionWords(state.words, activeCollectionId, state.collections),
    [activeCollectionId, state.collections, state.words],
  )
  const dueWords = useMemo(() => getDueWords(activeWords), [activeWords])
  const weakWords = useMemo(
    () => activeWords.filter((word) => word.wrongCount > 0 || word.fuzzyCount > 0).sort((a, b) => b.wrongCount - a.wrongCount),
    [activeWords],
  )

  const stats = useMemo(() => {
    const mastered = activeWords.filter((word) => word.proficiency >= 80).length
    const covered = activeWords.filter((word) => word.readingCoveredCount > 0).length
    return {
      total: activeWords.length,
      allTotal: state.words.length,
      due: dueWords.length,
      weak: weakWords.length,
      mastered,
      covered,
      coverage: activeWords.length ? Math.round((covered / activeWords.length) * 100) : 0,
    }
  }, [activeWords, dueWords.length, state.words.length, weakWords.length])

  function updateWords(updater: (words: VocabWord[]) => VocabWord[]) {
    setState((current) => ({ ...current, words: updater(current.words) }))
  }

  function selectCollection(collectionId: string) {
    setState((current) => ({
      ...current,
      activeCollectionId:
        collectionId === ALL_WORDS_COLLECTION_ID || current.collections.some((collection) => collection.id === collectionId)
          ? collectionId
          : ALL_WORDS_COLLECTION_ID,
    }))
  }

  function createCollection(name: string, wordIds: string[] = []) {
    const collection = createWordCollection(name, wordIds)
    setState((current) => ({
      ...current,
      collections: [...current.collections, collection],
      activeCollectionId: collection.id,
    }))
    setToast(`已新建词库：${collection.name}`)
    return collection.id
  }

  function importCandidates(candidates: ImportCandidate[], targetCollectionId = activeCollectionId) {
    setState((current) => {
      const merged = mergeImportCandidates(current.words, candidates)
      const safeTarget =
        targetCollectionId === ALL_WORDS_COLLECTION_ID || current.collections.some((collection) => collection.id === targetCollectionId)
          ? targetCollectionId
          : ALL_WORDS_COLLECTION_ID
      setToast(`导入完成：新增 ${merged.added} 个，更新 ${merged.updated} 个。`)
      return {
        ...current,
        words: merged.words,
        collections: addWordsToCollection(current.collections, safeTarget, merged.touchedWordIds),
        activeCollectionId: safeTarget,
      }
    })
    setActiveTab('today')
  }

  function resetProgress() {
    setState((current) => ({
      ...current,
      words: current.words.map((word) => ({
        ...word,
        proficiency: 0,
        correctCount: 0,
        fuzzyCount: 0,
        wrongCount: 0,
        nextReviewAt: new Date().toISOString(),
        lastStudiedAt: undefined,
      })),
    }))
    setToast('学习进度已重置，词库仍保留。')
  }

  async function playPronunciation(word: VocabWord, accent: Accent) {
    const existing = word.pronunciations[accent]
    if (existing?.audioUrl) {
      playAudio(existing.audioUrl, word.word, accent)
      return
    }

    setPronunciationLoading(`${word.id}-${accent}`)
    try {
      const pronunciations = await lookupPronunciations(word.word)
      const updated = {
        ...word,
        pronunciations: { ...word.pronunciations, ...pronunciations },
        updatedAt: new Date().toISOString(),
      }
      updateWords((words) => words.map((item) => (item.id === word.id ? updated : item)))
      const resolved = updated.pronunciations[accent]
      if (resolved?.audioUrl) {
        playAudio(resolved.audioUrl, word.word, accent)
      } else {
        speakWord(word.word, accent)
      }
    } finally {
      setPronunciationLoading(null)
    }
  }

  function playAudio(url: string, fallbackWord: string, accent: Accent) {
    const audio = new Audio(url)
    audio.play().catch(() => speakWord(fallbackWord, accent))
  }

  async function translateSelectedText() {
    if (!selectionTool) return
    const selectedText = selectionTool.text
    const runId = selectionRunRef.current + 1
    selectionRunRef.current = runId
    selectionAbortRef.current?.abort()
    const controller = new AbortController()
    selectionAbortRef.current = controller

    setSelectionTool((current) => (current ? { ...current, loading: true, error: undefined } : current))
    setInspector({
      kind: 'selection',
      title: '划词翻译',
      text: selectedText,
      loading: true,
    })
    try {
      const result = await translateSelection(selectedText, state.settings.aiModel, controller.signal)
      if (controller.signal.aborted || selectionRunRef.current !== runId) return
      setSelectionTool((current) => (current ? { ...current, loading: false, result } : current))
      setInspector({
        kind: 'selection',
        title: '划词翻译',
        text: selectedText,
        loading: false,
        result,
      })
    } catch (error) {
      if (controller.signal.aborted || selectionRunRef.current !== runId) return
      const message = error instanceof Error ? error.message : '翻译失败。'
      setSelectionTool((current) => (current ? { ...current, loading: false, error: message } : current))
      setInspector({
        kind: 'selection',
        title: '划词翻译',
        text: selectedText,
        loading: false,
        error: message,
      })
    } finally {
      if (selectionAbortRef.current === controller) selectionAbortRef.current = null
    }
  }

  function speakSelectedText() {
    if (!selectionTool) return
    const synth = window.speechSynthesis
    if (!synth) return
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(selectionTool.text)
    utterance.lang = /[\u4e00-\u9fa5]/.test(selectionTool.text) ? 'zh-CN' : 'en-US'
    utterance.rate = 0.86
    const voice = synth.getVoices().find((item) => item.lang === utterance.lang) || synth.getVoices().find((item) => item.lang.startsWith(utterance.lang.slice(0, 2)))
    if (voice) utterance.voice = voice
    synth.speak(utterance)
  }

  async function inspectSentence(sentence: string) {
    setInspector({
      kind: 'sentence',
      title: '句子讲解',
      text: sentence,
      loading: true,
    })
    try {
      const result = await analyzeSentence(sentence, activeWords.length ? activeWords : state.words, state.settings.aiModel)
      setInspector({
        kind: 'sentence',
        title: '句子讲解',
        text: sentence,
        loading: false,
        result,
      })
    } catch (error) {
      setInspector({
        kind: 'sentence',
        title: '句子讲解',
        text: sentence,
        loading: false,
        error: error instanceof Error ? error.message : '句子解析失败。',
      })
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">G</div>
          <div>
            <span>Word</span>
            <strong>Word Studio</strong>
          </div>
        </div>

        <nav className="nav-list" aria-label="Main">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button key={tab.id} className={activeTab === tab.id ? 'nav-item active' : 'nav-item'} onClick={() => setActiveTab(tab.id)}>
                <Icon size={18} />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="sidebar-card">
          <span className="eyebrow">今天</span>
          <strong>{activeCollectionName}</strong>
          <p>今天还要看 {stats.due} 个</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="eyebrow">词汇练习</span>
            <h1>词汇学习台</h1>
          </div>
        </header>

        <section className="metric-grid" aria-label="Study metrics">
          <Metric icon={Library} label={activeCollectionName} value={stats.total} suffix="词" />
          <Metric icon={Brain} label="今天该看" value={stats.due} suffix="词" />
          <Metric icon={AlertCircle} label="错词" value={stats.weak} suffix="词" />
          <Metric icon={BookOpen} label="课文覆盖" value={stats.coverage} suffix="%" />
        </section>

        <AnimatePresence mode="wait">
          <motion.section
            key={activeTab}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="view-panel"
          >
            {activeTab === 'today' && (
              <TodayView
                words={state.words}
                collectionName={activeCollectionName}
                dueWords={dueWords}
                onRate={(word, rating) => updateWords((items) => items.map((item) => (item.id === word.id ? applyStudyRating(item, rating) : item)))}
                onPlay={playPronunciation}
                pronunciationLoading={pronunciationLoading}
                onGoImport={() => setActiveTab('import')}
              />
            )}
            {activeTab === 'library' && (
              <LibraryView
                state={state}
                activeCollectionId={activeCollectionId}
                activeWords={activeWords}
                onStateChange={setState}
                onWordsChange={updateWords}
                onPlay={playPronunciation}
                onSelectCollection={selectCollection}
                onCreateCollection={createCollection}
              />
            )}
            {activeTab === 'reading' && (
              <ReadingView
                state={state}
                words={activeWords}
                activeCollectionId={activeCollectionId}
                activeCollectionName={activeCollectionName}
                aiStatus={aiStatus}
                onStateChange={setState}
                onPlay={playPronunciation}
                pronunciationLoading={pronunciationLoading}
                onInspectSentence={inspectSentence}
              />
            )}
            {activeTab === 'mistakes' && <MistakesView words={weakWords} onPlay={playPronunciation} onRate={(word, rating) => updateWords((items) => items.map((item) => (item.id === word.id ? applyStudyRating(item, rating) : item)))} />}
            {activeTab === 'import' && (
              <ImportView
                collections={state.collections}
                activeCollectionId={activeCollectionId}
                onImport={importCandidates}
                onCreateCollection={createCollection}
                onSample={(targetCollectionId) => importCandidates(sampleWords, targetCollectionId)}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsView state={state} aiStatus={aiStatus} onStateChange={setState} onExport={() => exportStateFile(state)} onReset={resetProgress} />
            )}
          </motion.section>
        </AnimatePresence>
      </main>

      <RightRail state={state} stats={stats} activeCollectionName={activeCollectionName} aiStatus={aiStatus} inspector={inspector} />

      <SelectionPopover
        tool={selectionTool}
        hasAi={Boolean(aiStatus?.hasAi)}
        onTranslate={translateSelectedText}
        onSpeak={speakSelectedText}
        onClose={cancelSelectionContext}
      />

      <AnimatePresence>
        {toast && (
          <motion.div className="toast" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}>
            <Check size={16} />
            <span>{toast}</span>
            <button onClick={() => setToast('')} aria-label="关闭提示">
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function SelectionPopover({
  tool,
  hasAi,
  onTranslate,
  onSpeak,
  onClose,
}: {
  tool: SelectionToolState | null
  hasAi: boolean
  onTranslate: () => void
  onSpeak: () => void
  onClose: () => void
}) {
  if (!tool) return null

  return (
    <motion.div
      className="selection-popover"
      style={{ left: tool.x, top: tool.y }}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
    >
      <div className="selection-popover-head">
        <span>{tool.text}</span>
        <button onClick={onClose} aria-label="关闭选词工具">
          <X size={14} />
        </button>
      </div>
      <div className="selection-actions">
        <button className="primary" onClick={onTranslate} disabled={!hasAi || tool.loading}>
          {tool.loading ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
          翻译
        </button>
        <button className="soft" onClick={onSpeak}>
          <Volume2 size={14} />
          朗读
        </button>
      </div>
      {!hasAi && <p className="selection-warning">DeepSeek 未连接，朗读仍可用。</p>}
      {tool.error && <p className="selection-warning">{tool.error}</p>}
    </motion.div>
  )
}

function RightRail({
  state,
  stats,
  activeCollectionName,
  aiStatus,
  inspector,
}: {
  state: AppState
  stats: { total: number; allTotal: number; due: number; weak: number; mastered: number; covered: number; coverage: number }
  activeCollectionName: string
  aiStatus: AiStatus | null
  inspector: InspectorState | null
}) {
  return (
    <aside className="right-rail">
      <section className="rail-card ai-card">
        <span className="eyebrow">DeepSeek</span>
        <div className="rail-status">
          <span className={aiStatus?.hasAi ? 'status-dot online' : 'status-dot'} />
          <strong>{aiStatus?.hasAi ? '已就绪' : '未连接'}</strong>
        </div>
        <p>{aiStatus?.model || state.settings.aiModel}</p>
      </section>

      <section className="rail-card rail-mini-status">
        <span>{activeCollectionName}</span>
        <span>{stats.total} 词</span>
        <span>今天 {stats.due}</span>
        <span>错词 {stats.weak}</span>
        <div className="progress-track">
          <motion.div animate={{ width: `${stats.coverage}%` }} />
        </div>
      </section>

      <section className="rail-card inspector-card">
        <span className="eyebrow">{inspector?.title || '讲解栏'}</span>
        {inspector ? (
          <InspectorContent inspector={inspector} />
        ) : (
          <div className="inspector-empty">
            <h3>点一句课文，或划一段文字</h3>
            <p>翻译、结构和重点词会出现在这里。</p>
          </div>
        )}
      </section>
    </aside>
  )
}

function InspectorContent({ inspector }: { inspector: InspectorState }) {
  return (
    <div className="inspector-content">
      <h3>{inspector.text}</h3>
      {inspector.loading && (
        <p className="muted">
          <Loader2 size={14} className="spin inline-icon" />
          正在整理...
        </p>
      )}
      {inspector.error && <Notice text={inspector.error} tone="warning" />}
      {inspector.kind === 'sentence' && inspector.result && (
        <div className="analysis-content">
          <Block title="中文" items={[inspector.result.translation]} />
          <Block title="句子骨架" items={inspector.result.structure} />
          <Block title="词语" items={inspector.result.keyWords.map((item) => `${item.word}: ${item.meaning} (${item.role})`)} />
          <Block title="语法" items={inspector.result.grammar} />
          <Block title="提醒" items={[inspector.result.tip]} />
        </div>
      )}
      {inspector.kind === 'selection' && inspector.result && (
        <div className="selection-result rail-selection-result">
          <strong>{inspector.result.translation}</strong>
          <p>{inspector.result.explanation}</p>
        </div>
      )}
    </div>
  )
}

function Metric({ icon: Icon, label, value, suffix }: { icon: typeof Brain; label: string; value: number; suffix: string }) {
  return (
    <div className="metric-card">
      <Icon size={18} />
      <span>{label}</span>
      <strong>
        {value}
        <small>{suffix}</small>
      </strong>
    </div>
  )
}

function TodayView({
  words,
  collectionName,
  dueWords,
  onRate,
  onPlay,
  pronunciationLoading,
  onGoImport,
}: {
  words: VocabWord[]
  collectionName: string
  dueWords: VocabWord[]
  onRate: (word: VocabWord, rating: StudyRating) => void
  onPlay: (word: VocabWord, accent: Accent) => void
  pronunciationLoading: string | null
  onGoImport: () => void
}) {
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [reviewDeck, setReviewDeck] = useState<VocabWord[]>([])
  const wordIdsKey = useMemo(() => words.map((word) => word.id).join('|'), [words])
  const queue = reviewDeck.length ? reviewDeck : dueWords
  const queuedCurrent = queue[index]
  const current = queuedCurrent ? words.find((word) => word.id === queuedCurrent.id) || queuedCurrent : undefined

  useEffect(() => {
    if (reviewDeck.length) return
    setIndex(0)
    setFlipped(false)
  }, [dueWords.length, reviewDeck.length])

  useEffect(() => {
    setIndex(0)
    setFlipped(false)
    setReviewDeck([])
  }, [wordIdsKey])

  useEffect(() => {
    if (words.length && !dueWords.length && reviewDeck.length === 0) {
      setReviewDeck(createReviewDeck(words))
      setIndex(0)
      setFlipped(false)
    }
  }, [dueWords.length, reviewDeck.length, words])

  function reshuffleDeck() {
    setReviewDeck(createReviewDeck(words))
    setIndex(0)
    setFlipped(false)
  }

  if (!words.length) {
    return (
      <EmptyState
        icon={Upload}
        title="先导入你的词表"
        text="PDF、图片、文本都可以。导入后就能开始翻卡复习。"
        actionLabel="去导入"
        onAction={onGoImport}
      />
    )
  }

  if (!current) {
    return (
      <EmptyState
        icon={RotateCcw}
        title="这一轮背完了"
        text="想继续巩固，就打乱顺序再来一轮。"
        actionLabel="打乱再背"
        onAction={reshuffleDeck}
      />
    )
  }

  function rate(rating: StudyRating) {
    if (!current) return
    onRate(current, rating)
    setFlipped(false)
    setIndex((value) => value + 1)
  }

  return (
    <div className="study-layout">
      <div className="section-heading">
        <span className="eyebrow">{collectionName} · {reviewDeck.length ? '自由复习' : dueWords.length ? '今天该看' : '自由复习'}</span>
        <h2>先回忆，再翻卡</h2>
        <p>先想意思，再看答案。错得多的词会更快回来。</p>
        <button className="soft" onClick={reshuffleDeck}>
          <RotateCcw size={15} />
          打乱一轮
        </button>
      </div>

      <motion.div className={flipped ? 'word-card flipped' : 'word-card'} layout>
        <div className="card-top">
          <span>第 {index + 1} / {queue.length}</span>
          <div className="audio-row">
            <AudioButton label="美音" loading={pronunciationLoading === `${current.id}-us`} onClick={() => onPlay(current, 'us')} />
            <AudioButton label="英音" loading={pronunciationLoading === `${current.id}-uk`} onClick={() => onPlay(current, 'uk')} />
          </div>
        </div>

        <button className="flip-area" onClick={() => setFlipped((value) => !value)}>
          <span className="word-text">{current.word}</span>
          <span className="phonetic-line">
            {current.pronunciations.us?.phonetic || current.pronunciations.uk?.phonetic || '点击发音查找音标；查不到会朗读'}
          </span>
          <AnimatePresence mode="wait">
            {flipped ? (
              <motion.p key="meaning" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                {cleanImportedMeaning(current.word, current.meaning) || '暂无释义，请在词库中补充。'}
              </motion.p>
            ) : (
              <motion.p key="prompt" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                点击翻卡查看释义
              </motion.p>
            )}
          </AnimatePresence>
        </button>

        <div className="rating-row">
          <button className="soft danger" onClick={() => rate('unknown')}>不认识</button>
          <button className="soft" onClick={() => rate('fuzzy')}>模糊</button>
          <button className="primary" onClick={() => rate('known')}>认识</button>
        </div>
      </motion.div>
    </div>
  )
}

function AudioButton({ label, loading, onClick }: { label: string; loading: boolean; onClick: () => void }) {
  return (
    <button className="audio-button" onClick={onClick}>
      {loading ? <Loader2 size={14} className="spin" /> : <Volume2 size={14} />}
      {label}
    </button>
  )
}

function LibraryView({
  state,
  activeCollectionId,
  activeWords,
  onStateChange,
  onWordsChange,
  onPlay,
  onSelectCollection,
  onCreateCollection,
}: {
  state: AppState
  activeCollectionId: string
  activeWords: VocabWord[]
  onStateChange: (state: AppState | ((state: AppState) => AppState)) => void
  onWordsChange: (updater: (words: VocabWord[]) => VocabWord[]) => void
  onPlay: (word: VocabWord, accent: Accent) => void
  onSelectCollection: (collectionId: string) => void
  onCreateCollection: (name: string, wordIds?: string[]) => string
}) {
  const [query, setQuery] = useState('')
  const [newCollectionName, setNewCollectionName] = useState('')
  const [addQuery, setAddQuery] = useState('')
  const activeCollection = state.collections.find((collection) => collection.id === activeCollectionId)
  const isAllWords = activeCollectionId === ALL_WORDS_COLLECTION_ID
  const activeWordIds = new Set(activeWords.map((word) => word.id))
  const filtered = activeWords.filter((word) => {
    const q = query.trim().toLowerCase()
    return !q || word.word.toLowerCase().includes(q) || word.meaning.includes(query)
  })
  const availableWords = state.words
    .filter((word) => !activeWordIds.has(word.id))
    .filter((word) => {
      const q = addQuery.trim().toLowerCase()
      return !q || word.word.toLowerCase().includes(q) || word.meaning.includes(addQuery)
    })
    .slice(0, 10)

  function updateWord(id: string, patch: Partial<VocabWord>) {
    onWordsChange((items) => items.map((item) => (item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item)))
  }

  function createCollectionFromForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newCollectionName.trim()
    if (!name) return
    onCreateCollection(name)
    setNewCollectionName('')
  }

  function updateCollection(id: string, patch: Partial<WordCollection>) {
    onStateChange((current) => ({
      ...current,
      collections: current.collections.map((collection) =>
        collection.id === id ? { ...collection, ...patch, updatedAt: new Date().toISOString() } : collection,
      ),
    }))
  }

  function deleteCollection(id: string) {
    onStateChange((current) => ({
      ...current,
      activeCollectionId: current.activeCollectionId === id ? ALL_WORDS_COLLECTION_ID : current.activeCollectionId,
      collections: current.collections.filter((collection) => collection.id !== id),
      readings: current.readings.filter((reading) => reading.collectionId !== id),
    }))
  }

  function addWordToActiveCollection(wordId: string) {
    if (isAllWords) return
    onStateChange((current) => ({
      ...current,
      collections: current.collections.map((collection) =>
        collection.id === activeCollectionId
          ? {
              ...collection,
              wordIds: Array.from(new Set([...collection.wordIds, wordId])),
              updatedAt: new Date().toISOString(),
            }
          : collection,
      ),
    }))
  }

  function removeWord(wordId: string) {
    if (isAllWords) {
      onStateChange((current) => ({
        ...current,
        words: current.words.filter((word) => word.id !== wordId),
        collections: current.collections.map((collection) => ({
          ...collection,
          wordIds: collection.wordIds.filter((id) => id !== wordId),
        })),
        readings: current.readings.map((reading) => ({
          ...reading,
          targetWordIds: reading.targetWordIds.filter((id) => id !== wordId),
        })),
      }))
      return
    }

    onStateChange((current) => ({
      ...current,
      collections: current.collections.map((collection) =>
        collection.id === activeCollectionId
          ? {
              ...collection,
              wordIds: collection.wordIds.filter((id) => id !== wordId),
              updatedAt: new Date().toISOString(),
            }
          : collection,
      ),
    }))
  }

  function collectionCount(collection: WordCollection) {
    const validIds = new Set(state.words.map((word) => word.id))
    return collection.wordIds.filter((id) => validIds.has(id)).length
  }

  return (
    <div className="library-layout">
      <aside className="collection-shelf">
        <div className="section-heading compact">
          <span className="eyebrow">词库</span>
          <h2>我的书架</h2>
        </div>

        <button
          className={isAllWords ? 'collection-book active' : 'collection-book'}
          onClick={() => onSelectCollection(ALL_WORDS_COLLECTION_ID)}
        >
          <BookOpen size={18} />
          <div>
            <strong>总词库</strong>
            <span>{state.words.length} 词 · 默认</span>
          </div>
        </button>

        {state.collections.map((collection) => (
          <button
            className={activeCollectionId === collection.id ? 'collection-book active' : 'collection-book'}
            key={collection.id}
            onClick={() => onSelectCollection(collection.id)}
          >
            <Library size={18} />
            <div>
              <strong>{collection.name}</strong>
              <span>{collectionCount(collection)} 词</span>
            </div>
          </button>
        ))}

        <form className="new-collection-card" onSubmit={createCollectionFromForm}>
          <input value={newCollectionName} onChange={(event) => setNewCollectionName(event.target.value)} placeholder="新词库名，比如：新概念第一册" />
          <button className="primary" type="submit">新建词库</button>
        </form>
      </aside>

      <div className="collection-workspace">
        <div className="section-heading horizontal">
          <div>
            <span className="eyebrow">{isAllWords ? '默认词库' : '自定义词库'}</span>
            <h2>{activeCollection?.name || '总词库'}</h2>
            <p>{isAllWords ? '这里汇总所有导入过的单词。' : activeCollection?.description || '这本词库只保留你放进来的词。'}</p>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索单词或中文释义" />
          </label>
        </div>

        {activeCollection && (
          <div className="collection-settings">
            <label>
              词库名
              <input value={activeCollection.name} onChange={(event) => updateCollection(activeCollection.id, { name: event.target.value })} />
            </label>
            <label>
              备注
              <textarea
                value={activeCollection.description || ''}
                onChange={(event) => updateCollection(activeCollection.id, { description: event.target.value })}
                placeholder="比如：某本教材、一次考试、基础词、阅读词。"
              />
            </label>
            <button className="soft danger" onClick={() => deleteCollection(activeCollection.id)}>删除这本词库</button>
          </div>
        )}

        {activeCollection && (
          <div className="add-word-panel">
            <div>
              <strong>从总词库加入</strong>
              <span>不会复制单词，只是把它放进这本词库。</span>
            </div>
            <label className="search-box">
              <Search size={16} />
              <input value={addQuery} onChange={(event) => setAddQuery(event.target.value)} placeholder="搜索要加入的词" />
            </label>
            <div className="add-word-list">
              {availableWords.map((word) => (
                <button key={word.id} onClick={() => addWordToActiveCollection(word.id)}>
                  <span>{word.word}</span>
                  <small>{word.meaning || '未填释义'}</small>
                </button>
              ))}
              {!availableWords.length && <span className="muted">没有可加入的匹配单词。</span>}
            </div>
          </div>
        )}

        <div className="word-table">
          {filtered.map((word) => (
            <div className="word-row" key={word.id}>
              <div>
                <strong>{word.word}</strong>
                <span>{word.partOfSpeech || '未标词性'} · 熟练度 {word.proficiency}</span>
              </div>
            <input value={word.meaning} onChange={(event) => updateWord(word.id, { meaning: event.target.value })} />
              <div className="row-actions">
                <button onClick={() => onPlay(word, 'us')} title="美音">
                  <Headphones size={15} />
                </button>
                <button onClick={() => onPlay(word, 'uk')} title="英音">
                  <Volume2 size={15} />
                </button>
                <button className="danger-icon" onClick={() => removeWord(word.id)} title={isAllWords ? '从总词库删除' : '从这本词库移出'}>
                  <X size={15} />
                </button>
              </div>
            </div>
          ))}
          {!filtered.length && (
            <div className="empty-state small">
              <Library size={28} />
              <h2>这本词库还没有词</h2>
              <p>{isAllWords ? '先去导入页面加入词表。' : '可以从总词库加入，也可以导入时选择这本词库。'}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ReadingView({
  state,
  words,
  activeCollectionId,
  activeCollectionName,
  aiStatus,
  onStateChange,
  onPlay,
  pronunciationLoading,
  onInspectSentence,
}: {
  state: AppState
  words: VocabWord[]
  activeCollectionId: string
  activeCollectionName: string
  aiStatus: AiStatus | null
  onStateChange: (state: AppState | ((state: AppState) => AppState)) => void
  onPlay: (word: VocabWord, accent: Accent) => void
  pronunciationLoading: string | null
  onInspectSentence: (sentence: string) => void
}) {
  const activeReadings = useMemo(
    () => state.readings.filter((reading) => (reading.collectionId || ALL_WORDS_COLLECTION_ID) === activeCollectionId),
    [activeCollectionId, state.readings],
  )
  const [activeReadingId, setActiveReadingId] = useState(activeReadings[0]?.id ?? '')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const activeReading = activeReadings.find((reading) => reading.id === activeReadingId) || activeReadings[0]
  const targetWords = activeReading ? state.words.filter((word) => activeReading.targetWordIds.includes(word.id)) : []

  useEffect(() => {
    if (!activeReadings.some((reading) => reading.id === activeReadingId)) {
      const nextReadingId = activeReadings[0]?.id ?? ''
      if (activeReadingId !== nextReadingId) setActiveReadingId(nextReadingId)
    }
  }, [activeReadingId, activeReadings])

  async function createReading() {
    if (!words.length) {
      setMessage('请先给当前词库加入单词。')
      return
    }
    setLoading(true)
    setMessage('')
    try {
      const targets = chooseReadingTargets(words, state.settings.readingBatchSize)
      const generated = await generateReading(targets, state.settings.aiModel)
      const passage: ReadingPassage = {
        id: createId('reading'),
        title: generated.title,
        story: generated.story,
        sentences: generated.sentences.length ? generated.sentences : splitSentences(generated.story).map((text) => ({ text, usedWords: [], pairs: createFallbackPairs(text, targets) })),
        collectionId: activeCollectionId,
        targetWordIds: targets.map((word) => word.id),
        coveredWords: generated.coveredWords,
        missingWords: generated.missingWords,
        notes: generated.notes,
        createdAt: new Date().toISOString(),
      }

      onStateChange((current) => ({
        ...current,
        readings: [passage, ...current.readings],
        words: current.words.map((word) =>
          generated.coveredWords.map(normalizeWord).includes(normalizeWord(word.word))
            ? { ...word, readingCoveredCount: word.readingCoveredCount + 1, updatedAt: new Date().toISOString() }
            : word,
        ),
      }))
      setActiveReadingId(passage.id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '阅读生成失败。')
    } finally {
      setLoading(false)
    }
  }

  function deleteReading(readingId: string) {
    onStateChange((current) => {
      const readings = current.readings.filter((reading) => reading.id !== readingId)
      const nextActive = readings[0]?.id ?? ''
      const coverageCounts = new Map<string, number>()
      readings.forEach((reading) => {
        reading.coveredWords.forEach((word) => {
          const key = normalizeWord(word)
          coverageCounts.set(key, (coverageCounts.get(key) || 0) + 1)
        })
      })
      setActiveReadingId(nextActive)
      return {
        ...current,
        readings,
        words: current.words.map((word) => ({
          ...word,
          readingCoveredCount: coverageCounts.get(normalizeWord(word.word)) || 0,
        })),
      }
    })
  }

  return (
    <div className="reading-layout">
      <div className="reading-main">
        <div className="section-heading horizontal">
          <div>
            <span className="eyebrow">课文练习</span>
            <h2>干中学，学中干</h2>
            <p>当前词库：{activeCollectionName}。生成一篇短课文，把新词放进自然语境里读。</p>
          </div>
          <button className="primary" onClick={createReading} disabled={loading || !aiStatus?.hasAi}>
            {loading ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
            生成文章
          </button>
        </div>

        {!aiStatus?.hasAi && <Notice text="DeepSeek 未配置：导入和背词可用，阅读生成与句子解析需要在 .env 中设置 DEEPSEEK_API_KEY。" />}
        {message && <Notice text={message} tone="warning" />}

        {activeReading ? (
          <article className="reading-card">
            <div className="reading-title-row">
              <div>
                <span className="eyebrow">课文</span>
                <h3>{activeReading.title}</h3>
              </div>
              <div className="reading-actions">
                <select value={activeReading.id} onChange={(event) => setActiveReadingId(event.target.value)}>
                  {activeReadings.map((reading) => (
                    <option key={reading.id} value={reading.id}>{reading.title}</option>
                  ))}
                </select>
                <button className="soft danger" onClick={() => deleteReading(activeReading.id)}>
                  <X size={15} />
                  删除
                </button>
              </div>
            </div>

            <div className="lesson-list">
              {activeReading.sentences.map((sentence, sentenceIndex) => (
                <div className="lesson-sentence" key={`${sentence.text}-${sentenceIndex}`}>
                  <button onClick={() => onInspectSentence(sentence.text)}>{sentence.text}</button>
                  <WordPairs pairs={completePairs(sentence.text, sentence.pairs, targetWords)} />
                </div>
              ))}
            </div>

            <div className="target-chip-row">
              {targetWords.map((word) => (
                <button key={word.id} onClick={() => onPlay(word, 'us')}>
                  {pronunciationLoading === `${word.id}-us` ? <Loader2 size={13} className="spin" /> : <Volume2 size={13} />}
                  {word.word}
                </button>
              ))}
            </div>

            {activeReading.missingWords.length > 0 && (
              <Notice tone="warning" text={`这篇仍缺少：${activeReading.missingWords.join(', ')}。下一次生成会优先补上。`} />
            )}
          </article>
        ) : (
          <EmptyState icon={BookOpen} title="还没有阅读文章" text="给当前词库加入单词后，可以生成配套小课文。" />
        )}
      </div>
    </div>
  )
}

function WordPairs({ pairs }: { pairs: Array<{ english: string; chinese: string }> }) {
  return (
    <div className="word-pair-grid">
      {pairs.map((pair, index) => (
        <span className="word-pair" key={`${pair.english}-${index}`}>
          <b>{pair.english}</b>
          <small>{pair.chinese || '-'}</small>
        </span>
      ))}
    </div>
  )
}

function MistakesView({
  words,
  onPlay,
  onRate,
}: {
  words: VocabWord[]
  onPlay: (word: VocabWord, accent: Accent) => void
  onRate: (word: VocabWord, rating: StudyRating) => void
}) {
  if (!words.length) {
    return <EmptyState icon={Check} title="暂时没有错词" text="背词时选择“模糊”或“不认识”的词会自动出现在这里。" />
  }

  return (
    <div className="stack">
      <div className="section-heading">
        <span className="eyebrow">错词</span>
        <h2>错词强化</h2>
      </div>
      <div className="mistake-grid">
        {words.map((word) => (
          <div className="mistake-card" key={word.id}>
            <div>
              <strong>{word.word}</strong>
              <p>{word.meaning}</p>
            </div>
            <span>错 {word.wrongCount} · 模糊 {word.fuzzyCount}</span>
            <div className="rating-row compact">
              <button onClick={() => onPlay(word, 'us')}><Volume2 size={14} /></button>
              <button onClick={() => onRate(word, 'fuzzy')}>还模糊</button>
              <button className="primary" onClick={() => onRate(word, 'known')}>已掌握</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ImportView({
  collections,
  activeCollectionId,
  onImport,
  onCreateCollection,
  onSample,
}: {
  collections: WordCollection[]
  activeCollectionId: string
  onImport: (candidates: ImportCandidate[], targetCollectionId?: string) => void
  onCreateCollection: (name: string, wordIds?: string[]) => string
  onSample: (targetCollectionId?: string) => void
}) {
  const [text, setText] = useState('')
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [targetCollectionId, setTargetCollectionId] = useState(activeCollectionId)
  const [newCollectionName, setNewCollectionName] = useState('')

  useEffect(() => {
    setTargetCollectionId(activeCollectionId)
  }, [activeCollectionId])

  async function handleFile(file: File) {
    setBusy(true)
    setProgress({ phase: '准备导入', percent: 2 })
    try {
      const extracted = await extractTextFromFile(file, setProgress)
      setCandidates(parseVocabularyText(extracted.text, extracted.source, extracted.confidence))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  function parseText() {
    setCandidates(parseVocabularyText(text, 'pasted-text', 100))
  }

  function updateCandidate(id: string, patch: Partial<ImportCandidate>) {
    setCandidates((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function createTargetCollection() {
    const name = newCollectionName.trim()
    if (!name) return
    const id = onCreateCollection(name)
    setTargetCollectionId(id)
    setNewCollectionName('')
  }

  return (
      <div className="import-layout">
      <div className="section-heading">
        <span className="eyebrow">导入</span>
        <h2>导入词表</h2>
        <div className="format-list">
          <span>PDF</span>
          <span>图片</span>
          <span>TXT</span>
          <span>文本</span>
        </div>
      </div>

      <div className="import-grid">
        <label className="drop-zone">
          <Upload size={28} />
          <strong>选择文件</strong>
          <span>PDF · 图片 · TXT</span>
          <input
            type="file"
            accept=".pdf,.txt,text/plain,image/*"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleFile(file)
            }}
          />
        </label>

        <div className="paste-box">
          <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴词表" />
          <div className="button-row">
            <button className="primary" onClick={parseText} disabled={!text.trim()}>
              <FileText size={16} />
              解析文本
            </button>
            <button className="soft" onClick={() => onSample(targetCollectionId)}>加入示例词</button>
          </div>
        </div>
      </div>

      {busy && progress && (
        <div className="progress-card">
          <div>
            <Loader2 size={16} className="spin" />
            <span>{progress.phase}</span>
          </div>
          <div className="progress-track">
            <motion.div animate={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="preview-panel">
          <div className="section-heading horizontal">
            <div>
              <span className="eyebrow">预览</span>
              <h2>选择单词</h2>
            </div>
          </div>
          <div className="candidate-list">
            {candidates.map((candidate) => (
              <div className={candidate.confidence < 70 ? 'candidate-row low' : 'candidate-row'} key={candidate.id}>
                <input type="checkbox" checked={candidate.selected} onChange={(event) => updateCandidate(candidate.id, { selected: event.target.checked })} />
                <input value={candidate.word} onChange={(event) => updateCandidate(candidate.id, { word: event.target.value })} />
                <input value={candidate.meaning} onChange={(event) => updateCandidate(candidate.id, { meaning: event.target.value })} placeholder="中文释义" />
                <span className="confidence-badge">{candidate.confidence < 70 ? '需校对' : ''}</span>
              </div>
            ))}
          </div>

          <div className="import-target-row">
            <label>
              导入到
              <select value={targetCollectionId} onChange={(event) => setTargetCollectionId(event.target.value)}>
                <option value={ALL_WORDS_COLLECTION_ID}>总词库</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>{collection.name}</option>
                ))}
              </select>
            </label>
            <div className="quick-create-collection">
              <input value={newCollectionName} onChange={(event) => setNewCollectionName(event.target.value)} placeholder="新建词库名" />
              <button className="soft" onClick={createTargetCollection} disabled={!newCollectionName.trim()}>新建并选择</button>
            </div>
            <button className="primary" onClick={() => onImport(candidates, targetCollectionId)}>
              <Check size={16} />
              导入选中 {candidates.filter((item) => item.selected).length} 个
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SettingsView({
  state,
  aiStatus,
  onStateChange,
  onExport,
  onReset,
}: {
  state: AppState
  aiStatus: AiStatus | null
  onStateChange: (state: AppState) => void
  onExport: () => void
  onReset: () => void
}) {
  function updateSettings(patch: Partial<AppState['settings']>) {
    onStateChange({ ...state, settings: { ...state.settings, ...patch } })
  }

  return (
    <div className="settings-page">
      <div className="settings-hero">
        <div>
          <span className="eyebrow">设置</span>
          <h2>把节奏调到适合你</h2>
        </div>
        <span className={aiStatus?.hasAi ? 'settings-badge online' : 'settings-badge'}>
          {aiStatus?.hasAi ? 'DeepSeek 已连接' : 'DeepSeek 未连接'}
        </span>
      </div>

      <div className="settings-grid">
        <div className="settings-card">
          <span className="eyebrow">学习</span>
          <h3>每天怎么背</h3>
          <div className="settings-fields">
            <label>
              每天大约多久
              <input type="number" value={state.settings.dailyMinutes} onChange={(event) => updateSettings({ dailyMinutes: Number(event.target.value) })} />
            </label>
            <label>
              新词上限
              <input type="number" value={state.settings.dailyNewWords} onChange={(event) => updateSettings({ dailyNewWords: Number(event.target.value) })} />
            </label>
            <label>
              每篇课文放几个词
              <input type="number" min={6} max={18} value={state.settings.readingBatchSize} onChange={(event) => updateSettings({ readingBatchSize: Number(event.target.value) })} />
            </label>
          </div>
        </div>

        <div className="settings-card">
          <span className="eyebrow">连接</span>
          <h3>讲解和课文生成</h3>
          <div className="settings-fields">
            <label>
              模型
              <input value={state.settings.aiModel} onChange={(event) => updateSettings({ aiModel: event.target.value })} />
            </label>
            <div className="status-list">
              <span>当前：{aiStatus?.model || state.settings.aiModel}</span>
              <span>发音源：Merriam-Webster {aiStatus?.pronunciationProviders.merriamWebster ? '已开' : '未开'} · Wordnik {aiStatus?.pronunciationProviders.wordnik ? '已开' : '未开'} · Forvo {aiStatus?.pronunciationProviders.forvo ? '已开' : '未开'}</span>
            </div>
          </div>
        </div>

        <div className="settings-card settings-card-wide">
          <span className="eyebrow">数据</span>
          <h3>备份与整理</h3>
          <div className="settings-actions">
            <button className="soft" onClick={onExport}><BarChart3 size={16} />导出备份</button>
            <button className="soft danger" onClick={onReset}><RotateCcw size={16} />只重置进度</button>
            <button className="soft" onClick={() => onStateChange(defaultState)}>清空全部</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  text,
  actionLabel,
  onAction,
}: {
  icon: typeof Brain
  title: string
  text: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="empty-state">
      <Icon size={32} />
      <h2>{title}</h2>
      <p>{text}</p>
      {actionLabel && onAction && <button className="primary" onClick={onAction}>{actionLabel}</button>}
    </div>
  )
}

function Notice({ text, tone = 'info' }: { text: string; tone?: 'info' | 'warning' }) {
  return (
    <div className={`notice ${tone}`}>
      <AlertCircle size={16} />
      <span>{text}</span>
    </div>
  )
}

function Block({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <strong>{title}</strong>
      {items.map((item, index) => (
        <p key={`${title}-${index}`}>{item}</p>
      ))}
    </section>
  )
}

function splitSentences(story: string) {
  return story
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

const basicGloss: Record<string, string> = {
  a: '一个',
  an: '一个',
  the: '这',
  i: '我',
  you: '你',
  he: '他',
  she: '她',
  it: '它',
  we: '我们',
  they: '他们',
  tom: '汤姆',
  is: '是',
  are: '是',
  am: '是',
  be: '是',
  to: '去/到',
  in: '在',
  on: '在',
  at: '在',
  for: '为了',
  with: '和',
  and: '和',
  but: '但是',
  so: '所以',
  wants: '想要',
  want: '想要',
  makes: '养成/做',
  make: '做',
  has: '有',
  have: '有',
  gets: '得到',
  get: '得到',
  goal: '目标',
}

function completePairs(sentence: string, pairs: Array<{ english: string; chinese: string }> | undefined, words: VocabWord[]) {
  const sourcePairs = pairs?.length ? pairs : createFallbackPairs(sentence, words)
  return sourcePairs.map((pair) => ({
    english: pair.english,
    chinese: pair.chinese || getWordGloss(pair.english, words),
  }))
}

function createFallbackPairs(sentence: string, words: VocabWord[] = []) {
  return sentence
    .replace(/[.!?,;:]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => ({ english: word, chinese: getWordGloss(word, words) }))
}

function getWordGloss(word: string, words: VocabWord[]) {
  const key = normalizeWord(word).replace(/[^a-z'-]/g, '')
  const matched = words.find((item) => normalizeWord(item.word) === key)
  if (matched?.meaning) return matched.meaning.split(/[;；,，]/)[0]
  return basicGloss[key] || '-'
}

export default App
