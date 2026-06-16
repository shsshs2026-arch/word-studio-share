import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { createWorker } from 'tesseract.js'
import type { ImportCandidate } from './types'
import { createId } from './storage'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export type ImportProgress = {
  phase: string
  percent: number
}

export type ExtractedText = {
  text: string
  source: string
  confidence: number
}

type ProgressHandler = (progress: ImportProgress) => void

const wordTokenPattern =
  String.raw`(?:[A-Za-z][A-Za-z'’-]*(?:-[A-Za-z][A-Za-z'’-]*)?|[A-Za-z](?:\.[A-Za-z])+\.?)(?:\s*\/\s*(?:[A-Za-z][A-Za-z'’-]*(?:-[A-Za-z][A-Za-z'’-]*)?|[A-Za-z](?:\.[A-Za-z])+\.?))*`
const wordLinePattern = new RegExp(
  String.raw`^\s*(?:\d+[.)、\s]+)?(${wordTokenPattern})\s*(?:\[([^\]]+)\]|\(([^)]{1,32})\))?\s*(?:[-—:：,，\s]+)(.+?)\s*$`,
)

type TextItemWithPosition = {
  str: string
  transform?: number[]
  width?: number
  height?: number
}

export async function extractTextFromFile(file: File, onProgress: ProgressHandler): Promise<ExtractedText> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return extractPdf(file, onProgress)
  }

  if (file.type.startsWith('image/')) {
    onProgress({ phase: '正在识别图片文字', percent: 8 })
    const text = await recognizeImage(file, onProgress)
    return { text: text.text, source: 'image-ocr', confidence: text.confidence }
  }

  const text = await file.text()
  onProgress({ phase: '文本读取完成', percent: 100 })
  return { text, source: 'text-file', confidence: 100 }
}

export function parseVocabularyText(text: string, source = 'text', baseConfidence = 100): ImportCandidate[] {
  const normalizedText = normalizeExtractedVocabularyText(text)
  const lines = normalizedText
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const candidates = lines.flatMap((line) => parseLineOrLineRun(line, source, baseConfidence))

  if (candidates.length > 0) return dedupeCandidates(candidates)

  const words = Array.from(new Set(normalizedText.match(/\b[A-Za-z][A-Za-z'-]{2,}\b/g) ?? []))
  return words.slice(0, 400).map((word) => ({
    id: createId('candidate'),
    word,
    meaning: '',
    confidence: Math.min(baseConfidence, 72),
    raw: word,
    selected: true,
    warning: '只识别到单词，释义需要手动补充。',
  }))
}

function normalizeExtractedVocabularyText(text: string) {
  return text
    .replace(/\r/g, '\n')
    .replace(/([。；;])\s+(?=\d{0,4}\s*[A-Za-z][A-Za-z'’-]{1,})/g, '$1\n')
    .replace(/([\u4e00-\u9fa5])\s+(?=\d{0,4}\s*[A-Za-z][A-Za-z'’-]{1,}\s*(?:\[|\(|[-—:：,，\s]))/g, '$1\n')
    .replace(/(\[[^\]]+\]|\([^)]{1,32}\))\s+/g, '$1 ')
}

function parseLineOrLineRun(line: string, source: string, baseConfidence: number) {
  const splitLines = splitPackedVocabularyLine(line)
  if (splitLines.length > 1) {
    return splitLines
      .map((item) => parseLine(item, source, Math.max(40, baseConfidence - 6)))
      .filter((item): item is ImportCandidate => Boolean(item))
  }

  const direct = parseLine(line, source, baseConfidence)
  if (direct) return [direct]
  return []
}

function splitPackedVocabularyLine(line: string) {
  const cleaned = line.replace(/\s+/g, ' ').trim()
  if (cleaned.length < 24) return [cleaned]

  const entryStartPattern = new RegExp(
    String.raw`(?:^|\s)(?:\d{1,4}[.)、]?\s*)?${wordTokenPattern}\s*(?:\[[^\]]+\]|\([^)]{1,32}\))?\s*(?=[\u4e00-\u9fa5])`,
    'g',
  )
  const starts: number[] = []
  let match: RegExpExecArray | null
  while ((match = entryStartPattern.exec(cleaned))) {
    starts.push(match.index + (match[0].startsWith(' ') ? 1 : 0))
  }

  if (starts.length <= 1) return [cleaned]

  return starts
    .map((start, index) => cleaned.slice(start, starts[index + 1] ?? cleaned.length).trim())
    .filter((item) => /[A-Za-z]/.test(item) && /[\u4e00-\u9fa5]/.test(item))
}

function parseLine(line: string, source: string, baseConfidence: number): ImportCandidate | null {
  const cleaned = line
    .replace(/[|]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[-*•]\s*/, '')
    .trim()

  const match = cleaned.match(wordLinePattern)
  if (!match) return null

  const word = match[1].replace(/[’]/g, "'")
  const phonetic = match[2] || match[3] || undefined
  const meaning = (match[4] || '').replace(/^[-—:：,，\s]+/, '').trim()
  const hasChinese = /[\u4e00-\u9fa5]/.test(meaning)
  const confidence = Math.max(35, Math.min(100, baseConfidence - (hasChinese ? 0 : 18)))

  return {
    id: createId('candidate'),
    word,
    meaning,
    phonetic,
    confidence,
    raw: line,
    selected: true,
    warning: confidence < 70 ? `来自 ${source}，建议校对释义。` : undefined,
  }
}

function dedupeCandidates(candidates: ImportCandidate[]) {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = candidate.word.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function extractPdf(file: File, onProgress: ProgressHandler): Promise<ExtractedText> {
  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const textParts: string[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    onProgress({ phase: `正在读取 PDF 第 ${pageNumber}/${pdf.numPages} 页`, percent: (pageNumber / pdf.numPages) * 45 })
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const pageText = rebuildPdfTextLines(content.items as TextItemWithPosition[])
    textParts.push(pageText)
  }

  const text = textParts.join('\n').trim()
  if (text.replace(/\s/g, '').length > 40) {
    onProgress({ phase: 'PDF 文字提取完成', percent: 100 })
    return { text, source: 'pdf-text', confidence: 96 }
  }

  const ocrParts: string[] = []
  const confidences: number[] = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    onProgress({ phase: `扫描 PDF 第 ${pageNumber}/${pdf.numPages} 页转图片`, percent: 45 + (pageNumber / pdf.numPages) * 10 })
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 2.2 })
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) continue
    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvas, canvasContext: context, viewport }).promise
    const recognized = await recognizeImage(canvas, (progress) => {
      onProgress({
        phase: `OCR 识别第 ${pageNumber}/${pdf.numPages} 页：${progress.phase}`,
        percent: 55 + ((pageNumber - 1 + progress.percent / 100) / pdf.numPages) * 45,
      })
    })
    ocrParts.push(recognized.text)
    confidences.push(recognized.confidence)
  }

  return {
    text: ocrParts.join('\n'),
    source: 'pdf-ocr',
    confidence: confidences.length ? confidences.reduce((sum, item) => sum + item, 0) / confidences.length : 55,
  }
}

function rebuildPdfTextLines(items: TextItemWithPosition[]) {
  const positioned = items
    .map((item) => ({
      text: item.str || '',
      x: item.transform?.[4] ?? 0,
      y: item.transform?.[5] ?? 0,
    }))
    .filter((item) => item.text.trim())

  const rows: Array<{ y: number; items: typeof positioned }> = []
  positioned.forEach((item) => {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) < 4)
    if (row) {
      row.items.push(item)
      row.y = (row.y + item.y) / 2
    } else {
      rows.push({ y: item.y, items: [item] })
    }
  })

  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) =>
      row.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text.trim())
        .filter(Boolean)
        .join(' '),
    )
    .join('\n')
}

async function recognizeImage(image: File | HTMLCanvasElement, onProgress: ProgressHandler) {
  const worker = await createWorker(['eng', 'chi_sim'], 1, {
    logger: (message) => {
      if (message.status === 'recognizing text') {
        onProgress({ phase: 'OCR 正在识别', percent: Math.round(message.progress * 100) })
      }
    },
  })

  const result = await worker.recognize(image)
  await worker.terminate()

  return {
    text: result.data.text,
    confidence: result.data.confidence,
  }
}
