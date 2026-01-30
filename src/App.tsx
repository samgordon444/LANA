import { nanoid } from 'nanoid'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch'
import {
  ArrangeVertical,
  Chat,
  Checkmark,
  Close,
  FitToScreen,
  Grid,
  Menu,
  NewTab,
  RightPanelClose,
  Settings,
  SettingsAdjust,
  TrashCan,
} from '@carbon/icons-react'
import './App.css'
import assistantAvatar from '../src-tauri/icons/32x32.png'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import {
  createBoard,
  createBackup,
  cleanupAssets,
  deleteBoard,
  emptyTrash,
  fetchLinkMetadata,
  getAssetsDir,
  listBoards,
  listTrashedBoards,
  loadBoard,
  loadChat,
  ollamaChat,
  openExternalUrl,
  restoreBoard,
  saveBoard,
  saveChat,
  saveImage,
} from './persistence/board'
import type {
  Board,
  BoardMeta,
  Card,
  ChatEntry,
  ChatMessage,
  ChatStore,
  Column,
  ImageCard,
  LinkCard,
  TextCard,
} from './types'

// Keep in sync with `.boardSurface { background-size: 22px 22px; }`
const GRID_SIZE = 22
const MIN_SCALE = 0.2
const MAX_SCALE = 4
const BOARD_WIDTH = 20000
const BOARD_HEIGHT = 20000
const BOARD_START_X = BOARD_WIDTH * 0.25
const BOARD_START_Y = BOARD_HEIGHT * 0.25
const PINCH_ZOOM_SENSITIVITY = 0.0015 * 1.25
// Dots are centered within each GRID_SIZE tile (radial-gradient default),
// so the visible dot coordinates are (GRID_OFFSET + n * GRID_SIZE).
const GRID_OFFSET = GRID_SIZE / 2
const CARD_WIDTH = GRID_SIZE * 12
const CARD_HEADER_HEIGHT = 18
// ~2 lines of text including padding (approx).
const MIN_TEXTAREA_HEIGHT = 52
const MIN_CARD_HEIGHT = CARD_HEADER_HEIGHT + MIN_TEXTAREA_HEIGHT
const LINK_CARD_TEXT_HEIGHT = GRID_SIZE * 4
const LINK_CARD_IMAGE_HEIGHT = GRID_SIZE * 6
const LINK_CARD_HEIGHT_NO_IMAGE = ceilToGrid(CARD_HEADER_HEIGHT + LINK_CARD_TEXT_HEIGHT)
const LINK_CARD_HEIGHT_WITH_IMAGE = ceilToGrid(CARD_HEADER_HEIGHT + LINK_CARD_TEXT_HEIGHT + LINK_CARD_IMAGE_HEIGHT)
const LINK_NOTE_MIN_HEIGHT = Math.max(GRID_SIZE, MIN_TEXTAREA_HEIGHT - GRID_SIZE * 2)
const LINK_NOTE_BORDER_HEIGHT = 1
const IMAGE_NOTE_MIN_HEIGHT = LINK_NOTE_MIN_HEIGHT
const DEFAULT_OLLAMA_MODEL = 'llama3.2:3b'
const CHAT_CONTEXT_LAST_N = 8
const CHAT_SUMMARY_TARGET = 16
const SELECTION_MIN_PX = 6
const COLUMN_GAP = GRID_SIZE
// List header height (2 grid units) so it stays aligned.
const COLUMN_HEADER_HEIGHT = GRID_SIZE * 2
// Must match `.columnHeader { padding: 10px 10px; }`
const COLUMN_HEADER_PADDING_Y = 10
const COLUMN_PADDING = 10
const DRAG_OUT_THRESHOLD = GRID_SIZE * 3
const GROUP_DETACH_PREVIEW_THRESHOLD = GRID_SIZE * 1.5
const RECENT_BOARDS_KEY = 'lana_recent_boards'
const LAST_BOARD_KEY = 'lana_last_board_id'
const BACKUP_ENABLED_KEY = 'lana_backup_enabled'
const BACKUP_FOLDER_KEY = 'lana_backup_folder'

function snapToGrid(value: number, offset = 0) {
  return Math.round((value - offset) / GRID_SIZE) * GRID_SIZE + offset
}

function ceilToGrid(value: number) {
  return Math.ceil(value / GRID_SIZE) * GRID_SIZE
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function truncateText(value: string, max = 140) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function summarizeCardForPrompt(card: Card): string {
  if (card.type === 'text') {
    const text = card.text?.trim() || ''
    return `text: "${truncateText(text || '<empty>')}"`
  }
  if (card.type === 'link') {
    const title = card.title?.trim() || card.url?.trim() || 'Link'
    const note = card.note?.trim()
    const noteText = note ? ` note: "${truncateText(note, 120)}"` : ''
    return `link: "${truncateText(title)}" url: ${card.url}${noteText}`
  }
  const src = card.src || ''
  return `image: ${truncateText(src || '<missing src>')}`
}

function summarizeBoardForPrompt(board: Board): string {
  const cardsById = new Map(board.cards.map((card) => [card.id, card]))
  const listedCardIds = new Set<string>()
  const lines: string[] = []
  lines.push(`Board name: ${board.name}`)
  lines.push(`Total cards: ${board.cards.length}`)
  lines.push(`Total columns: ${board.columns.length}`)

  if (board.columns.length) {
    lines.push('Columns:')
    for (const column of board.columns) {
      const cardSummaries = column.cardIds
        .map((id) => cardsById.get(id))
        .filter((card): card is Card => Boolean(card))
        .map((card) => {
          listedCardIds.add(card.id)
          return summarizeCardForPrompt(card)
        })
      const header = `- ${column.name || 'List'}`
      lines.push(header)
      if (cardSummaries.length) {
        for (const summary of cardSummaries) lines.push(`  - ${summary}`)
      } else {
        lines.push('  - <empty>')
      }
    }
  }

  const unlisted = board.cards.filter((card) => !listedCardIds.has(card.id))
  if (unlisted.length) {
    lines.push('Cards not in columns:')
    for (const card of unlisted) {
      lines.push(`- ${summarizeCardForPrompt(card)}`)
    }
  }

  return lines.join('\n')
}

function isAltDragEvent(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && 'altKey' in e && (e as { altKey?: boolean }).altKey)
}

function imageCardHeight(naturalWidth: number, naturalHeight: number) {
  if (!naturalWidth || !naturalHeight) return ceilToGrid(MIN_CARD_HEIGHT)
  const imageH = (CARD_WIDTH * naturalHeight) / naturalWidth
  return ceilToGrid(CARD_HEADER_HEIGHT + imageH)
}

function imageCardBaseHeight(card: ImageCard) {
  if (typeof card.naturalWidth === 'number' && typeof card.naturalHeight === 'number') {
    return imageCardHeight(card.naturalWidth, card.naturalHeight)
  }
  return ceilToGrid(card.height)
}

function linkCardBaseHeight(card: Pick<LinkCard, 'image'>) {
  return card.image ? LINK_CARD_HEIGHT_WITH_IMAGE : LINK_CARD_HEIGHT_NO_IMAGE
}

function linkNoteHeightFromTextarea(el: HTMLTextAreaElement) {
  return Math.max(LINK_NOTE_MIN_HEIGHT, el.scrollHeight)
}

function linkCardHeightFromParts(
  previewEl: HTMLDivElement | null,
  bodyEl: HTMLDivElement | null,
  noteEl: HTMLTextAreaElement | null,
) {
  if (!previewEl || !bodyEl) return null
  const previewHeight = previewEl.offsetHeight
  const bodyHeight = bodyEl.scrollHeight
  const total = CARD_HEADER_HEIGHT + previewHeight + bodyHeight + (noteEl ? 6 : 0) - (noteEl ? GRID_SIZE : 0)
  return ceilToGrid(total)
}

function imageCardHeightFromParts(baseHeight: number, bodyEl: HTMLDivElement | null) {
  if (!bodyEl) return null
  const bodyHeight = bodyEl.scrollHeight
  return ceilToGrid(baseHeight + bodyHeight)
}

function normalizeCard(card: Card): Card {
  const base = {
    ...card,
    x: snapToGrid(card.x, GRID_OFFSET),
    y: snapToGrid(card.y, GRID_OFFSET),
    width: CARD_WIDTH,
  }

  if (card.type === 'link') {
    const note = typeof card.note === 'string' ? card.note : ''
    const noteExpanded = Boolean(card.noteExpanded) || Boolean(note?.trim())
    const baseHeight = linkCardBaseHeight(card)
    let h = baseHeight
    if (noteExpanded) {
      const savedHeight = typeof card.height === 'number' ? card.height : baseHeight
      const minHeight = baseHeight + LINK_NOTE_MIN_HEIGHT + LINK_NOTE_BORDER_HEIGHT
      h = Math.max(minHeight, savedHeight)
    }
    return {
      ...base,
      height: h,
      url: card.url,
      title: card.title || card.url,
      image: card.image,
      siteName: card.siteName,
      note,
      noteExpanded,
    } as LinkCard
  }

  if (card.type === 'image') {
    const baseHeight = imageCardBaseHeight(card)
    const note = typeof card.note === 'string' ? card.note : ''
    const noteExpanded = Boolean(card.noteExpanded) || Boolean(note?.trim())
    let h = baseHeight
    if (noteExpanded) {
      const savedHeight = typeof card.height === 'number' ? ceilToGrid(card.height) : baseHeight
      const minHeight = baseHeight + IMAGE_NOTE_MIN_HEIGHT
      h = Math.max(minHeight, savedHeight)
    }
    return { ...base, height: h, note, noteExpanded } as ImageCard
  }

  return { ...base, height: Math.max(MIN_CARD_HEIGHT, ceilToGrid(card.height)) } as TextCard
}

function normalizeBoard(board: Board): Board {
  const columns = Array.isArray((board as Board).columns) ? board.columns : []
  return {
    ...board,
    columns: columns.map((c) => ({
      id: c.id,
      name: typeof (c as Column).name === 'string' ? (c as Column).name : 'List',
      x: snapToGrid(typeof c.x === 'number' && Number.isFinite(c.x) ? c.x : 0, GRID_OFFSET),
      y: snapToGrid(typeof c.y === 'number' && Number.isFinite(c.y) ? c.y : 0, GRID_OFFSET),
      width: typeof c.width === 'number' && Number.isFinite(c.width) ? c.width : CARD_WIDTH,
      gap: typeof c.gap === 'number' && Number.isFinite(c.gap) ? c.gap : COLUMN_GAP,
      cardIds: Array.isArray(c.cardIds) ? c.cardIds : [],
    })),
    cards: board.cards.map(normalizeCard),
  }
}

function cardHeightFromTextarea(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  const contentHeight = Math.max(MIN_TEXTAREA_HEIGHT, el.scrollHeight)
  // keep the textarea in sync with measured height so scrollHeight stays accurate
  el.style.height = `${contentHeight}px`
  return Math.max(MIN_CARD_HEIGHT, ceilToGrid(CARD_HEADER_HEIGHT + contentHeight))
}

function extractUrls(text: string): string[] {
  const matches = text.match(/\bhttps?:\/\/[^\s<>()]+/gi) ?? []
  const cleaned = matches
    .map((raw) => raw.replace(/[),.;!?]+$/g, ''))
    .filter((u) => u.length > 7)
  return Array.from(new Set(cleaned))
}

function readRecentBoards(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_BOARDS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeRecentBoards(ids: string[]) {
  try {
    window.localStorage.setItem(RECENT_BOARDS_KEY, JSON.stringify(ids))
  } catch {
    // ignore
  }
}

function readLastBoardId(): string | null {
  try {
    return window.localStorage.getItem(LAST_BOARD_KEY)
  } catch {
    return null
  }
}

function writeLastBoardId(id: string) {
  try {
    window.localStorage.setItem(LAST_BOARD_KEY, id)
  } catch {
    // ignore
  }
}

function readBackupEnabled(): boolean {
  try {
    return window.localStorage.getItem(BACKUP_ENABLED_KEY) === 'true'
  } catch {
    return false
  }
}

function writeBackupEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(BACKUP_ENABLED_KEY, enabled ? 'true' : 'false')
  } catch {
    // ignore
  }
}

function readBackupFolder(): string {
  try {
    return window.localStorage.getItem(BACKUP_FOLDER_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeBackupFolder(folder: string) {
  try {
    window.localStorage.setItem(BACKUP_FOLDER_KEY, folder)
  } catch {
    // ignore
  }
}

function nextUntitledName(list: BoardMeta[]): string {
  let max = 0
  for (const item of list) {
    if (!item?.name) continue
    const trimmed = item.name.trim()
    const lower = trimmed.toLowerCase()
    if (lower === 'untitled') {
      max = Math.max(max, 1)
      continue
    }
    const match = /^untitled\s+(\d+)$/i.exec(trimmed)
    if (!match) continue
    const num = Number(match[1])
    if (Number.isFinite(num)) max = Math.max(max, num)
  }
  return `Untitled ${max + 1}`
}


type Selection = {
  x0: number
  y0: number
  x1: number
  y1: number
}

type TrashedBoard = {
  id: string
  name: string
  deletedAt: number
}

type PendingBoardDelete = {
  id: string
  name: string
}

type PendingTrashEmpty = {
  pending: boolean
}

type UiNotice = {
  message: string
  actionLabel?: string
  onAction?: () => void
}

function layoutBoard(board: Board): Board {
  if (!board.columns.length) return board

  const byId = new Map(board.cards.map((c) => [c.id, c]))
  const nextById = new Map(byId)

  for (const col of board.columns) {
    let y = col.y
    for (const id of col.cardIds) {
      const c = nextById.get(id)
      if (!c) continue
      const needsUpdate = c.x !== col.x || c.y !== y || c.width !== CARD_WIDTH
      if (needsUpdate) {
        nextById.set(id, { ...c, x: col.x, y, width: CARD_WIDTH })
      }
      y += c.height + col.gap
    }
  }

  let changed = false
  const nextCards = board.cards.map((c) => {
    const n = nextById.get(c.id)!
    if (n !== c) changed = true
    return n
  })

  return changed ? { ...board, cards: nextCards } : board
}

function removeCardFromAllColumns(
  columns: Column[],
  cardId: string,
  keepEmptyColumnId?: string,
): Column[] {
  let changed = false
  const next = columns
    .map((c) => {
      if (!c.cardIds.includes(cardId)) return c
      changed = true
      return { ...c, cardIds: c.cardIds.filter((id) => id !== cardId) }
    })
    .filter((c) => c.cardIds.length > 0 || c.id === keepEmptyColumnId)

  return changed ? next : columns
}

function getCardColumnId(columns: Column[], cardId: string): string | null {
  for (const c of columns) {
    if (c.cardIds.includes(cardId)) return c.id
  }
  return null
}

function createColumnFromSelection(board: Board, selectedIds: string[]): Board {
  if (selectedIds.length < 1) return board

  const selectedSet = new Set(selectedIds)
  const selectedCards = board.cards.filter((c) => selectedSet.has(c.id))
  if (selectedCards.length < 1) return board

  const x = Math.min(...selectedCards.map((c) => c.x))
  const y = Math.min(...selectedCards.map((c) => c.y))

  // Order list items by visual position:
  // 1) y ascending (top → bottom)
  // 2) x ascending (left → right)
  // 3) board.cards array order (stable tie-break / creation order)
  const indexedSelected = board.cards
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => selectedSet.has(c.id))
    .sort((a, b) => {
      if (a.c.y !== b.c.y) return a.c.y - b.c.y
      if (a.c.x !== b.c.x) return a.c.x - b.c.x
      return a.idx - b.idx
    })

  const cardIds = indexedSelected.map(({ c }) => c.id)

  const newColumn: Column = {
    id: nanoid(),
    name: 'List',
    x: snapToGrid(x, GRID_OFFSET),
    y: snapToGrid(y, GRID_OFFSET),
    width: CARD_WIDTH,
    gap: COLUMN_GAP,
    cardIds,
  }

  // Remove these cards from any existing columns first.
  let nextColumns = board.columns ?? []
  for (const id of cardIds) {
    nextColumns = removeCardFromAllColumns(nextColumns, id)
  }
  nextColumns = [...nextColumns, newColumn]

  return layoutBoard({ ...board, columns: nextColumns })
}

function getColumnContentHeight(board: Board, col: Column): number {
  const byId = new Map(board.cards.map((c) => [c.id, c]))
  let total = 0
  let count = 0
  for (const id of col.cardIds) {
    const c = byId.get(id)
    if (!c) continue
    total += c.height
    count += 1
  }
  if (count <= 1) return total
  return total + col.gap * (count - 1)
}

type ColumnDrop = {
  columnId: string
  index: number
  lineY: number
}

type DupCardSnapshot =
  | { type: 'text'; text: string; height: number }
  | {
      type: 'image'
      src: string
      naturalWidth: number
      naturalHeight: number
      note?: string
      noteExpanded?: boolean
      height: number
    }
  | {
      type: 'link'
      url: string
      title: string
      image?: string
      siteName?: string
      note?: string
      noteExpanded?: boolean
      height: number
    }

type DupCardDrag = {
  sourceCardId: string
  sourceColumnId: string | null
  sourceIndex: number | null
  snapshot: { x: number; y: number } & DupCardSnapshot
}

type DupColumnCardSnapshot =
  | { id: string; type: 'text'; text: string; height: number }
  | {
      id: string
      type: 'image'
      src: string
      naturalWidth: number
      naturalHeight: number
      note?: string
      noteExpanded?: boolean
      height: number
    }
  | {
      id: string
      type: 'link'
      url: string
      title: string
      image?: string
      siteName?: string
      note?: string
      noteExpanded?: boolean
      height: number
    }

type DupColumnDrag = {
  sourceColumnId: string
  snapshot: Pick<Column, 'x' | 'y' | 'name' | 'gap' | 'width' | 'cardIds'>
  cardSnapshots: DupColumnCardSnapshot[]
}

type DupSelectionDrag = {
  cards: DupCardDrag[]
  columns: DupColumnDrag[]
}

function boardSignature(board: Board): string {
  const cards = [...board.cards]
    .map((c) =>
      c.type === 'text'
        ? { id: c.id, type: c.type, x: c.x, y: c.y, width: c.width, height: c.height, text: c.text }
          : c.type === 'image'
          ? {
              id: c.id,
              type: c.type,
              x: c.x,
              y: c.y,
              width: c.width,
              height: c.height,
              src: c.src,
              naturalWidth: c.naturalWidth,
              naturalHeight: c.naturalHeight,
              note: c.note,
              noteExpanded: c.noteExpanded,
            }
          : {
              id: c.id,
              type: c.type,
              x: c.x,
              y: c.y,
              width: c.width,
              height: c.height,
              url: c.url,
              title: c.title,
              image: c.image,
              siteName: c.siteName,
              note: c.note,
              noteExpanded: c.noteExpanded,
            },
    )
    .sort((a, b) => a.id.localeCompare(b.id))

  const columns = [...board.columns]
    .map((c) => ({
      id: c.id,
      name: c.name,
      x: c.x,
      y: c.y,
      width: c.width,
      gap: c.gap,
      cardIds: [...c.cardIds],
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  return JSON.stringify({ cards, columns })
}

function isHistoryDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem('lana_history_debug') === '1'
}

type DupGhost =
  | { kind: 'card'; snapshot: DupCardDrag }
  | { kind: 'column'; snapshot: DupColumnDrag }
  | { kind: 'selection'; snapshot: DupSelectionDrag }

type ListDetachPreview = {
  anchorId: string
  columnId: string
  cardIds: string[]
  initial: Record<string, { x: number; y: number }>
  deltaX: number
  deltaY: number
}

type Theme = 'dark' | 'light'
const THEME_KEY = 'lana_theme'

function dupColumnSnapshotContentHeight(dup: DupColumnDrag): number {
  const byId = new Map(dup.cardSnapshots.map((c) => [c.id, c]))
  let total = 0
  let count = 0
  for (const id of dup.snapshot.cardIds) {
    const c = byId.get(id)
    if (!c) continue
    total += c.height
    count += 1
  }
  if (count <= 1) return total
  return total + dup.snapshot.gap * (count - 1)
}

function injectDuplicateCard(board: Board, dup: DupCardDrag): Board {
  const newId = nanoid()
  const w = CARD_WIDTH
  const h = dup.snapshot.height

  const base = {
    id: newId,
    x: clamp(dup.snapshot.x, 0, BOARD_WIDTH - w),
    y: clamp(dup.snapshot.y, 0, BOARD_HEIGHT - h),
    width: w,
    height: h,
  }

  const nextCard: Card =
    dup.snapshot.type === 'image'
        ? ({
            ...base,
            type: 'image',
            src: dup.snapshot.src,
            naturalWidth: dup.snapshot.naturalWidth,
            naturalHeight: dup.snapshot.naturalHeight,
            note: dup.snapshot.note,
            noteExpanded: dup.snapshot.noteExpanded,
          } satisfies ImageCard)
      : dup.snapshot.type === 'link'
        ? ({
            ...base,
            type: 'link',
            url: dup.snapshot.url,
            title: dup.snapshot.title,
            image: dup.snapshot.image,
            siteName: dup.snapshot.siteName,
            note: dup.snapshot.note,
            noteExpanded: dup.snapshot.noteExpanded,
          } satisfies LinkCard)
        : ({
            ...base,
            type: 'text',
            text: dup.snapshot.text,
          } satisfies TextCard)

  let columns = board.columns ?? []
  if (dup.sourceColumnId) {
    const col = columns.find((c) => c.id === dup.sourceColumnId)
    if (col) {
      const idx = clamp(dup.sourceIndex ?? col.cardIds.length, 0, col.cardIds.length)
      columns = columns.map((c) =>
        c.id === dup.sourceColumnId
          ? { ...c, cardIds: [...c.cardIds.slice(0, idx), newId, ...c.cardIds.slice(idx)] }
          : c,
      )
    }
  }

  return layoutBoard({ ...board, columns, cards: [...board.cards, nextCard] })
}

function injectDuplicateColumn(board: Board, dup: DupColumnDrag): Board {
  const idMap = new Map<string, string>()
  const newCards: Card[] = []

  const byId = new Map(dup.cardSnapshots.map((c) => [c.id, c]))
  for (const oldId of dup.snapshot.cardIds) {
    const snap = byId.get(oldId)
    if (!snap) continue
    const newId = nanoid()
    idMap.set(oldId, newId)
    if (snap.type === 'image') {
      newCards.push({
        id: newId,
        type: 'image',
        x: dup.snapshot.x,
        y: dup.snapshot.y,
        width: CARD_WIDTH,
        height: snap.height,
        src: snap.src,
        naturalWidth: snap.naturalWidth,
        naturalHeight: snap.naturalHeight,
        note: snap.note,
        noteExpanded: snap.noteExpanded,
      } satisfies ImageCard)
    } else if (snap.type === 'link') {
      newCards.push({
        id: newId,
        type: 'link',
        x: dup.snapshot.x,
        y: dup.snapshot.y,
        width: CARD_WIDTH,
        height: snap.height,
        url: snap.url,
        title: snap.title,
        image: snap.image,
        siteName: snap.siteName,
        note: snap.note,
        noteExpanded: snap.noteExpanded,
      } satisfies LinkCard)
    } else {
      newCards.push({
        id: newId,
        type: 'text',
        x: dup.snapshot.x,
        y: dup.snapshot.y,
        width: CARD_WIDTH,
        height: snap.height,
        text: snap.text,
      } satisfies TextCard)
    }
  }

  const newColumn: Column = {
    id: nanoid(),
    name: dup.snapshot.name || 'List',
    x: dup.snapshot.x,
    y: dup.snapshot.y,
    width: CARD_WIDTH,
    gap: dup.snapshot.gap,
    cardIds: dup.snapshot.cardIds.map((oldId) => idMap.get(oldId)).filter(Boolean) as string[],
  }

  return layoutBoard({
    ...board,
    columns: [...(board.columns ?? []), newColumn],
    cards: [...board.cards, ...newCards],
  })
}

function injectDuplicateSelection(board: Board, dup: DupSelectionDrag): Board {
  let next = board

  for (const c of dup.columns) {
    next = injectDuplicateColumn(next, c)
  }

  if (!dup.cards.length) return next

  const newCards: Card[] = []
  const perColumn = new Map<string, Map<string, string>>() // colId -> (oldId -> newId)

  for (const c of dup.cards) {
    const newId = nanoid()
    if (c.snapshot.type === 'image') {
      newCards.push({
        id: newId,
        type: 'image',
        x: clamp(c.snapshot.x, 0, BOARD_WIDTH - CARD_WIDTH),
        y: clamp(c.snapshot.y, 0, BOARD_HEIGHT - c.snapshot.height),
        width: CARD_WIDTH,
        height: c.snapshot.height,
        src: c.snapshot.src,
        naturalWidth: c.snapshot.naturalWidth,
        naturalHeight: c.snapshot.naturalHeight,
        note: c.snapshot.note,
        noteExpanded: c.snapshot.noteExpanded,
      } satisfies ImageCard)
    } else if (c.snapshot.type === 'link') {
      newCards.push({
        id: newId,
        type: 'link',
        x: clamp(c.snapshot.x, 0, BOARD_WIDTH - CARD_WIDTH),
        y: clamp(c.snapshot.y, 0, BOARD_HEIGHT - c.snapshot.height),
        width: CARD_WIDTH,
        height: c.snapshot.height,
        url: c.snapshot.url,
        title: c.snapshot.title,
        image: c.snapshot.image,
        siteName: c.snapshot.siteName,
        note: c.snapshot.note,
        noteExpanded: c.snapshot.noteExpanded,
      } satisfies LinkCard)
    } else {
      newCards.push({
        id: newId,
        type: 'text',
        x: clamp(c.snapshot.x, 0, BOARD_WIDTH - CARD_WIDTH),
        y: clamp(c.snapshot.y, 0, BOARD_HEIGHT - c.snapshot.height),
        width: CARD_WIDTH,
        height: c.snapshot.height,
        text: c.snapshot.text,
      } satisfies TextCard)
    }

    if (c.sourceColumnId) {
      if (!perColumn.has(c.sourceColumnId)) perColumn.set(c.sourceColumnId, new Map())
      perColumn.get(c.sourceColumnId)!.set(c.sourceCardId, newId)
    }
  }

  const columns = (next.columns ?? []).map((col) => {
    const map = perColumn.get(col.id)
    if (!map) return col
    return {
      ...col,
      // Insert duplicates in a stable way: [dup, original] for each duplicated original.
      cardIds: col.cardIds.flatMap((id) => {
        const dupId = map.get(id)
        return dupId ? [dupId, id] : [id]
      }),
    }
  })

  return layoutBoard({ ...next, columns, cards: [...next.cards, ...newCards] })
}

function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem(THEME_KEY) : null
    if (saved === 'light' || saved === 'dark') return saved
    const prefersLight =
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-color-scheme: light)').matches
        : false
    return prefersLight ? 'light' : 'dark'
  })
  const [assetsDir, setAssetsDir] = useState<string | null>(null)
  const [uiNotice, setUiNotice] = useState<UiNotice | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [boards, setBoards] = useState<BoardMeta[]>([])
  const [trashedBoards, setTrashedBoards] = useState<TrashedBoard[]>([])
  const [pendingBoardDelete, setPendingBoardDelete] = useState<PendingBoardDelete | null>(null)
  const [pendingTrashEmpty, setPendingTrashEmpty] = useState<PendingTrashEmpty | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'backup' | 'chat'>('backup')
  const [backupEnabled, setBackupEnabled] = useState<boolean>(() => readBackupEnabled())
  const [backupFolder, setBackupFolder] = useState<string>(() => readBackupFolder())
  const backupInProgressRef = useRef(false)
  const backupPromiseRef = useRef<Promise<void> | null>(null)
  const closingAfterBackupRef = useRef(false)
  const closeUnlistenRef = useRef<(() => void) | null>(null)
  const missingBackupNoticeRef = useRef(false)
  const [isBackupClosing, setIsBackupClosing] = useState(false)
  const [backupSuccessAt, setBackupSuccessAt] = useState<number | null>(null)
  const layoutResetPendingRef = useRef(false)
  const [currentBoardId, setCurrentBoardId] = useState<string | null>(null)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [isCardInteracting, setIsCardInteracting] = useState(false)
  const [isSelecting, setIsSelecting] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null)
  const selectionStartClientRef = useRef<{ x: number; y: number } | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedIdsRef = useRef<string[]>([])
  const [selectedColumnIds, setSelectedColumnIds] = useState<string[]>([])
  const selectedColumnIdsRef = useRef<string[]>([])
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null)
  const [editingColumnName, setEditingColumnName] = useState('')
  const editingColumnInputRef = useRef<HTMLInputElement | null>(null)
  const [isEditingBoardName, setIsEditingBoardName] = useState(false)
  const [editingBoardName, setEditingBoardName] = useState('')
  const editingBoardNameInputRef = useRef<HTMLInputElement | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [chatInputByBoard, setChatInputByBoard] = useState<Record<string, string>>({})
  const [chatByBoard, setChatByBoard] = useState<Record<string, ChatEntry[]>>({})
  const [chatSummaryByBoard, setChatSummaryByBoard] = useState<Record<string, string>>({})
  const [chatSummaryUpToByBoard, setChatSummaryUpToByBoard] = useState<Record<string, number>>({})
  const [chatSessionIdByBoard, setChatSessionIdByBoard] = useState<Record<string, string>>({})
  const [pendingChatSessionNoteByBoard, setPendingChatSessionNoteByBoard] = useState<Record<string, boolean>>({})
  const [recentBoardIds, setRecentBoardIds] = useState<string[]>(() =>
    typeof window === 'undefined' ? [] : readRecentBoards(),
  )
  const [chatStatus, setChatStatus] = useState<'idle' | 'sending' | 'error'>('idle')
  const [chatError, setChatError] = useState<string | null>(null)
  const [chatModel, setChatModel] = useState(DEFAULT_OLLAMA_MODEL)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const [dupGhost, setDupGhost] = useState<DupGhost | null>(null)
  const [listDetachPreview, setListDetachPreview] = useState<ListDetachPreview | null>(null)
  const listDetachPreviewRafRef = useRef<number | null>(null)
  const pendingListDetachPreviewRef = useRef<ListDetachPreview | null>(null)
  const [columnHeaderHeights, setColumnHeaderHeights] = useState<Record<string, number>>({})
  const columnTitleMeasureElRef = useRef<HTMLDivElement | null>(null)
  const selectionDragRef = useRef<
    | null
    | {
        anchorType: 'card' | 'column'
        anchorId: string
        startContentX: number
        startContentY: number
        initialCards: Record<string, { x: number; y: number }>
        initialColumns: Record<string, { x: number; y: number }>
        bounds: { minX: number; minY: number; maxX: number; maxY: number }
      }
  >(null)
  const isSpaceDownRef = useRef(false)
  const [zoomScale, setZoomScale] = useState(1)
  const zoomScaleRef = useRef(1)
  const [panZoomEl, setPanZoomEl] = useState<HTMLDivElement | null>(null)
  const transformRef = useRef<
    | null
    | {
        instance: { wrapperComponent: HTMLDivElement | null }
        state: { scale: number; positionX: number; positionY: number }
        setTransform: (
          newPositionX: number,
          newPositionY: number,
          newScale: number,
          animationTime?: number,
        ) => void
      }
  >(null)
  const transformStateRef = useRef({ scale: 1, positionX: 0, positionY: 0 })
  const middlePanRef = useRef<{ x: number; y: number } | null>(null)
  const columnDragRafRef = useRef<number | null>(null)
  const pendingColumnDragRef = useRef<{ columnId: string; x: number; y: number } | null>(null)
  const [columnDrop, setColumnDrop] = useState<ColumnDrop | null>(null)
  const columnDropRafRef = useRef<number | null>(null)
  const pendingColumnDropRef = useRef<ColumnDrop | null>(null)
  const textareaByIdRef = useRef(new Map<string, HTMLTextAreaElement>())
  const linkNoteTextareaByIdRef = useRef(new Map<string, HTMLTextAreaElement>())
  const linkCardPreviewByIdRef = useRef(new Map<string, HTMLDivElement>())
  const linkCardBodyByIdRef = useRef(new Map<string, HTMLDivElement>())
  const imageCardPreviewByIdRef = useRef(new Map<string, HTMLDivElement>())
  const imageCardBodyByIdRef = useRef(new Map<string, HTMLDivElement>())
  const imageNoteTextareaByIdRef = useRef(new Map<string, HTMLTextAreaElement>())
  const dupCardDragRef = useRef<DupCardDrag | null>(null)
  const dupColumnDragRef = useRef<DupColumnDrag | null>(null)
  const listDetachDragRef = useRef<
    | null
    | {
        anchorId: string
        columnId: string
        cardIds: string[]
        initial: Record<string, { x: number; y: number }>
      }
  >(null)
  const dupSelectionRef = useRef<
    | null
    | {
        ownerType: 'card' | 'column'
        ownerId: string
        snapshot: DupSelectionDrag
      }
  >(null)

  const skipNextAutosaveRef = useRef(true)
  const skipNextHistoryCommitRef = useRef(false)
  const skipHistoryCommitsRef = useRef(0)
  const autosaveDelayMs = 400
  const historyDebounceMs = 500
  const maxHistory = 200

  const historyRef = useRef<{ undo: Board[]; redo: Board[] }>({ undo: [], redo: [] })
  const committedBoardRef = useRef<Board | null>(null)
  const boardRef = useRef<Board | null>(null)
  const historyTimerRef = useRef<number | null>(null)
  const isApplyingHistoryRef = useRef(false)
  const wasInteractingRef = useRef(false)
  const chatSessionIdRef = useRef<string>(nanoid())

  const sortedBoards = useMemo(() => {
    if (!recentBoardIds.length) return [...boards].sort((a, b) => b.updatedAt - a.updatedAt)
    const index = new Map(recentBoardIds.map((id, i) => [id, i]))
    return [...boards].sort((a, b) => {
      const ia = index.get(a.id)
      const ib = index.get(b.id)
      if (ia != null && ib != null) return ia - ib
      if (ia != null) return -1
      if (ib != null) return 1
      return b.updatedAt - a.updatedAt
    })
  }, [boards, recentBoardIds])

  const currentChatMessages = currentBoardId ? (chatByBoard[currentBoardId] ?? []) : []
  const currentChatInput = currentBoardId ? (chatInputByBoard[currentBoardId] ?? '') : ''
  const currentChatSummary = currentBoardId ? (chatSummaryByBoard[currentBoardId] ?? '') : ''
  const currentChatSummaryUpTo = currentBoardId ? (chatSummaryUpToByBoard[currentBoardId] ?? 0) : 0

  function commitTransform(positionX: number, positionY: number, scale: number, animationTime = 0) {
    const controller = transformRef.current
    if (!controller) return
    controller.setTransform(positionX, positionY, scale, animationTime)
    transformStateRef.current = { scale, positionX, positionY }
    if (Math.abs(scale - zoomScaleRef.current) > 0.0001) {
      zoomScaleRef.current = scale
      setZoomScale(scale)
    }
  }

  function startEditingTextCard(id: string) {
    setEditingTextId(id)
    window.requestAnimationFrame(() => {
      const el = textareaByIdRef.current.get(id)
      if (!el) return
      el.style.height = 'auto'
      const contentHeight = Math.max(MIN_TEXTAREA_HEIGHT, el.scrollHeight)
      el.style.height = `${contentHeight}px`
      try {
        el.focus({ preventScroll: true })
      } catch {
        el.focus()
      }
      const len = el.value.length
      try {
        el.setSelectionRange(len, len)
      } catch {
        // ignore
      }
    })
  }

  function markBoardAsRecent(boardId: string) {
    setRecentBoardIds((prev) => {
      const next = [boardId, ...prev.filter((id) => id !== boardId)]
      writeRecentBoards(next)
      return next
    })
    writeLastBoardId(boardId)
  }

  const loadBoardById = useCallback(async (boardId: string) => {
    setStatus('loading')
    setError(null)

    try {
      getAssetsDir(boardId)
        .then((dir) => {
          setAssetsDir(dir)
        })
        .catch(() => {
          setAssetsDir(null)
        })

      layoutResetPendingRef.current = true
      const wrapper = transformRef.current?.instance.wrapperComponent ?? panZoomEl
      if (wrapper) {
        const scale = 1
        const x = wrapper.clientWidth / 2 - BOARD_START_X * scale
        const y = wrapper.clientHeight / 2 - BOARD_START_Y * scale
        commitTransform(x, y, scale, 0)
        layoutResetPendingRef.current = false
      } else {
        window.requestAnimationFrame(() => {
          const nextWrapper = transformRef.current?.instance.wrapperComponent ?? panZoomEl
          if (!nextWrapper) {
            layoutResetPendingRef.current = false
            return
          }
          const scale = 1
          const x = nextWrapper.clientWidth / 2 - BOARD_START_X * scale
          const y = nextWrapper.clientHeight / 2 - BOARD_START_Y * scale
          commitTransform(x, y, scale, 0)
          layoutResetPendingRef.current = false
        })
      }

      const loaded = await loadBoard(boardId)
      const normalized = normalizeBoard(loaded)
      const withLayout = layoutBoard(normalized)
      skipNextAutosaveRef.current = JSON.stringify(loaded) === JSON.stringify(withLayout)
      setBoard(withLayout)
      setCurrentBoardId(boardId)
      markBoardAsRecent(boardId)
      setSelectionIds([])
      setColumnSelectionIds([])
      setEditingColumnId(null)
      setEditingColumnName('')
      setIsEditingBoardName(false)
      setEditingBoardName('')
      setStatus('ready')

      loadChat(boardId)
        .then((chat) => {
          const sessionId = chatSessionIdRef.current
          const nextMessages = chat.messages ?? []
          const hadMessages = nextMessages.length > 0
          const lastSessionId = chat.lastSessionId
          const isNewSession = hadMessages && lastSessionId !== sessionId

          setChatByBoard((prev) => ({ ...prev, [boardId]: nextMessages }))
          setChatSummaryByBoard((prev) => ({ ...prev, [boardId]: chat.summary ?? '' }))
          setChatSummaryUpToByBoard((prev) => ({ ...prev, [boardId]: chat.summaryUpTo ?? 0 }))
          setChatSessionIdByBoard((prev) => ({ ...prev, [boardId]: sessionId }))
          setPendingChatSessionNoteByBoard((prev) => ({ ...prev, [boardId]: isNewSession }))
        })
        .catch((err) => {
          console.error('chat load failed', err)
        })
    } catch (e) {
      setStatus('error')
      setError(String(e))
    }
  }, [])

  const flashNotice = useCallback((message: string, actionLabel?: string, onAction?: () => void) => {
    setUiNotice({ message, actionLabel, onAction })
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setUiNotice(null)
    }, 4500)
  }, [])

  const openBackupSettings = useCallback(() => {
    setSettingsTab('backup')
    setIsSettingsOpen(true)
  }, [])

  const openChatSettings = useCallback(() => {
    setSettingsTab('chat')
    setIsSettingsOpen(true)
  }, [])

  const createNewBoard = useCallback(async () => {
    const listed = await listBoards()
    const name = nextUntitledName(listed)
    const created = await createBoard(name)
    setBoards([...listed, created])
    await loadBoardById(created.id)
    setIsDrawerOpen(false)
  }, [loadBoardById])

  const switchBoard = useCallback(
    async (boardId: string) => {
      if (boardId === currentBoardId) {
        setIsDrawerOpen(false)
        return
      }

      if (board && currentBoardId) {
        try {
          await saveBoard(currentBoardId, board)
        } catch (e) {
          console.error('save before switch failed', e)
        }
      }

      await loadBoardById(boardId)
      setIsDrawerOpen(false)
    },
    [board, currentBoardId, loadBoardById],
  )

  const removeBoard = useCallback(
    async (boardId: string) => {
      const order = sortedBoards.map((b) => b.id)
      const idx = order.indexOf(boardId)
      const nextInOrder =
        idx >= 0 ? order[idx + 1] ?? order[idx - 1] ?? null : order[0] ?? null
      const nextBoards = boards.filter((b) => b.id !== boardId)
      await deleteBoard(boardId)

      setBoards(nextBoards)
      const trashed = await listTrashedBoards()
      setTrashedBoards(
        trashed
          .filter((b) => typeof b.deletedAt === 'number')
          .map((b) => ({ id: b.id, name: b.name, deletedAt: b.deletedAt as number })),
      )
      flashNotice('Board moved to Trash.')
      setRecentBoardIds((prev) => {
        const filtered = prev.filter((id) => id !== boardId)
        writeRecentBoards(filtered)
        return filtered
      })

      if (boardId !== currentBoardId) return
      if (nextInOrder && nextBoards.some((b) => b.id === nextInOrder)) {
        await loadBoardById(nextInOrder)
        return
      }
      if (nextBoards.length) {
        await loadBoardById(nextBoards[0].id)
        return
      }

      const created = await createBoard('Untitled 1')
      setBoards([created])
      await loadBoardById(created.id)
    },
    [boards, createBoard, currentBoardId, flashNotice, loadBoardById, sortedBoards],
  )

  const confirmBoardDelete = useCallback(async () => {
    if (!pendingBoardDelete) return
    const { id } = pendingBoardDelete
    setPendingBoardDelete(null)
    await removeBoard(id)
  }, [pendingBoardDelete, removeBoard])

  const cancelBoardDelete = useCallback(() => {
    setPendingBoardDelete(null)
  }, [])

  const restoreTrashedBoard = useCallback(
    async (trashed: TrashedBoard) => {
      await restoreBoard(trashed.id)
      const [listed, trash] = await Promise.all([listBoards(), listTrashedBoards()])
      setBoards(listed)
      setTrashedBoards(
        trash
          .filter((b) => typeof b.deletedAt === 'number')
          .map((b) => ({ id: b.id, name: b.name, deletedAt: b.deletedAt as number })),
      )
      flashNotice(`Restored "${trashed.name}".`)
      await loadBoardById(trashed.id)
    },
    [flashNotice, loadBoardById],
  )

  const handleEmptyTrash = useCallback(async () => {
    await emptyTrash()
    setTrashedBoards([])
    flashNotice('Trash emptied.')
  }, [flashNotice])

  const confirmEmptyTrash = useCallback(async () => {
    setPendingTrashEmpty(null)
    await handleEmptyTrash()
  }, [handleEmptyTrash])

  const cancelEmptyTrash = useCallback(() => {
    setPendingTrashEmpty(null)
  }, [])

  const chooseBackupFolder = useCallback(async () => {
    if (!backupEnabled) return
    try {
      if (isTauri()) {
        const selected = await open({ directory: true, multiple: false })
        if (typeof selected === 'string') {
          setBackupFolder(selected)
          return
        }
        if (Array.isArray(selected) && selected[0]) {
          setBackupFolder(selected[0])
          return
        }
      }
      const manual = window.prompt('Enter backup folder path', backupFolder)
      if (manual != null) setBackupFolder(manual.trim())
    } catch (err) {
      console.error('backup folder picker failed', err)
    }
  }, [backupEnabled, backupFolder])

  const runBackup = useCallback(
    async (reason: 'interval' | 'close' | 'manual') => {
      if (!backupEnabled || !backupFolder || !isTauri()) return
      if (backupInProgressRef.current) {
        if (backupPromiseRef.current) {
          await backupPromiseRef.current
        }
        return
      }
      backupInProgressRef.current = true
      const promise = (async () => {
        try {
          await createBackup(backupFolder)
          if (reason === 'manual') {
            setBackupSuccessAt(Date.now())
          }
        } catch (err) {
          console.error('backup failed', err)
          if (backupEnabled && backupFolder) {
            flashNotice(
              'unable to save to backup folder',
              'Open backup settings',
              () => openBackupSettings(),
            )
          }
          if (reason === 'close') {
            // allow close to proceed even on failure
          }
        }
      })()
      backupPromiseRef.current = promise
      try {
        await promise
      } finally {
        backupInProgressRef.current = false
        backupPromiseRef.current = null
      }
    },
    [backupEnabled, backupFolder, flashNotice, openBackupSettings],
  )

  useEffect(() => {
    if (!backupSuccessAt) return
    const t = window.setTimeout(() => {
      setBackupSuccessAt(null)
    }, 3000)
    return () => window.clearTimeout(t)
  }, [backupSuccessAt])

  const columnTitleKey = useMemo(() => {
    if (!board) return ''
    return (board.columns ?? []).map((c) => `${c.id}:${c.name ?? ''}`).join('|')
  }, [board])

  function getColumnHeaderHeight(colId: string) {
    return columnHeaderHeights[colId] ?? COLUMN_HEADER_HEIGHT
  }

  function getColumnTitleMeasureEl() {
    let el = columnTitleMeasureElRef.current
    if (el) return el
    el = document.createElement('div')
    el.className = 'columnTitle'
    el.style.position = 'absolute'
    el.style.left = '-10000px'
    el.style.top = '-10000px'
    el.style.visibility = 'hidden'
    el.style.pointerEvents = 'none'
    el.style.whiteSpace = 'normal'
    el.style.wordBreak = 'break-word'
    el.style.lineHeight = '1.2'
    document.body.appendChild(el)
    columnTitleMeasureElRef.current = el
    return el
  }

  function measureColumnHeaderHeight(title: string) {
    const el = getColumnTitleMeasureEl()
    el.textContent = title || 'List'
    // Column widget width is CARD_WIDTH + 2*COLUMN_PADDING, header has 0 10px padding.
    el.style.width = `${CARD_WIDTH + COLUMN_PADDING * 2 - 20}px`
    const titleH = el.scrollHeight
    const totalH = Math.ceil(titleH + COLUMN_HEADER_PADDING_Y * 2)
    return Math.max(COLUMN_HEADER_HEIGHT, ceilToGrid(totalH))
  }

  function computeContentBounds(boardForBounds: Board) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const col of boardForBounds.columns ?? []) {
      const b = columnWidgetBounds(boardForBounds, col)
      minX = Math.min(minX, b.left)
      minY = Math.min(minY, b.top)
      maxX = Math.max(maxX, b.right)
      maxY = Math.max(maxY, b.bottom)
    }

    for (const c of boardForBounds.cards ?? []) {
      minX = Math.min(minX, c.x)
      minY = Math.min(minY, c.y)
      maxX = Math.max(maxX, c.x + CARD_WIDTH)
      maxY = Math.max(maxY, c.y + c.height)
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null
    }
    return { left: minX, top: minY, right: maxX, bottom: maxY }
  }

  useEffect(() => {
    return () => {
      if (columnTitleMeasureElRef.current) {
        columnTitleMeasureElRef.current.remove()
        columnTitleMeasureElRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!backupEnabled || !backupFolder || !isTauri()) return
    const interval = window.setInterval(() => {
      void runBackup('interval')
    }, 10 * 60 * 1000)
    return () => window.clearInterval(interval)
  }, [backupEnabled, backupFolder, runBackup])

  useEffect(() => {
    if (!isTauri()) return
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (!backupEnabled || !backupFolder) return
        if (closingAfterBackupRef.current) {
          event.preventDefault()
          return
        }
        event.preventDefault()
        closingAfterBackupRef.current = true
        let overlayTimer: number | null = null
        overlayTimer = window.setTimeout(() => {
          setIsBackupClosing(true)
        }, 500)
        try {
          await runBackup('close')
          try {
            await cleanupAssets()
          } catch (err) {
            console.error('asset cleanup failed', err)
          }
          if (closeUnlistenRef.current) {
            closeUnlistenRef.current()
            closeUnlistenRef.current = null
          }
          await getCurrentWindow().destroy()
        } finally {
          if (overlayTimer) window.clearTimeout(overlayTimer)
          setIsBackupClosing(false)
          closingAfterBackupRef.current = false
        }
      })
      .then((fn) => {
        closeUnlistenRef.current = fn
      })
      .catch((err) => {
        console.error('close handler failed', err)
      })

    return () => {
      if (closeUnlistenRef.current) {
        closeUnlistenRef.current()
        closeUnlistenRef.current = null
      }
    }
  }, [backupEnabled, backupFolder, runBackup])

  useEffect(() => {
    if (!board || !currentBoardId) return

    const next: Record<string, number> = {}
    for (const col of board.columns ?? []) {
      const title = editingColumnId === col.id ? editingColumnName : col.name || 'List'
      next[col.id] = measureColumnHeaderHeight(title)
    }

    setColumnHeaderHeights((prev) => {
      const prevKeys = Object.keys(prev)
      const nextKeys = Object.keys(next)
      if (prevKeys.length !== nextKeys.length) return next
      for (const k of nextKeys) if (prev[k] !== next[k]) return next
      return prev
    })
  }, [columnTitleKey, editingColumnId, editingColumnName])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('theme-light', theme === 'light')
    root.classList.toggle('theme-dark', theme === 'dark')
    try {
      window.localStorage.setItem(THEME_KEY, theme)
    } catch {
      // ignore
    }
  }, [theme])

  useEffect(() => {
    writeBackupEnabled(backupEnabled)
  }, [backupEnabled])

  useEffect(() => {
    writeBackupFolder(backupFolder)
  }, [backupFolder])

  useEffect(() => {
    if (!backupEnabled) {
      missingBackupNoticeRef.current = false
      return
    }
    if (!backupFolder) {
      if (!missingBackupNoticeRef.current) {
        flashNotice('no backup folder chosen, not backing up')
        missingBackupNoticeRef.current = true
      }
      return
    }
    missingBackupNoticeRef.current = false
  }, [backupEnabled, backupFolder, flashNotice])

  function setColumnSelectionIds(next: string[]) {
    selectedColumnIdsRef.current = next
    setSelectedColumnIds(next)
  }

  function isTypingTarget(el: HTMLElement | null) {
    return (
      el != null &&
      (el.tagName === 'TEXTAREA' ||
        el.tagName === 'INPUT' ||
        el.isContentEditable ||
        el.getAttribute('role') === 'textbox')
    )
  }

  function scheduleListDetachPreview(next: ListDetachPreview | null) {
    pendingListDetachPreviewRef.current = next
    if (listDetachPreviewRafRef.current) return
    listDetachPreviewRafRef.current = window.requestAnimationFrame(() => {
      listDetachPreviewRafRef.current = null
      setListDetachPreview(pendingListDetachPreviewRef.current)
    })
  }

  function computeSelectionDragDelta(
    sd: NonNullable<typeof selectionDragRef.current>,
    deltaX: number,
    deltaY: number,
    snap: boolean,
  ) {
    // Clamp the delta so the whole selection stays within the fixed board bounds.
    let dx = clamp(deltaX, -sd.bounds.minX, BOARD_WIDTH - sd.bounds.maxX)
    let dy = clamp(deltaY, -sd.bounds.minY, BOARD_HEIGHT - sd.bounds.maxY)

    const anchorInitial =
      sd.anchorType === 'card' ? sd.initialCards[sd.anchorId] : sd.initialColumns[sd.anchorId]
    if (anchorInitial) {
      const anchorFinal = { x: anchorInitial.x + dx, y: anchorInitial.y + dy }
      if (snap) {
        dx += snapToGrid(anchorFinal.x, GRID_OFFSET) - anchorFinal.x
        dy += snapToGrid(anchorFinal.y, GRID_OFFSET) - anchorFinal.y
        dx = clamp(dx, -sd.bounds.minX, BOARD_WIDTH - sd.bounds.maxX)
        dy = clamp(dy, -sd.bounds.minY, BOARD_HEIGHT - sd.bounds.maxY)
      }
    }

    return { dx, dy }
  }

  function buildDupSelectionSnapshot(board: Board, ownerCardId?: string, ownerColumnId?: string) {
    const selectedCards = selectedIdsRef.current
    const selectedColumns = selectedColumnIdsRef.current

    const wantsSelection =
      (ownerCardId != null && selectedCards.includes(ownerCardId)) ||
      (ownerColumnId != null && selectedColumns.includes(ownerColumnId))

    if (!wantsSelection) return null

    const columns: DupColumnDrag[] = []
    const selectedColumnSet = new Set(selectedColumns)

    for (const colId of selectedColumns) {
      const col = (board.columns ?? []).find((c) => c.id === colId)
      if (!col) continue
      columns.push({
        sourceColumnId: col.id,
        snapshot: {
          x: col.x,
          y: col.y,
          name: col.name || 'List',
          gap: col.gap,
          width: col.width,
          cardIds: [...col.cardIds],
        },
        cardSnapshots: (board.cards ?? [])
          .filter((c) => col.cardIds.includes(c.id))
          .map((c) =>
            c.type === 'image'
                ? ({
                    id: c.id,
                    type: 'image',
                    src: c.src,
                    naturalWidth: c.naturalWidth,
                    naturalHeight: c.naturalHeight,
                    note: c.note,
                    noteExpanded: c.noteExpanded,
                    height: c.height,
                  } satisfies DupColumnCardSnapshot)
              : c.type === 'link'
                ? ({
                    id: c.id,
                    type: 'link',
                    url: c.url,
                    title: c.title,
                    image: c.image,
                    siteName: c.siteName,
                    note: c.note,
                    noteExpanded: c.noteExpanded,
                    height: c.height,
                  } satisfies DupColumnCardSnapshot)
                : ({
                    id: c.id,
                    type: 'text',
                    text: c.text,
                    height: c.height,
                  } satisfies DupColumnCardSnapshot),
          ),
      })
    }

    const cards: DupCardDrag[] = []
    for (const id of selectedCards) {
      const c = board.cards.find((x) => x.id === id)
      if (!c) continue
      const sourceColumnId = getCardColumnId(board.columns ?? [], id)
      if (sourceColumnId && selectedColumnSet.has(sourceColumnId)) {
        continue
      }
      const sourceIndex =
        sourceColumnId != null
          ? (board.columns ?? []).find((col) => col.id === sourceColumnId)?.cardIds.indexOf(id) ?? null
          : null

      cards.push({
        sourceCardId: id,
        sourceColumnId,
        sourceIndex,
        snapshot:
          c.type === 'image'
            ? {
                type: 'image',
                x: c.x,
                y: c.y,
                height: c.height,
                src: c.src,
                naturalWidth: c.naturalWidth,
                naturalHeight: c.naturalHeight,
                note: c.note,
                noteExpanded: c.noteExpanded,
              }
            : c.type === 'link'
              ? {
                  type: 'link',
                  x: c.x,
                  y: c.y,
                  height: c.height,
                  url: c.url,
                  title: c.title,
                  image: c.image,
                  siteName: c.siteName,
                  note: c.note,
                  noteExpanded: c.noteExpanded,
                }
              : { type: 'text', x: c.x, y: c.y, height: c.height, text: c.text },
      })
    }

    if (!cards.length && !columns.length) return null
    return { cards, columns } satisfies DupSelectionDrag
  }

  function commitHistory(next: Board) {
    const committed = committedBoardRef.current
    if (!committed) {
      committedBoardRef.current = next
      historyRef.current = { undo: [], redo: [] }
      return
    }

    // Cheap-ish deep equality for MVP to avoid duplicate commits.
    if (JSON.stringify(committed) === JSON.stringify(next)) return

    const undo = historyRef.current.undo
    const nextUndo = [...undo, committed]
    historyRef.current = {
      undo: nextUndo.length > maxHistory ? nextUndo.slice(nextUndo.length - maxHistory) : nextUndo,
      redo: [],
    }
    committedBoardRef.current = next
    if (isHistoryDebugEnabled()) {
      console.debug('[history] commit', {
        undoDepth: historyRef.current.undo.length,
        redoDepth: historyRef.current.redo.length,
        committedSig: boardSignature(next),
      })
    }
  }

  function scheduleHistoryCommit(next: Board) {
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current)
    historyTimerRef.current = window.setTimeout(() => {
      historyTimerRef.current = null
      commitHistory(next)
    }, historyDebounceMs)
  }

  function clearPendingHistoryCommit() {
    if (historyTimerRef.current) {
      window.clearTimeout(historyTimerRef.current)
      historyTimerRef.current = null
    }
  }

  function commitHistoryNow(next: Board) {
    clearPendingHistoryCommit()
    commitHistory(next)
  }

  function undo() {
    const committed = committedBoardRef.current
    if (!committed) return
    let undoStack = historyRef.current.undo
    if (!undoStack.length) return

    clearPendingHistoryCommit()
    const committedSig = boardSignature(committed)
    let prev = undoStack[undoStack.length - 1]
    while (prev && boardSignature(prev) === committedSig) {
      undoStack = undoStack.slice(0, -1)
      prev = undoStack[undoStack.length - 1]
    }
    if (!prev) return
    historyRef.current = {
      undo: undoStack.slice(0, -1),
      redo: [...historyRef.current.redo, committed],
    }
    committedBoardRef.current = prev
    isApplyingHistoryRef.current = true
    setSelectionIds([])
    setColumnSelectionIds([])
    setBoard(prev)
    if (isHistoryDebugEnabled()) {
      console.debug('[history] undo', {
        undoDepth: historyRef.current.undo.length,
        redoDepth: historyRef.current.redo.length,
        committedSig: committedSig,
        nextSig: boardSignature(prev),
      })
    }
  }

  function redo() {
    const committed = committedBoardRef.current
    if (!committed) return
    let redoStack = historyRef.current.redo
    if (!redoStack.length) return

    clearPendingHistoryCommit()
    const committedSig = boardSignature(committed)
    let next = redoStack[redoStack.length - 1]
    while (next && boardSignature(next) === committedSig) {
      redoStack = redoStack.slice(0, -1)
      next = redoStack[redoStack.length - 1]
    }
    if (!next) return
    historyRef.current = {
      undo: [...historyRef.current.undo, committed],
      redo: redoStack.slice(0, -1),
    }
    committedBoardRef.current = next
    isApplyingHistoryRef.current = true
    setSelectionIds([])
    setColumnSelectionIds([])
    setBoard(next)
    if (isHistoryDebugEnabled()) {
      console.debug('[history] redo', {
        undoDepth: historyRef.current.undo.length,
        redoDepth: historyRef.current.redo.length,
        committedSig: committedSig,
        nextSig: boardSignature(next),
      })
    }
  }

  function deleteSelection() {
    const cardIds = selectedIdsRef.current
    const columnIds = selectedColumnIdsRef.current
    if (!cardIds.length && !columnIds.length) return
    if (!board) return

    const columnSet = new Set(columnIds)

    // Deleting a selected list deletes the list AND its cards.
    const cardsInSelectedColumns = (board.columns ?? [])
      .filter((c) => columnSet.has(c.id))
      .flatMap((c) => c.cardIds)

    const cardSet = new Set([...cardIds, ...cardsInSelectedColumns])

    // Remove selected columns entirely.
    let columns = (board.columns ?? []).filter((c) => !columnSet.has(c.id))

    // Remove any deleted cards from remaining columns.
    for (const id of cardSet) {
      columns = removeCardFromAllColumns(columns, id)
    }

    const next = { ...board, columns, cards: board.cards.filter((c) => !cardSet.has(c.id)) }
    commitHistoryNow(next)
    setBoard(next)

    setSelectionIds([])
    setColumnSelectionIds([])
  }

  function detachSelectedColumns() {
    const columnIds = selectedColumnIdsRef.current
    if (!columnIds.length) return
    if (!board) return
    const columnSet = new Set(columnIds)

    const detachedCardIds = (board.columns ?? [])
      .filter((c) => columnSet.has(c.id))
      .flatMap((c) => c.cardIds)

    const columns = (board.columns ?? []).filter((c) => !columnSet.has(c.id))
    const next = { ...board, columns }
    commitHistoryNow(next)
    setBoard(next)

    // After detaching, select the cards that used to be in those lists for easy follow-up moves.
    setColumnSelectionIds([])
    setSelectionIds([...new Set(detachedCardIds)])
  }

  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])

  useEffect(() => {
    selectedColumnIdsRef.current = selectedColumnIds
  }, [selectedColumnIds])

  useEffect(() => {
    boardRef.current = board
  }, [board])

  useEffect(() => {
    if (!isChatOpen) return
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [currentChatMessages, chatStatus, isChatOpen])

  useEffect(() => {
    if (!isChatOpen) return
    if (!currentBoardId) return
    if (!pendingChatSessionNoteByBoard[currentBoardId]) return

    const sessionId = chatSessionIdByBoard[currentBoardId] ?? chatSessionIdRef.current
    setChatByBoard((prev) => {
      const existing = prev[currentBoardId] ?? []
      const last = existing[existing.length - 1]
      const lastIsSystemNote = last?.role === 'system-note'
      const alreadyHasMarker = existing.some(
        (m) => m.role === 'system-note' && m.sessionId === sessionId,
      )

      const summary = chatSummaryByBoard[currentBoardId]
      const summaryUpTo = chatSummaryUpToByBoard[currentBoardId] ?? 0

      if (lastIsSystemNote) {
        const updated: ChatStore = {
          version: 1,
          messages: existing,
          summary: summary || undefined,
          summaryUpTo,
          lastSessionId: sessionId,
        }
        saveChat(currentBoardId, updated).catch((err) => {
          console.error('chat save failed', err)
        })
        return prev
      }

      if (alreadyHasMarker) return prev

      const marker: ChatEntry = {
        id: nanoid(),
        role: 'system-note',
        content:
          'New session. The assistant will use a summary and the last few messages from previous chats.',
        createdAt: Date.now(),
        sessionId,
      }
      const nextMessages = [...existing, marker]
      const updated: ChatStore = {
        version: 1,
        messages: nextMessages,
        summary: summary || undefined,
        summaryUpTo,
        lastSessionId: sessionId,
      }
      saveChat(currentBoardId, updated).catch((err) => {
        console.error('chat save failed', err)
      })
      return { ...prev, [currentBoardId]: nextMessages }
    })

    setPendingChatSessionNoteByBoard((prev) => ({ ...prev, [currentBoardId]: false }))
  }, [
    isChatOpen,
    currentBoardId,
    pendingChatSessionNoteByBoard,
    chatSessionIdByBoard,
    chatSummaryByBoard,
    chatSummaryUpToByBoard,
  ])

  useEffect(() => {
    setChatStatus('idle')
    setChatError(null)
  }, [currentBoardId])

  const createListFromSelection = useCallback(() => {
    if (!board) return
    const selectedIds = [...selectedIdsRef.current]
    const selectedHasListedCard = selectedIds.some(
      (id) => getCardColumnId(board.columns ?? [], id) != null,
    )
    if (selectedIds.length < 1 || selectedHasListedCard) return
    const next = createColumnFromSelection(board, selectedIds)
    commitHistoryNow(next)
    skipNextHistoryCommitRef.current = true
    skipHistoryCommitsRef.current = Math.max(skipHistoryCommitsRef.current, 2)
    setBoard(next)
    setSelectionIds([])
    setColumnSelectionIds([])
  }, [board])

  // Clicking outside the list title input should save + exit edit mode.
  useEffect(() => {
    if (!editingColumnId) return

    const handler = (e: PointerEvent) => {
      const input = editingColumnInputRef.current
      const target = e.target as Node | null
      if (!input || !target) return
      if (input.contains(target)) return
      commitEditingColumn()
    }

    window.addEventListener('pointerdown', handler, true)
    return () => window.removeEventListener('pointerdown', handler, true)
  }, [editingColumnId, editingColumnName])

  // Initialize / record history (debounced), but:
  // - never commit while dragging (to avoid multiple steps per drag)
  // - commit immediately when a drag ends (single step)
  useEffect(() => {
    if (!board || !currentBoardId) return

    if (!committedBoardRef.current) {
      committedBoardRef.current = board
      historyRef.current = { undo: [], redo: [] }
      return
    }

    if (isApplyingHistoryRef.current) {
      isApplyingHistoryRef.current = false
      wasInteractingRef.current = isCardInteracting
      return
    }

    if (isCardInteracting) {
      wasInteractingRef.current = true
      clearPendingHistoryCommit()
      return
    }

    if (wasInteractingRef.current) {
      wasInteractingRef.current = false
      commitHistoryNow(board)
      return
    }
    if (skipHistoryCommitsRef.current > 0) {
      skipHistoryCommitsRef.current -= 1
      return
    }
    if (skipNextHistoryCommitRef.current) {
      skipNextHistoryCommitRef.current = false
      return
    }

    scheduleHistoryCommit(board)
  }, [board, isCardInteracting])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.code === 'Space') isSpaceDownRef.current = true

      // Undo/redo (when not typing into a text field).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        const el = document.activeElement as HTMLElement | null
        if (!isTypingTarget(el)) {
          if (e.shiftKey) redo()
          else undo()
          e.preventDefault()
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        const el = document.activeElement as HTMLElement | null
        if (!isTypingTarget(el)) {
          redo()
          e.preventDefault()
        }
        return
      }

      if (e.key === 'l' || e.key === 'L') {
        const el = document.activeElement as HTMLElement | null
        if (isTypingTarget(el)) return
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
        createListFromSelection()
        e.preventDefault()
        return
      }

      if (e.key === 'n' || e.key === 'N') {
        const el = document.activeElement as HTMLElement | null
        if (isTypingTarget(el)) return
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
        addTextCard()
        e.preventDefault()
        return
      }

      if (e.key === 'Escape') {
        const el = document.activeElement as HTMLElement | null
        if (editingTextId) {
          setEditingTextId(null)
          setSelectionIds([])
          setColumnSelectionIds([])
          el?.blur()
          e.preventDefault()
          return
        }
        if (isTypingTarget(el)) return
        setSelectionIds([])
        setColumnSelectionIds([])
        setEditingTextId(null)
        setEditingColumnId(null)
        e.preventDefault()
        return
      }

      if (e.code === 'Backspace' || e.code === 'Delete') {
        const el = document.activeElement as HTMLElement | null
        if (isTypingTarget(el)) return

        deleteSelection()
        e.preventDefault()
      }
    },
    [addTextCard, createListFromSelection, deleteSelection, editingTextId, redo, undo],
  )

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.code === 'Space') isSpaceDownRef.current = false
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [handleKeyDown, handleKeyUp])

  // Paste-to-create:
  // - if clipboard contains URL(s) -> create link card(s)
  // - else if clipboard contains non-empty text/plain -> create a text card
  // - else if clipboard contains images -> create image card(s)
  useEffect(() => {
    function blobToBase64(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onerror = () => reject(new Error('failed to read image data'))
        r.onload = () => {
          const res = r.result
          if (typeof res !== 'string') return reject(new Error('failed to read image data'))
          const idx = res.indexOf('base64,')
          if (idx < 0) return reject(new Error('unexpected data URL'))
          resolve(res.slice(idx + 'base64,'.length))
        }
        r.readAsDataURL(blob)
      })
    }

    async function downscaleToPng(blob: Blob): Promise<{ blob: Blob; width: number; height: number }> {
      const url = URL.createObjectURL(blob)
      const img = new Image()
      img.src = url
      try {
        const dec = (img as unknown as { decode?: () => Promise<void> }).decode
        if (typeof dec === 'function') await dec.call(img)
      } catch {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('failed to load image'))
        })
      } finally {
        URL.revokeObjectURL(url)
      }

      const w0 = img.naturalWidth || 0
      const h0 = img.naturalHeight || 0
      if (!w0 || !h0) throw new Error('invalid image dimensions')

      const maxDim = Math.max(w0, h0)
      const scale = maxDim > 2000 ? 2000 / maxDim : 1
      const w = Math.max(1, Math.round(w0 * scale))
      const h = Math.max(1, Math.round(h0 * scale))

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no canvas context')
      ctx.drawImage(img, 0, 0, w, h)

      const outBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b) resolve(b)
          else reject(new Error('failed to encode image'))
        }, 'image/png')
      })

      return { blob: outBlob, width: w, height: h }
    }

    function viewportCenterContent(): { x: number; y: number } {
      // Default spawn (fallback if transform isn't ready yet)
      let x = GRID_OFFSET + GRID_SIZE * 4
      let y = GRID_OFFSET + GRID_SIZE * 4

      const wrapper = transformRef.current?.instance.wrapperComponent
      if (wrapper) {
        const { scale, positionX, positionY } = transformStateRef.current
        x = (wrapper.clientWidth / 2 - positionX) / scale
        y = (wrapper.clientHeight / 2 - positionY) / scale
      }
      return { x, y }
    }

    function textareaCardId(el: HTMLElement | null): string | null {
      if (!el) return null
      if (el instanceof HTMLTextAreaElement) {
        const id = el.dataset.cardId
        return typeof id === 'string' ? id : null
      }
      return null
    }

    function onPaste(e: ClipboardEvent) {
      const el = document.activeElement as HTMLElement | null
      const isTyping = isTypingTarget(el)

      if (!isTyping && (selectedIdsRef.current.length || selectedColumnIdsRef.current.length)) return

      const items = Array.from(e.clipboardData?.items ?? [])
      const imageFiles = items
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter(Boolean) as File[]

      const text = e.clipboardData?.getData('text/plain') ?? ''
      const urls = extractUrls(text)

      const canConvertToLink = urls.length === 1 && text.trim() === urls[0]

      async function createImageCards(
        files: File[],
        anchor: { x: number; y: number },
        replaceId?: string | null,
      ) {
        if (!currentBoardId) {
          flashNotice('No board selected.')
          return
        }
        const created: ImageCard[] = []

        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          const { blob, width, height } = await downscaleToPng(file)
          const bytesBase64 = await blobToBase64(blob)

          const id = replaceId && i === 0 ? replaceId : nanoid()
          const filename = `${id}.png`
          const rel = await saveImage(currentBoardId, filename, bytesBase64) // "assets/<id>.png"

          const cardH = imageCardHeight(width, height)
          const x = clamp(
            snapToGrid(anchor.x - CARD_WIDTH / 2 + i * GRID_SIZE, GRID_OFFSET),
            0,
            BOARD_WIDTH - CARD_WIDTH,
          )
          const y = clamp(snapToGrid(anchor.y - cardH / 2 + i * GRID_SIZE, GRID_OFFSET), 0, BOARD_HEIGHT - cardH)

          created.push({
            id,
            type: 'image',
            x,
            y,
            width: CARD_WIDTH,
            height: cardH,
            src: rel,
            naturalWidth: width,
            naturalHeight: height,
            note: '',
            noteExpanded: false,
          })
        }

        if (!created.length) return

        const baseBoard = boardRef.current
        if (!baseBoard) return
        let nextCards = baseBoard.cards
        if (replaceId) {
          const replacement = created[0]
          nextCards = baseBoard.cards.map((c) => (c.id === replaceId ? replacement : c))
          nextCards = [...nextCards, ...created.slice(1)]
        } else {
          nextCards = [...baseBoard.cards, ...created]
        }
        const next = layoutBoard({ ...baseBoard, columns: baseBoard.columns ?? [], cards: nextCards })
        commitHistoryNow(next)
        setBoard(next)

        setSelectionIds(created.map((c) => c.id))
        setColumnSelectionIds([])
      }

      if (isTyping) {
        const cardId = textareaCardId(el)
        if (!cardId) return
        const card = board?.cards.find((c) => c.id === cardId)
        if (!card || card.type !== 'text') return

        if (canConvertToLink && card.text.trim().length === 0) {
          e.preventDefault()
          const url = urls[0]
          const h = LINK_CARD_HEIGHT_NO_IMAGE
          if (!board) return
          const nextCards = board.cards.map((c) => {
            if (c.id !== cardId || c.type !== 'text') return c
            return {
              id: c.id,
              type: 'link',
              x: c.x,
              y: c.y,
              width: CARD_WIDTH,
              height: h,
              url,
              title: url,
              siteName: undefined,
              image: undefined,
            } as LinkCard
          })
          const next = layoutBoard({ ...board, columns: board.columns ?? [], cards: nextCards })
          commitHistoryNow(next)
          setBoard(next)
          setEditingTextId(null)

          void (async () => {
            if (!currentBoardId) return
            try {
              const meta = await fetchLinkMetadata(currentBoardId, url)
              setBoard((prev) => {
                if (!prev) return prev
                const nextCards = prev.cards.map((c) => {
                  if (c.id !== cardId || c.type !== 'link') return c
                  const hasImage = Boolean(meta.image)
                  const noteOpen = Boolean(c.note?.trim()) || c.noteExpanded
                  const nextBase = hasImage ? LINK_CARD_HEIGHT_WITH_IMAGE : LINK_CARD_HEIGHT_NO_IMAGE
                  const previewEl = linkCardPreviewByIdRef.current.get(c.id) ?? null
                  const bodyEl = linkCardBodyByIdRef.current.get(c.id) ?? null
                  const noteEl = linkNoteTextareaByIdRef.current.get(c.id) ?? null
                  const contentHeight = noteOpen ? linkCardHeightFromParts(previewEl, bodyEl, noteEl) : null
                  return {
                    ...c,
                    url: meta.url || c.url,
                    title: meta.title || c.title,
                    image: meta.image ?? c.image,
                    siteName: meta.siteName ?? c.siteName,
                    noteExpanded: noteOpen,
                    height: noteOpen
                      ? contentHeight ?? Math.max(c.height, nextBase + LINK_NOTE_MIN_HEIGHT)
                      : nextBase,
                  }
                })
                return { ...prev, cards: nextCards }
              })
            } catch (err) {
              console.error('link metadata failed', err)
            }
          })()
          return
        }

        if (!imageFiles.length) return
        e.preventDefault()

        const hasText = card.text.trim().length > 0
        const anchor = {
          x: card.x + GRID_SIZE * 2,
          y: card.y + GRID_SIZE * 2,
        }
        void createImageCards(imageFiles, anchor, hasText ? null : cardId)
        return
      }

      if (canConvertToLink) {
        e.preventDefault()
        if (!currentBoardId) {
          flashNotice('No board selected.')
          return
        }

        const center = viewportCenterContent()
        const h = LINK_CARD_HEIGHT_NO_IMAGE
        const x = clamp(snapToGrid(center.x - CARD_WIDTH / 2, GRID_OFFSET), 0, BOARD_WIDTH - CARD_WIDTH)
        const y = clamp(snapToGrid(center.y - h / 2, GRID_OFFSET), 0, BOARD_HEIGHT - h)
        const url = urls[0]

        const card: LinkCard = {
          id: nanoid(),
          type: 'link',
          x,
          y,
          width: CARD_WIDTH,
          height: h,
          url,
          title: url,
        }

        if (!board) return
        const nextBoard = layoutBoard({
          ...board,
          columns: board.columns ?? [],
          cards: [...board.cards, card],
        })
        commitHistoryNow(nextBoard)
        setBoard(nextBoard)

        setSelectionIds([card.id])
        setColumnSelectionIds([])

        void (async () => {
          try {
            const meta = await fetchLinkMetadata(currentBoardId, card.url)
            setBoard((prev) => {
              if (!prev) return prev
              const nextCards = prev.cards.map((c) => {
                if (c.id !== card.id || c.type !== 'link') return c
                const hasImage = Boolean(meta.image)
                  const noteOpen = Boolean(c.note?.trim()) || c.noteExpanded
                  const nextBase = hasImage ? LINK_CARD_HEIGHT_WITH_IMAGE : LINK_CARD_HEIGHT_NO_IMAGE
                  const previewEl = linkCardPreviewByIdRef.current.get(c.id) ?? null
                  const bodyEl = linkCardBodyByIdRef.current.get(c.id) ?? null
                  const noteEl = linkNoteTextareaByIdRef.current.get(c.id) ?? null
                  const contentHeight = noteOpen ? linkCardHeightFromParts(previewEl, bodyEl, noteEl) : null
                return {
                  ...c,
                  url: meta.url || c.url,
                  title: meta.title || c.title,
                  image: meta.image ?? c.image,
                  siteName: meta.siteName ?? c.siteName,
                  noteExpanded: noteOpen,
                  height: noteOpen
                    ? contentHeight ?? Math.max(c.height, nextBase + LINK_NOTE_MIN_HEIGHT)
                    : nextBase,
                }
              })
              return { ...prev, cards: nextCards }
            })
          } catch (err) {
            console.error('link metadata failed', err)
          }
        })()

        return
      }

      if (text.trim()) {
        e.preventDefault()

        const w = CARD_WIDTH
        const h = MIN_CARD_HEIGHT
        const center = viewportCenterContent()

        const spawnX = snapToGrid(center.x - w / 2, GRID_OFFSET)
        const spawnY = snapToGrid(center.y - h / 2, GRID_OFFSET)

        const id = nanoid()
        if (!board) return
        const nextCard: TextCard = {
          id,
          type: 'text',
          x: clamp(spawnX, 0, BOARD_WIDTH - CARD_WIDTH),
          y: clamp(spawnY, 0, BOARD_HEIGHT - h),
          width: w,
          height: h,
          text,
        }
        const nextBoard = layoutBoard({
          ...board,
          columns: board.columns ?? [],
          cards: [...board.cards, nextCard],
        })
        commitHistoryNow(nextBoard)
        setBoard(nextBoard)

        setSelectionIds([id])
        setColumnSelectionIds([])
        startEditingTextCard(id)

        return
      }

      if (!imageFiles.length) return

      if (!currentBoardId) {
        flashNotice('No board selected.')
        return
      }

      e.preventDefault()

      const center = viewportCenterContent()

      void (async () => {
        try {

          await createImageCards(imageFiles, center, null)
        } catch (err) {
          console.error('image paste failed', err)
          const msg = err instanceof Error ? err.message : String(err)
          flashNotice(`Failed to paste image: ${msg}`)
        }
      })()
    }

    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [board, currentBoardId, flashNotice])

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const [listed, trashed] = await Promise.all([listBoards(), listTrashedBoards()])
        if (cancelled) return
        let nextBoards = listed
        if (!nextBoards.length) {
          const created = await createBoard('Untitled 1')
          nextBoards = [created]
        }
        if (cancelled) return
        const storedLastId = readLastBoardId()
        const validLastId = storedLastId && nextBoards.some((b) => b.id === storedLastId) ? storedLastId : null
        setBoards(nextBoards)
        setTrashedBoards(
          trashed
            .filter((b) => typeof b.deletedAt === 'number')
            .map((b) => ({ id: b.id, name: b.name, deletedAt: b.deletedAt as number })),
        )
        setRecentBoardIds((prev) => {
          const filtered = prev.filter((id) => nextBoards.some((b) => b.id === id))
          writeRecentBoards(filtered)
          return filtered
        })

        const initialId = validLastId ?? nextBoards[0].id
        await loadBoardById(initialId)
      } catch (e) {
        if (cancelled) return
        setStatus('error')
        setError(String(e))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [loadBoardById])

  useEffect(() => {
    if (!board || !currentBoardId) return

    // Avoid writing immediately after initial load.
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false
      return
    }

    // Avoid disk writes while dragging/resizing.
    if (isCardInteracting) return

    const t = window.setTimeout(() => {
      saveBoard(currentBoardId, board).catch((e) => {
        // Keep this simple for MVP: surface via console + status bar text.
        console.error('autosave failed', e)
      })
    }, autosaveDelayMs)

    return () => window.clearTimeout(t)
  }, [board, isCardInteracting, currentBoardId])

  // After render, ensure card heights match their text content (and fixed width).
  useEffect(() => {
    if (!board) return
    if (layoutResetPendingRef.current) return

    // Only run this after the DOM has painted with the latest text values.
    const t = window.requestAnimationFrame(() => {
      setBoard((prev) => {
        if (!prev) return prev

        let changed = false
        const nextCards = prev.cards.map((c) => {
          const el = textareaByIdRef.current.get(c.id)
          if (!el) return c

          const desiredHeight = cardHeightFromTextarea(el)
          if (c.height !== desiredHeight || c.width !== CARD_WIDTH) {
            changed = true
            return { ...c, height: desiredHeight, width: CARD_WIDTH }
          }
          return c
        })

        if (!changed) return prev
        skipNextHistoryCommitRef.current = true
        return { ...prev, cards: nextCards }
      })
    })

    return () => window.cancelAnimationFrame(t)
  }, [
    board?.cards.length,
    board?.cards
      ?.map((c) => (c.type === 'text' ? `${c.id}:${c.text?.length ?? 0}` : ''))
      ?.join('|') ?? '',
  ])

  // After render, ensure link card heights match their rendered content.
  useEffect(() => {
    if (!board) return
    if (layoutResetPendingRef.current) return

    const t = window.requestAnimationFrame(() => {
      setBoard((prev) => {
        if (!prev) return prev

        let changed = false
        const nextCards = prev.cards.map((c) => {
          if (c.type !== 'link') return c
          const previewEl = linkCardPreviewByIdRef.current.get(c.id) ?? null
          const bodyEl = linkCardBodyByIdRef.current.get(c.id) ?? null
          const noteEl = linkNoteTextareaByIdRef.current.get(c.id)
          if (noteEl) {
            noteEl.style.height = 'auto'
            noteEl.style.height = `${linkNoteHeightFromTextarea(noteEl)}px`
          }
          const desiredHeight = linkCardHeightFromParts(previewEl, bodyEl, noteEl ?? null)
          if (desiredHeight == null) return c
          if (c.height !== desiredHeight || c.width !== CARD_WIDTH) {
            changed = true
            return { ...c, height: desiredHeight, width: CARD_WIDTH }
          }
          return c
        })

        if (!changed) return prev
        skipNextHistoryCommitRef.current = true
        return { ...prev, cards: nextCards }
      })
    })

    return () => window.cancelAnimationFrame(t)
  }, [
    board?.cards.length,
    board?.cards
      ?.map((c) => (c.type === 'link' ? `${c.id}:${c.noteExpanded ? 1 : 0}:${c.note?.length ?? 0}:${c.image ? 1 : 0}` : ''))
      ?.join('|') ?? '',
  ])

  // After render, ensure image card heights match their rendered content.
  useEffect(() => {
    if (!board) return
    if (layoutResetPendingRef.current) return

    const t = window.requestAnimationFrame(() => {
      setBoard((prev) => {
        if (!prev) return prev

        let changed = false
        const nextCards = prev.cards.map((c) => {
          if (c.type !== 'image') return c
          const noteEl = imageNoteTextareaByIdRef.current.get(c.id)
          if (noteEl) {
            noteEl.style.height = 'auto'
            noteEl.style.height = `${linkNoteHeightFromTextarea(noteEl)}px`
          }
          const baseHeight = imageCardBaseHeight(c)
          const bodyEl = imageCardBodyByIdRef.current.get(c.id) ?? null
          const desiredHeight = imageCardHeightFromParts(baseHeight, bodyEl)
          if (desiredHeight == null) return c
          if (c.height !== desiredHeight || c.width !== CARD_WIDTH) {
            changed = true
            return { ...c, height: desiredHeight, width: CARD_WIDTH }
          }
          return c
        })

        if (!changed) return prev
        skipNextHistoryCommitRef.current = true
        return { ...prev, cards: nextCards }
      })
    })

    return () => window.cancelAnimationFrame(t)
  }, [
    board?.cards.length,
    board?.cards
      ?.map((c) => (c.type === 'image' ? `${c.id}:${c.noteExpanded ? 1 : 0}:${c.note?.length ?? 0}` : ''))
      ?.join('|') ?? '',
  ])

  // Enforce column layout whenever columns exist and card heights change.
  useEffect(() => {
    if (!board) return
    if (!board.columns.length) return
    if (isCardInteracting) return
    if (layoutResetPendingRef.current) return

    setBoard((prev) => {
      if (!prev) return prev
      const next = layoutBoard(prev)
      if (next === prev) return prev
      skipNextHistoryCommitRef.current = true
      return next
    })
  }, [board?.columns.length, board?.cards.map((c) => c.height).join(','), isCardInteracting])

  // Cleanup any pending animation frame.
  useEffect(() => {
    return () => {
      if (columnDragRafRef.current) window.cancelAnimationFrame(columnDragRafRef.current)
      if (columnDropRafRef.current) window.cancelAnimationFrame(columnDropRafRef.current)
      if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current)
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  const cards = useMemo(() => board?.cards ?? [], [board])

  function scheduleColumnDrop(next: ColumnDrop | null) {
    pendingColumnDropRef.current = next
    if (columnDropRafRef.current) return
    columnDropRafRef.current = window.requestAnimationFrame(() => {
      columnDropRafRef.current = null
      setColumnDrop(pendingColumnDropRef.current)
    })
  }

  function computeColumnDropTarget(
    board: Board,
    boardX: number,
    boardY: number,
    cardHeight: number,
    cardId: string,
  ): ColumnDrop | null {
    const columns = board.columns ?? []
    if (!columns.length) return null

    const sourceColumnId = getCardColumnId(columns, cardId)

    const byId = new Map(board.cards.map((c) => [c.id, c]))
    const cx = boardX + CARD_WIDTH / 2
    const cy = boardY + cardHeight / 2

    for (const col of columns) {
      const headerH = getColumnHeaderHeight(col.id)
      const contentHeight = getColumnContentHeight(board, col)
      const left = col.x - COLUMN_PADDING
      const right = col.x + CARD_WIDTH + COLUMN_PADDING
      const top = col.y - headerH - COLUMN_PADDING
      const bottom = col.y + contentHeight + COLUMN_PADDING

      if (cx < left || cx > right || cy < top || cy > bottom) continue

      const ids = col.cardIds
      // If we are dragging a card that already belongs to this column, compute the insert index
      // against the list with that card removed.
      const idsWithoutDragged =
        sourceColumnId === col.id ? ids.filter((id) => id !== cardId) : ids

      let index = idsWithoutDragged.length
      for (let i = 0; i < idsWithoutDragged.length; i++) {
        const c = byId.get(idsWithoutDragged[i])
        if (!c) continue
        const midY = c.y + c.height / 2
        if (cy < midY) {
          index = i
          break
        }
      }

      let lineY = col.y
      const nextId = idsWithoutDragged[index]
      const prevId = idsWithoutDragged[index - 1]
      const nextCard = nextId ? byId.get(nextId) : undefined
      const prevCard = prevId ? byId.get(prevId) : undefined

      if (nextCard) lineY = nextCard.y - col.gap / 2
      else if (prevCard) lineY = prevCard.y + prevCard.height + col.gap / 2
      else lineY = col.y

      return { columnId: col.id, index, lineY }
    }

    return null
  }

  function addTextCard() {
    if (!board) return
    const id = nanoid()
    const w = CARD_WIDTH
    const h = MIN_CARD_HEIGHT

    // Default spawn (fallback if transform isn't ready yet)
    let spawnX = GRID_OFFSET + GRID_SIZE * 4
    let spawnY = GRID_OFFSET + GRID_SIZE * 4

    const wrapper = transformRef.current?.instance.wrapperComponent
    if (wrapper) {
      const { scale, positionX, positionY } = transformStateRef.current

      // Convert viewport center -> content coordinates -> board coordinates.
      const centerContentX = (wrapper.clientWidth / 2 - positionX) / scale
      const centerContentY = (wrapper.clientHeight / 2 - positionY) / scale

      spawnX = snapToGrid(centerContentX - w / 2, GRID_OFFSET)
      spawnY = snapToGrid(centerContentY - h / 2, GRID_OFFSET)
    }

    const next: Card = {
      id,
      type: 'text',
      x: clamp(spawnX, 0, BOARD_WIDTH - CARD_WIDTH),
      y: clamp(spawnY, 0, BOARD_HEIGHT - h),
      width: w,
      height: h,
      text: '',
    }

    const nextBoard = layoutBoard({
      ...board,
      columns: board.columns ?? [],
      cards: [...board.cards, next],
    })
    commitHistoryNow(nextBoard)
    setBoard(nextBoard)
    setSelectionIds([id])
    setColumnSelectionIds([])
    startEditingTextCard(id)
  }


  function addTextCardAt(boardX: number, boardY: number) {
    if (!board) return
    const id = nanoid()
    const w = CARD_WIDTH
    const h = MIN_CARD_HEIGHT

    const x = clamp(snapToGrid(boardX - w / 2, GRID_OFFSET), 0, BOARD_WIDTH - CARD_WIDTH)
    const y = clamp(snapToGrid(boardY - h / 2, GRID_OFFSET), 0, BOARD_HEIGHT - h)

    const next: Card = {
      id,
      type: 'text',
      x,
      y,
      width: w,
      height: h,
      text: '',
    }

    const nextBoard = layoutBoard({
      ...board,
      columns: board.columns ?? [],
      cards: [...board.cards, next],
    })
    commitHistoryNow(nextBoard)
    setBoard(nextBoard)
    setSelectionIds([id])
    setColumnSelectionIds([])
    startEditingTextCard(id)
  }

  // Attach a non-passive wheel handler (prevents the "rubber band" UI wiggle).
  useEffect(() => {
    if (!panZoomEl) return

    const handler = (e: WheelEvent) => {
      const controller = transformRef.current
      if (!controller) return

      // We fully own wheel gestures:
      // - two-finger scroll = pan
      // - pinch gesture = wheel event with ctrlKey (common on mac trackpads) = zoom
      e.preventDefault()
      e.stopPropagation()

      const { scale, positionX, positionY } = transformStateRef.current

      if (e.ctrlKey) {
        // Zoom around the cursor position.
        const rect = panZoomEl.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top

        // Convert screen point -> content point under cursor.
        const contentX = (px - positionX) / scale
        const contentY = (py - positionY) / scale

        // Smooth zoom factor based on wheel delta.
        const zoomFactor = Math.exp(-e.deltaY * PINCH_ZOOM_SENSITIVITY)
        const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * zoomFactor))

        const nextPositionX = px - contentX * nextScale
        const nextPositionY = py - contentY * nextScale

        commitTransform(nextPositionX, nextPositionY, nextScale, 0)
        return
      }

      // Pan: wheel deltas are in screen pixels, which matches transform coords.
      commitTransform(positionX - e.deltaX, positionY - e.deltaY, scale, 0)
    }

    panZoomEl.addEventListener('wheel', handler, { passive: false })
    return () => panZoomEl.removeEventListener('wheel', handler)
  }, [panZoomEl])

  // Middle mouse drag = pan (match trackpad two-finger pan).
  useEffect(() => {
    if (!panZoomEl) return

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      e.stopPropagation()
      middlePanRef.current = { x: e.clientX, y: e.clientY }

      const onMouseMove = (move: MouseEvent) => {
        if (!middlePanRef.current) return
        move.preventDefault()
        const { scale, positionX, positionY } = transformStateRef.current
        const dx = move.clientX - middlePanRef.current.x
        const dy = move.clientY - middlePanRef.current.y
        middlePanRef.current = { x: move.clientX, y: move.clientY }
        commitTransform(positionX + dx, positionY + dy, scale, 0)
      }

      const onMouseUp = () => {
        middlePanRef.current = null
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    }

    panZoomEl.addEventListener('mousedown', onMouseDown)
    return () => {
      panZoomEl.removeEventListener('mousedown', onMouseDown)
    }
  }, [panZoomEl])

  function clientToBoardPoint(clientX: number, clientY: number) {
    const wrapper = transformRef.current?.instance.wrapperComponent
    if (!wrapper) return null

    const rect = wrapper.getBoundingClientRect()
    const { scale, positionX, positionY } = transformStateRef.current

    const px = clientX - rect.left
    const py = clientY - rect.top

    const contentX = (px - positionX) / scale
    const contentY = (py - positionY) / scale

    return {
      x: contentX,
      y: contentY,
    }
  }

  function selectionBounds(sel: Selection) {
    const left = Math.min(sel.x0, sel.x1)
    const right = Math.max(sel.x0, sel.x1)
    const top = Math.min(sel.y0, sel.y1)
    const bottom = Math.max(sel.y0, sel.y1)
    return { left, right, top, bottom }
  }

  function columnWidgetBounds(boardForBounds: Board, col: Column) {
    // Must match the column `Rnd` position/size math in render.
    const headerH = getColumnHeaderHeight(col.id)
    const left = col.x - COLUMN_PADDING
    const top = col.y - headerH - COLUMN_PADDING
    const right = col.x + CARD_WIDTH + COLUMN_PADDING
    const bottom = col.y + getColumnContentHeight(boardForBounds, col) + COLUMN_PADDING
    return { left, right, top, bottom }
  }

  function computeMarqueeSelection(
    boardForSelection: Board,
    sel: Selection,
  ): { cardIds: string[]; columnIds: string[] } {
    const { left, right, top, bottom } = selectionBounds(sel)

    const selectedColumnIds: string[] = []
    for (const col of boardForSelection.columns ?? []) {
      const b = columnWidgetBounds(boardForSelection, col)
      const fullyInside =
        b.left >= left && b.top >= top && b.right <= right && b.bottom <= bottom
      if (fullyInside) selectedColumnIds.push(col.id)
    }
    const selectedColumnSet = new Set(selectedColumnIds)

    const cardIds = boardForSelection.cards
      .filter((c) => {
        const colId = getCardColumnId(boardForSelection.columns ?? [], c.id)
        if (colId && selectedColumnSet.has(colId)) return false
        const w = CARD_WIDTH
        const h = c.height
        const fullyInside =
          c.x >= left && c.y >= top && c.x + w <= right && c.y + h <= bottom
        return fullyInside
      })
      .map((c) => c.id)

    return { cardIds, columnIds: selectedColumnIds }
  }

  function setSelectionIds(next: string[]) {
    selectedIdsRef.current = next
    setSelectedIds(next)
  }

  function onBoardPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    if (isSpaceDownRef.current) return

    const target = e.target as HTMLElement
    // Only start selection when the user drags on empty board space.
    if (
      target.closest('.card') ||
      target.closest('.react-rnd') ||
      target.closest('.react-draggable') ||
      target.closest('.columnWidget') ||
      target.closest('.columnHeader')
    ) {
      return
    }

    // Clicking empty board should end text editing.
    const active = document.activeElement as HTMLElement | null
    if (isTypingTarget(active)) active?.blur()

    const pt = clientToBoardPoint(e.clientX, e.clientY)
    if (!pt) return

    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
    e.stopPropagation()

    selectionStartRef.current = pt
    selectionStartClientRef.current = { x: e.clientX, y: e.clientY }
    setIsSelecting(true)
    setSelection({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y })
    setSelectionIds([])
    setColumnSelectionIds([])
  }

  function onBoardPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isSelecting) return
    const start = selectionStartRef.current
    if (!start) return
    e.stopPropagation()

    const pt = clientToBoardPoint(e.clientX, e.clientY)
    if (!pt) return

    const nextSel = { x0: start.x, y0: start.y, x1: pt.x, y1: pt.y }
    setSelection(nextSel)
    if (!board) return
    const picked = computeMarqueeSelection(board, nextSel)
    setSelectionIds(picked.cardIds)
    setColumnSelectionIds(picked.columnIds)
  }

  function finishSelection(e: React.PointerEvent<HTMLDivElement>) {
    if (!isSelecting) return

    const startClient = selectionStartClientRef.current
    const endClient = { x: e.clientX, y: e.clientY }
    const movedPx =
      startClient == null
        ? Infinity
        : Math.hypot(endClient.x - startClient.x, endClient.y - startClient.y)

    // Click on empty space clears selection.
    if (movedPx < SELECTION_MIN_PX) {
      setSelectionIds([])
      setColumnSelectionIds([])
    }

    setIsSelecting(false)
    setSelection(null)
    selectionStartRef.current = null
    selectionStartClientRef.current = null
  }

  function updateCard(id: string, patch: Partial<TextCard>) {
    setBoard((prev) => {
      if (!prev) return prev
      const next = {
        ...prev,
        columns: prev.columns ?? [],
        cards: prev.cards.map((c) => {
          if (c.id !== id) return c
          if (c.type !== 'text') return c
          // Always enforce fixed width.
          const next: TextCard = { ...c, ...patch, width: CARD_WIDTH }
          // Ensure min height.
          if (next.height < MIN_CARD_HEIGHT) next.height = MIN_CARD_HEIGHT
          if (typeof next.x === 'number') next.x = clamp(next.x, 0, BOARD_WIDTH - CARD_WIDTH)
          if (typeof next.y === 'number') next.y = clamp(next.y, 0, BOARD_HEIGHT - next.height)
          return next
        }),
      }
      return layoutBoard(next)
    })
  }

  function updateLinkCard(id: string, patch: Partial<LinkCard>) {
    setBoard((prev) => {
      if (!prev) return prev
      const next = {
        ...prev,
        columns: prev.columns ?? [],
        cards: prev.cards.map((c) => {
          if (c.id !== id) return c
          if (c.type !== 'link') return c
          const next: LinkCard = { ...c, ...patch, width: CARD_WIDTH }
          const hasNote = Boolean(next.note?.trim())
          const noteOpen = hasNote || Boolean(next.noteExpanded)
          const baseHeight = linkCardBaseHeight(next)
          if (noteOpen) {
            const previewEl = linkCardPreviewByIdRef.current.get(id) ?? null
            const bodyEl = linkCardBodyByIdRef.current.get(id) ?? null
            const noteEl = linkNoteTextareaByIdRef.current.get(id) ?? null
            const contentHeight = linkCardHeightFromParts(previewEl, bodyEl, noteEl)
            if (contentHeight != null) {
              next.height = contentHeight
            } else {
              const minHeight = baseHeight + LINK_NOTE_MIN_HEIGHT + LINK_NOTE_BORDER_HEIGHT
              const desiredHeight =
                typeof next.height === 'number' ? Math.max(minHeight, next.height) : minHeight
              next.height = desiredHeight
            }
            next.noteExpanded = true
          } else {
            next.height = baseHeight
            next.noteExpanded = false
          }
          if (typeof next.x === 'number') next.x = clamp(next.x, 0, BOARD_WIDTH - CARD_WIDTH)
          if (typeof next.y === 'number') next.y = clamp(next.y, 0, BOARD_HEIGHT - next.height)
          return next
        }),
      }
      return layoutBoard(next)
    })
  }

  function updateImageCard(id: string, patch: Partial<ImageCard>) {
    setBoard((prev) => {
      if (!prev) return prev
      const next = {
        ...prev,
        columns: prev.columns ?? [],
        cards: prev.cards.map((c) => {
          if (c.id !== id) return c
          if (c.type !== 'image') return c
          const next: ImageCard = { ...c, ...patch, width: CARD_WIDTH }
          const baseHeight = imageCardBaseHeight(next)
          const bodyEl = imageCardBodyByIdRef.current.get(id) ?? null
          const contentHeight = imageCardHeightFromParts(baseHeight, bodyEl)
          if (contentHeight != null) {
            next.height = contentHeight
          } else {
            next.height = typeof next.height === 'number' ? next.height : baseHeight
          }
          if (typeof next.x === 'number') next.x = clamp(next.x, 0, BOARD_WIDTH - CARD_WIDTH)
          if (typeof next.y === 'number') next.y = clamp(next.y, 0, BOARD_HEIGHT - next.height)
          return next
        }),
      }
      return layoutBoard(next)
    })
  }

  function deleteCard(id: string) {
    if (!board) return
    const nextColumns = removeCardFromAllColumns(board.columns ?? [], id)
    const next = { ...board, columns: nextColumns, cards: board.cards.filter((c) => c.id !== id) }
    commitHistoryNow(next)
    setBoard(next)
    setSelectionIds(selectedIdsRef.current.filter((x) => x !== id))
  }

  function startSelectionDrag(
    anchorType: 'card' | 'column',
    anchorId: string,
    startContentX: number,
    startContentY: number,
  ) {
    if (!board) return false
    const selectedCards = selectedIdsRef.current
    const selectedColumns = selectedColumnIdsRef.current

    const anchorSelected =
      anchorType === 'card' ? selectedCards.includes(anchorId) : selectedColumns.includes(anchorId)
    if (!anchorSelected) return false

    // Cards inside lists are layout-managed; dragging them has special semantics (reorder / drag out),
    // so don't treat them as a "move the whole selection" anchor.
    if (anchorType === 'card') {
      const colId = getCardColumnId(board.columns ?? [], anchorId)
      if (colId) return false
    }

    const selectedColumnSet = new Set(selectedColumns)

    const initialColumns: Record<string, { x: number; y: number }> = {}
    const initialCards: Record<string, { x: number; y: number }> = {}

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const colId of selectedColumns) {
      const col = (board.columns ?? []).find((c) => c.id === colId)
      if (!col) continue
      initialColumns[col.id] = { x: col.x, y: col.y }
      const h = getColumnContentHeight(board, col)
      minX = Math.min(minX, col.x)
      minY = Math.min(minY, col.y)
      maxX = Math.max(maxX, col.x + CARD_WIDTH)
      maxY = Math.max(maxY, col.y + h)
    }

    for (const id of selectedCards) {
      const c = cards.find((cc) => cc.id === id)
      if (!c) continue
      const colId = getCardColumnId(board.columns ?? [], id)
      if (colId && selectedColumnSet.has(colId)) continue // moved/duplicated with its column
      if (colId) continue // cards inside non-selected columns are layout-managed; don't try to group-move them
      initialCards[id] = { x: c.x, y: c.y }
      minX = Math.min(minX, c.x)
      minY = Math.min(minY, c.y)
      maxX = Math.max(maxX, c.x + CARD_WIDTH)
      maxY = Math.max(maxY, c.y + c.height)
    }

    const itemCount = Object.keys(initialCards).length + Object.keys(initialColumns).length
    if (itemCount <= 1) return false

    selectionDragRef.current = {
      anchorType,
      anchorId,
      startContentX,
      startContentY,
      initialCards,
      initialColumns,
      bounds: { minX, minY, maxX, maxY },
    }
    return true
  }

  function moveSelectionDrag(deltaX: number, deltaY: number, snap: boolean) {
    const sd = selectionDragRef.current
    if (!sd) return

    // Clamp the delta so the whole selection stays within the fixed board bounds.
    let dx = clamp(deltaX, -sd.bounds.minX, BOARD_WIDTH - sd.bounds.maxX)
    let dy = clamp(deltaY, -sd.bounds.minY, BOARD_HEIGHT - sd.bounds.maxY)

    const anchorInitial =
      sd.anchorType === 'card' ? sd.initialCards[sd.anchorId] : sd.initialColumns[sd.anchorId]
    if (anchorInitial) {
      const anchorFinal = { x: anchorInitial.x + dx, y: anchorInitial.y + dy }
      if (snap) {
        dx += snapToGrid(anchorFinal.x, GRID_OFFSET) - anchorFinal.x
        dy += snapToGrid(anchorFinal.y, GRID_OFFSET) - anchorFinal.y
        dx = clamp(dx, -sd.bounds.minX, BOARD_WIDTH - sd.bounds.maxX)
        dy = clamp(dy, -sd.bounds.minY, BOARD_HEIGHT - sd.bounds.maxY)
      }
    }

    const movedColumnSet = new Set(Object.keys(sd.initialColumns))

    setBoard((prev) => {
      if (!prev) return prev

      const columns = (prev.columns ?? []).map((col) => {
        const init = sd.initialColumns[col.id]
        if (!init) return col
        return { ...col, x: init.x + dx, y: init.y + dy, width: CARD_WIDTH }
      })

      const cardsOut = prev.cards.map((c) => {
        const init = sd.initialCards[c.id]
        if (!init) return c
        const colId = getCardColumnId(prev.columns ?? [], c.id)
        if (colId && movedColumnSet.has(colId)) return c
        // Free cards only (by construction), but keep this guard anyway.
        if (colId) return c
        return { ...c, x: init.x + dx, y: init.y + dy, width: CARD_WIDTH }
      })

      return layoutBoard({ ...prev, columns, cards: cardsOut })
    })
  }

  function maybeSelectCardOnMouseDown(e: React.MouseEvent, id: string) {
    if (e.button !== 0) return
    // If already selected, keep multi-selection intact (so group-drag works).
    if (selectedIdsRef.current.includes(id)) return

    if (e.shiftKey) {
      setSelectionIds([...selectedIdsRef.current, id])
      return
    }

    // Plain click selects just that card.
    setSelectionIds([id])
    setColumnSelectionIds([])
  }

  function maybeSelectColumnOnMouseDown(e: React.MouseEvent, columnId: string) {
    if (e.button !== 0) return
    if (selectedColumnIdsRef.current.includes(columnId)) return

    if (e.shiftKey) {
      setColumnSelectionIds([...selectedColumnIdsRef.current, columnId])
      return
    }

    setSelectionIds([])
    setColumnSelectionIds([columnId])
  }

  function startEditingColumn(col: Column) {
    setEditingColumnId(col.id)
    setEditingColumnName(col.name ?? 'List')
    // focus after render
    window.requestAnimationFrame(() => {
      editingColumnInputRef.current?.focus()
      editingColumnInputRef.current?.select()
    })
  }

  function commitEditingColumn() {
    const id = editingColumnId
    if (!id) return

    const name = editingColumnName.trim() || 'List'
    setEditingColumnId(null)

    if (!board) return
    const columns = (board.columns ?? []).map((c) => (c.id === id ? { ...c, name } : c))
    const next = { ...board, columns }
    commitHistoryNow(next)
    setBoard(next)
  }

  function cancelEditingColumn() {
    setEditingColumnId(null)
  }

  function startEditingBoardTitle() {
    setIsEditingBoardName(true)
    setEditingBoardName(board?.name ?? 'Untitled')
    window.requestAnimationFrame(() => {
      editingBoardNameInputRef.current?.focus()
      editingBoardNameInputRef.current?.select()
    })
  }

  function commitEditingBoardTitle() {
    if (!isEditingBoardName) return
    const nextName = editingBoardName.trim() || 'Untitled'
    setIsEditingBoardName(false)

    if (nextName === (board?.name ?? '')) return

    if (currentBoardId) {
      setBoards((prev) =>
        prev.map((item) =>
          item.id === currentBoardId ? { ...item, name: nextName, updatedAt: Date.now() } : item,
        ),
      )
    }

    if (!board) return
    const next = { ...board, name: nextName }
    commitHistoryNow(next)
    setBoard(next)
  }

  function cancelEditingBoardTitle() {
    setIsEditingBoardName(false)
  }

  if (status === 'loading') {
    return <div className="app app--center">Loading board…</div>
  }

  if (status === 'error' || !board) {
    return (
      <div className="app app--center">
        <div>
          <div className="errorTitle">Failed to load board</div>
          <pre className="errorBody">{error ?? 'Unknown error'}</pre>
        </div>
      </div>
    )
  }

  function assetUrl(relPath?: string | null): string | null {
    if (!assetsDir || !relPath) return null
    const rel = relPath.startsWith('assets/') ? relPath.slice('assets/'.length) : relPath
    const abs = `${assetsDir}/${rel}`
    return convertFileSrc(abs)
  }

  function imageUrl(card: ImageCard): string | null {
    return assetUrl(card.src)
  }

  function linkImageUrl(card: LinkCard): string | null {
    return assetUrl(card.image)
  }

  function openLink(url: string) {
    openExternalUrl(url).catch((err) => {
      console.error('open url failed', err)
    })
  }

  async function sendChatMessage(content: string) {
    if (chatStatus === 'sending') return
    const trimmed = content.trim()
    if (!trimmed) return
    if (!currentBoardId) return
    const boardSnapshot = boardRef.current ?? board
    if (!boardSnapshot) return

    setChatError(null)
    setChatStatus('sending')
    const sessionId = chatSessionIdByBoard[currentBoardId] ?? chatSessionIdRef.current
    const userPayload: ChatMessage = { role: 'user', content: trimmed }
    const userMessage: ChatEntry = {
      id: nanoid(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
      sessionId,
    }
    const nextMessages = [...currentChatMessages, userMessage]
    setChatByBoard((prev) => ({ ...prev, [currentBoardId]: nextMessages }))
    setChatInputByBoard((prev) => ({ ...prev, [currentBoardId]: '' }))
    saveChat(currentBoardId, {
      version: 1,
      messages: nextMessages,
      summary: currentChatSummary || undefined,
      summaryUpTo: currentChatSummaryUpTo,
      lastSessionId: sessionId,
    }).catch((err) => {
      console.error('chat save failed', err)
    })

    const systemMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a helpful assistant for LANA. Answer questions about the board content. ' +
          'Be concise and stick to facts present in the board. Do not make assumptions or infer intent. ' +
          'Do not include IDs or JSON fragments unless the user explicitly asks for them. ' +
          'If asked to change the board, describe suggested edits instead of claiming changes were applied.',
      },
      {
        role: 'system',
        content: `Board context:\n${summarizeBoardForPrompt(boardSnapshot)}`,
      },
    ]

    try {
      const modelEntries = nextMessages.filter(isChatEntryForModel)
      const historyEntries = modelEntries.slice(0, -1)
      const totalHistory = historyEntries.length
      const targetSummaryUpTo = Math.max(0, totalHistory - CHAT_CONTEXT_LAST_N)

      let nextSummary = currentChatSummary
      let nextSummaryUpTo = currentChatSummaryUpTo
      if (totalHistory >= CHAT_SUMMARY_TARGET && targetSummaryUpTo > currentChatSummaryUpTo) {
        const toSummarize = historyEntries.slice(currentChatSummaryUpTo, targetSummaryUpTo)
        const summaryInput = formatChatEntriesForSummary(toSummarize)
        if (summaryInput.trim().length > 0) {
          const summaryPrompt = [
            {
              role: 'system' as const,
              content:
                'Summarize the conversation so far in a concise paragraph. ' +
                'Focus on facts, decisions, and open questions. Do not speculate.',
            },
            {
              role: 'user' as const,
              content: nextSummary
                ? `Existing summary:\n${nextSummary}\n\nNew messages:\n${summaryInput}`
                : `Conversation:\n${summaryInput}`,
            },
          ]
          try {
            const summaryResponse = await ollamaChat(chatModel, summaryPrompt)
            nextSummary = summaryResponse.content.trim()
            nextSummaryUpTo = targetSummaryUpTo
            setChatSummaryByBoard((prev) => ({ ...prev, [currentBoardId]: nextSummary }))
            setChatSummaryUpToByBoard((prev) => ({ ...prev, [currentBoardId]: nextSummaryUpTo }))
          } catch (err) {
            console.warn('summary failed', err)
          }
        }
      }

      const historyWindow = historyEntries.slice(Math.max(0, historyEntries.length - CHAT_CONTEXT_LAST_N))
      const historyPayload: ChatMessage[] = historyWindow.map(({ role, content }) => ({
        role,
        content,
      }))
      const summaryMessage: ChatMessage[] = nextSummary
        ? [{ role: 'system', content: `Chat summary:\n${nextSummary}` }]
        : []

      const response = await ollamaChat(chatModel, [
        ...systemMessages,
        ...summaryMessage,
        ...historyPayload,
        userPayload,
      ])
      const responseEntry: ChatEntry = {
        id: nanoid(),
        role: 'assistant',
        content: response.content,
        createdAt: Date.now(),
        sessionId,
      }
      const finalMessages = [...nextMessages, responseEntry]
      setChatByBoard((prev) => ({ ...prev, [currentBoardId]: finalMessages }))
      setChatStatus('idle')

      const updatedStore: ChatStore = {
        version: 1,
        messages: finalMessages,
        summary: nextSummary || undefined,
        summaryUpTo: nextSummaryUpTo,
        lastSessionId: sessionId,
      }
      saveChat(currentBoardId, updatedStore).catch((err) => {
        console.error('chat save failed', err)
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Failed to contact Ollama'
      setChatStatus('error')
      setChatError(
        `Could not reach Ollama at http://127.0.0.1:11434. ` +
          `Ensure it is running and the model "${chatModel}" is installed. (${detail})`,
      )
    }
  }

function renderLinkedText(text: string) {
  const parts: React.ReactNode[] = []
  if (!text) return parts
  const regex = /\bhttps?:\/\/[^\s<>()]+/gi
  let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text))) {
      const raw = match[0]
      const trimmed = raw.replace(/[),.;!?]+$/g, '')
      const index = match.index
      if (index > lastIndex) {
        parts.push(text.slice(lastIndex, index))
      }
      parts.push(
        <a
          key={`${index}-${trimmed}`}
          className="cardLinkInline"
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            openLink(trimmed)
          }}
        >
          {trimmed}
        </a>,
      )
      lastIndex = index + raw.length
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts
}

function renderBoldText(text: string) {
  const nodes: React.ReactNode[] = []
  if (!text) return nodes
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('**', i)
    if (start === -1) {
      nodes.push(...renderLinkedText(text.slice(i)))
      break
    }
    if (start > i) {
      nodes.push(...renderLinkedText(text.slice(i, start)))
    }
    const end = text.indexOf('**', start + 2)
    if (end === -1) {
      nodes.push(...renderLinkedText(text.slice(start)))
      break
    }
    const boldText = text.slice(start + 2, end)
    nodes.push(<strong key={`bold-${start}-${end}`}>{renderLinkedText(boldText)}</strong>)
    i = end + 2
  }
  return nodes
}

function applyBoldFormatting(value: string, start: number, end: number) {
  const hasSelection = end > start
  const before = value.slice(0, start)
  const selected = value.slice(start, end)
  const after = value.slice(end)
  const isWrapped =
    start >= 2 &&
    value.slice(start - 2, start) === '**' &&
    end + 2 <= value.length &&
    value.slice(end, end + 2) === '**'
  const isWrappedSelection =
    selected.length >= 4 && selected.startsWith('**') && selected.endsWith('**')

  if (isWrapped) {
    const next = value.slice(0, start - 2) + selected + value.slice(end + 2)
    return { value: next, selectionStart: start - 2, selectionEnd: end - 2 }
  }
  if (isWrappedSelection) {
    const inner = selected.slice(2, -2)
    const next = before + inner + after
    return { value: next, selectionStart: start, selectionEnd: start + inner.length }
  }

  const wrapStart = hasSelection ? start : start
  const wrapEnd = hasSelection ? end : start
  const next = before + '**' + selected + '**' + after
  const caretStart = wrapStart + 2
  const caretEnd = hasSelection ? wrapEnd + 2 : wrapStart + 2
  return { value: next, selectionStart: caretStart, selectionEnd: caretEnd }
}

function isChatEntryForModel(
  entry: ChatEntry,
): entry is ChatEntry & { role: 'user' | 'assistant' } {
  return entry.role === 'user' || entry.role === 'assistant'
}

function formatChatEntriesForSummary(entries: ChatEntry[]) {
  return entries
    .filter(isChatEntryForModel)
    .map((entry) => `${entry.role === 'user' ? 'User' : 'Assistant'}: ${entry.content}`)
    .join('\n')
}

  return (
    <div className={`app${isChatOpen ? ' app--chat-open' : ''}`}>
      <div className={`drawer${isDrawerOpen ? ' drawer--open' : ''}`}>
        <div className="drawerHeaderRow">
          <div className="drawerHeader">Boards</div>
          <button className="btn drawerNew" onClick={() => void createNewBoard()} type="button">
            New board
          </button>
        </div>
        <div className="drawerList">
          {sortedBoards.map((item) => (
            <div
              key={item.id}
              className={`drawerItem${item.id === currentBoardId ? ' is-active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => switchBoard(item.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') switchBoard(item.id)
              }}
            >
              <div className="drawerItemName">{item.name}</div>
              <button
                className="drawerDelete"
                onClick={(e) => {
                  e.stopPropagation()
                  setPendingBoardDelete({ id: item.id, name: item.name })
                }}
                aria-label={`Delete board ${item.name}`}
                type="button"
              >
                <TrashCan size={16} />
              </button>
            </div>
          ))}
        </div>
        {trashedBoards.length ? (
          <div className="drawerTrash">
            <div className="drawerTrashHeader">
              <div className="drawerTrashTitle">Trash</div>
              <button
                className="drawerTrashAction"
                onClick={(e) => {
                  e.stopPropagation()
                  setPendingTrashEmpty({ pending: true })
                }}
                type="button"
              >
                Empty
              </button>
            </div>
            {trashedBoards.map((item) => (
              <div key={item.id} className="drawerTrashItem">
                <div className="drawerTrashName">{item.name}</div>
                <button
                  className="drawerRestore"
                  onClick={(e) => {
                    e.stopPropagation()
                    void restoreTrashedBoard(item)
                  }}
                  type="button"
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {isDrawerOpen ? (
        <button
          className="drawerOverlay"
          onClick={() => setIsDrawerOpen(false)}
          aria-label="Close boards drawer"
          type="button"
        />
      ) : null}
      <div className={`chatPanel${isChatOpen ? ' chatPanel--open' : ''}`}>
        <div className="chatHeader">
          <div className="chatHeaderLeft">
            <div className="chatTitle">
              <span>Chat with LANA</span>
            </div>
          </div>
          <button
            className="zoomPill zoomPill--icon chatSettings"
            onClick={openChatSettings}
            aria-label="Open chat settings"
            type="button"
          >
            <SettingsAdjust size={16} />
          </button>
        </div>
        <div className="chatBody">
          {currentChatMessages.length === 0 ? (
            <div className="chatEmpty">
              {chatModel.trim() ? (
                <div className="chatEmptyActions">
                  <button className="btn" onClick={() => void sendChatMessage('Summarize this board.')} type="button">
                    Summarize board
                  </button>
                  <button className="btn" onClick={() => void sendChatMessage('List action items.')} type="button">
                    List action items
                  </button>
                </div>
              ) : (
                <div className="chatEmptyTitle">
                  Choose a model in{' '}
                  <button className="chatEmptyLink" onClick={openChatSettings} type="button">
                    Chat Settings
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="chatMessages">
              {currentChatMessages.map((message) => (
                <div key={message.id} className={`chatMessage chatMessage--${message.role}`}>
                  {message.role === 'system-note' || message.role === 'user' ? null : (
                    <div className="chatMessageRole">
                      {message.role === 'assistant' ? (
                        <img className="chatMessageRoleAvatar" src={assistantAvatar} alt="" aria-hidden="true" />
                      ) : null}
                      <span>{message.role === 'assistant' ? 'LANA' : 'System'}</span>
                    </div>
                  )}
                  <div className="chatMessageContent">{message.content}</div>
                </div>
              ))}
              {chatStatus === 'sending' ? <div className="chatTyping">Thinking…</div> : null}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        <form
          className="chatComposer"
          onSubmit={(e) => {
            e.preventDefault()
            void sendChatMessage(currentChatInput)
          }}
        >
          <textarea
            className="chatInput"
            placeholder={chatModel.trim() ? 'Ask about the board…' : 'Choose a model in Chat Settings'}
            value={currentChatInput}
            disabled={!chatModel.trim()}
            onChange={(e) => {
              if (!currentBoardId) return
              setChatInputByBoard((prev) => ({ ...prev, [currentBoardId]: e.target.value }))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void sendChatMessage(currentChatInput)
              }
            }}
          />
          <button
            className="btn chatSend"
            type="submit"
            disabled={
              !chatModel.trim() || !currentChatInput.trim() || chatStatus === 'sending' || !currentBoardId
            }
          >
            Send
          </button>
        </form>
        {chatError ? <div className="chatError">{chatError}</div> : null}
      </div>
      <div className="topbar">
        <div className="title">
          <button
            className={`btn btn--icon drawerToggle${isDrawerOpen ? ' is-open' : ''}`}
            onClick={() => setIsDrawerOpen((prev) => !prev)}
            aria-label="Toggle boards drawer"
            aria-expanded={isDrawerOpen}
            type="button"
          >
            <Menu size={20} />
          </button>
          {isEditingBoardName ? (
            <input
              ref={(el) => {
                editingBoardNameInputRef.current = el
              }}
              className="boardNameInput"
              value={editingBoardName}
              onChange={(e) => setEditingBoardName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitEditingBoardTitle()
                if (e.key === 'Escape') cancelEditingBoardTitle()
              }}
              onBlur={() => commitEditingBoardTitle()}
            />
          ) : (
            <div className="boardName" onDoubleClick={() => startEditingBoardTitle()}>
              {board.name}
            </div>
          )}
          <div className="boardMetaRight">{cards.length} cards</div>
        </div>
        <div className="actions">
          <button
            className={`btn btn--icon${isChatOpen ? ' is-active' : ''}`}
            onClick={() => setIsChatOpen((prev) => !prev)}
            aria-label="Toggle board chat"
            aria-expanded={isChatOpen}
            type="button"
          >
            {isChatOpen ? <RightPanelClose size={20} /> : <Chat size={20} />}
          </button>
        </div>
      </div>

      <div className="canvas">
        <div className="floatingToolbar">
          <button className="btn btn--icon" onClick={addTextCard} aria-label="New card" title="New Card">
            <NewTab size={24} />
          </button>
          {(() => {
            const isDetaching = selectedColumnIds.length > 0
            const selectedHasListedCard = selectedIds.some(
              (id) => getCardColumnId(board.columns ?? [], id) != null,
            )
            const canCreateList = selectedIds.length > 0 && !selectedHasListedCard
            const label = isDetaching ? 'Detach cards' : 'Create list'
            const title = isDetaching
              ? label
              : !canCreateList
                ? 'Remove card(s) from a list before creating a new list'
                : `${label} (L)`
            return (
          <button
            className={`btn btn--icon${isDetaching ? ' btn--danger' : ''}`}
            disabled={isDetaching ? false : !canCreateList}
            aria-label={label}
            title={title}
            onClick={() => {
              if (selectedColumnIdsRef.current.length) {
                detachSelectedColumns()
                return
              }
              createListFromSelection()
            }}
          >
            {isDetaching ? <Grid size={24} /> : <ArrangeVertical size={24} />}
          </button>
            )
          })()}
        </div>
        <TransformWrapper
          minScale={MIN_SCALE}
          maxScale={MAX_SCALE}
          initialScale={1}
          // Disable built-in wheel zoom/pan so we can map trackpad gestures:
          // - scroll -> pan
          // - pinch (ctrl+wheel) -> zoom
          wheel={{ disabled: true }}
          doubleClick={{ disabled: true }}
          onInit={(ref) => {
            transformRef.current = ref as unknown as {
              instance: { wrapperComponent: HTMLDivElement | null }
              state: { scale: number; positionX: number; positionY: number }
              setTransform: (
                newPositionX: number,
                newPositionY: number,
                newScale: number,
                animationTime?: number,
              ) => void
            }

            // Start centered at 25% / 25% of the board so there's room in all directions.
            const wrapper = (ref as unknown as { instance: { wrapperComponent: HTMLDivElement | null } })
              .instance.wrapperComponent
            if (!wrapper) return
            setPanZoomEl(wrapper)

            const scale = (ref as unknown as { state: { scale: number } }).state.scale ?? 1
            const x = wrapper.clientWidth / 2 - BOARD_START_X * scale
            const y = wrapper.clientHeight / 2 - BOARD_START_Y * scale
            commitTransform(x, y, scale, 0)
          }}
          onTransformed={(ref, next) => {
            transformRef.current = ref as unknown as {
              instance: { wrapperComponent: HTMLDivElement | null }
              state: { scale: number; positionX: number; positionY: number }
              setTransform: (
                newPositionX: number,
                newPositionY: number,
                newScale: number,
                animationTime?: number,
              ) => void
            }
            transformStateRef.current = {
              scale: next.scale,
              positionX: next.positionX,
              positionY: next.positionY,
            }

            // Only update React state when *scale* changes (avoid re-rendering on every pan).
            if (Math.abs(next.scale - zoomScaleRef.current) > 0.0001) {
              zoomScaleRef.current = next.scale
              setZoomScale(next.scale)
            }
          }}
          // During card drag/resize, disable panning so the card "wins".
          // Also exclude card elements so a click-drag on them doesn't start a pan.
          panning={{
            disabled: isCardInteracting || isSelecting,
            allowLeftClickPan: false,
            // react-zoom-pan-pinch uses KeyboardEvent.key (spacebar is " ")
            activationKeys: [' '],
            allowMiddleClickPan: true,
            allowRightClickPan: true,
            excluded: [
              // our card UI
              'card',
              'cardHeader',
              'cardBody',
              // common react-rnd / react-draggable / react-resizable classes
              'react-rnd',
              'react-draggable',
              'react-resizable',
              'react-resizable-handle',
              // form elements
              'textarea',
              'input',
              'button',
            ],
          }}
        >
          <TransformComponent
            wrapperStyle={{ width: '100%', height: '100%' }}
          >
            <div
              className="boardSurface"
              onDoubleClick={(e) => {
                const target = e.target as HTMLElement
                if (
                  target.closest('.card') ||
                  target.closest('.react-rnd') ||
                  target.closest('.react-draggable') ||
                  target.closest('.columnWidget')
                ) {
                  return
                }

                const pt = clientToBoardPoint(e.clientX, e.clientY)
                if (!pt) return
                addTextCardAt(pt.x, pt.y)
              }}
              onPointerDown={onBoardPointerDown}
              onPointerMove={onBoardPointerMove}
              onPointerUp={finishSelection}
              onPointerCancel={finishSelection}
              onPointerLeave={finishSelection}
              style={{
                width: `${BOARD_WIDTH}px`,
                height: `${BOARD_HEIGHT}px`,
              }}
            >
              {dupGhost ? (() => {
                const columns =
                  dupGhost.kind === 'selection'
                    ? dupGhost.snapshot.columns
                    : dupGhost.kind === 'column'
                      ? [dupGhost.snapshot]
                      : []
                const cards =
                  dupGhost.kind === 'selection'
                    ? dupGhost.snapshot.cards
                    : dupGhost.kind === 'card'
                      ? [dupGhost.snapshot]
                      : []

                return (
                  <div className="dupGhostLayer">
                    {columns.map((dup) => {
                      const headerH = getColumnHeaderHeight(dup.sourceColumnId)
                      const contentH = dupColumnSnapshotContentHeight(dup)
                      const left = dup.snapshot.x - COLUMN_PADDING
                      const top = dup.snapshot.y - headerH - COLUMN_PADDING
                      const width = CARD_WIDTH + COLUMN_PADDING * 2
                      const height = headerH + COLUMN_PADDING * 2 + contentH
                      return (
                        <div
                          key={`ghost-col-${dup.sourceColumnId}`}
                          className="dupGhostItem"
                          style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}
                        >
                          <div
                            className="columnContainer columnContainer--ghost"
                            style={{ ['--column-header-h' as any]: `${headerH}px` }}
                          >
                            <div className="columnHeader columnHeader--ghost">
                              <div className="columnTitle">{dup.snapshot.name || 'List'}</div>
                            </div>
                            <div className="columnBody" />
                          </div>
                        </div>
                      )
                    })}
                    {cards.map((dup) => (
                      <div
                        key={`ghost-card-${dup.sourceCardId}`}
                        className="dupGhostItem"
                        style={{
                          left: `${dup.snapshot.x}px`,
                          top: `${dup.snapshot.y}px`,
                          width: `${CARD_WIDTH}px`,
                          height: `${dup.snapshot.height}px`,
                        }}
                      >
                        <div className="card card--ghost">
                          <div className="cardHeader" />
                          <div className="cardBody" />
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })() : null}
              {listDetachPreview ? (
                <div className="multiDetachPreviewLayer">
                  {listDetachPreview.cardIds
                    .filter((id) => id !== listDetachPreview.anchorId)
                    .map((id) => {
                      const init = listDetachPreview.initial[id]
                      const c = board.cards.find((cc) => cc.id === id)
                      if (!init || !c) return null
                      const x = init.x + listDetachPreview.deltaX
                      const y = init.y + listDetachPreview.deltaY
                      return (
                        <div
                          key={`detach-preview-${id}`}
                          className="multiDetachPreviewItem"
                          style={{ left: `${x}px`, top: `${y}px`, width: `${CARD_WIDTH}px`, height: `${c.height}px` }}
                        >
                          <div className="card card--detachPreview card--selected">
                            <div className="cardHeader" />
                            <div className="cardBody" />
                          </div>
                        </div>
                      )
                    })}
                </div>
              ) : null}
              {board.columns.map((col) => (
                // The column container is a draggable header + a background wrapper behind cards.
                (() => {
                  const headerH = getColumnHeaderHeight(col.id)
                  return (
                <Rnd
                  key={col.id}
                  className="columnWidget"
                  scale={zoomScale}
                  enableResizing={false}
                  disableDragging={editingColumnId === col.id}
                  dragHandleClassName="columnHeader"
                  enableUserSelectHack={false}
                  position={{
                    x: col.x - COLUMN_PADDING,
                    y: col.y - headerH - COLUMN_PADDING,
                  }}
                  size={{
                    width: CARD_WIDTH + COLUMN_PADDING * 2,
                    height:
                      headerH + COLUMN_PADDING * 2 + getColumnContentHeight(board, col),
                  }}
                  onDragStart={(e) => {
                    setIsCardInteracting(true)
                    dupSelectionRef.current = null
                    selectionDragRef.current = null
                    setDupGhost(null)

                    const selectionStarted = startSelectionDrag('column', col.id, col.x, col.y)

                    if (isAltDragEvent(e)) {
                      const sel = buildDupSelectionSnapshot(board, undefined, col.id)
                      if (sel) {
                        dupSelectionRef.current = { ownerType: 'column', ownerId: col.id, snapshot: sel }
                        dupColumnDragRef.current = null
                        setDupGhost({ kind: 'selection', snapshot: sel })
                      } else if (!selectionStarted) {
                        const single: DupColumnDrag = {
                          sourceColumnId: col.id,
                          snapshot: {
                            name: col.name,
                            x: col.x,
                            y: col.y,
                            width: col.width,
                            gap: col.gap,
                            cardIds: [...col.cardIds],
                          },
                          cardSnapshots: (board.cards ?? [])
                            .filter((c) => col.cardIds.includes(c.id))
                            .map((c) =>
                              c.type === 'image'
                                ? ({
                                    id: c.id,
                                    type: 'image',
                                    src: c.src,
                                    naturalWidth: c.naturalWidth,
                                    naturalHeight: c.naturalHeight,
                                    note: c.note,
                                    noteExpanded: c.noteExpanded,
                                    height: c.height,
                                  } satisfies DupColumnCardSnapshot)
                                : c.type === 'link'
                                  ? ({
                                      id: c.id,
                                      type: 'link',
                                      url: c.url,
                                      title: c.title,
                                      image: c.image,
                                      siteName: c.siteName,
                                      note: c.note,
                                      noteExpanded: c.noteExpanded,
                                      height: c.height,
                                    } satisfies DupColumnCardSnapshot)
                                  : ({
                                      id: c.id,
                                      type: 'text',
                                      text: c.text,
                                      height: c.height,
                                    } satisfies DupColumnCardSnapshot),
                            ),
                        }
                        dupColumnDragRef.current = single
                        setDupGhost({ kind: 'column', snapshot: single })
                      } else {
                        dupColumnDragRef.current = null
                      }
                    } else {
                      dupColumnDragRef.current = null
                    }
                  }}
                  onDrag={(_, d) => {
                    const sd = selectionDragRef.current
                    if (sd && sd.anchorType === 'column' && sd.anchorId === col.id) {
                      const curX = d.x + COLUMN_PADDING
                      const curY = d.y + headerH + COLUMN_PADDING
                      moveSelectionDrag(curX - sd.startContentX, curY - sd.startContentY, false)
                      return
                    }

                    // Update the column position live (RAF throttled) so cards move with it.
                    const nextX = d.x + COLUMN_PADDING
                    const nextY = d.y + headerH + COLUMN_PADDING
                    pendingColumnDragRef.current = { columnId: col.id, x: nextX, y: nextY }

                    if (!columnDragRafRef.current) {
                      columnDragRafRef.current = window.requestAnimationFrame(() => {
                        columnDragRafRef.current = null
                        const pending = pendingColumnDragRef.current
                        if (!pending) return

                        setBoard((prev) => {
                          if (!prev) return prev
                          const columns = (prev.columns ?? []).map((c) =>
                            c.id === pending.columnId ? { ...c, x: pending.x, y: pending.y } : c,
                          )
                          return layoutBoard({ ...prev, columns })
                        })
                      })
                    }
                  }}
                  onDragStop={(_, d) => {
                    const sd = selectionDragRef.current
                    if (sd && sd.anchorType === 'column' && sd.anchorId === col.id) {
                      setDupGhost(null)
                      const curX = d.x + COLUMN_PADDING
                      const curY = d.y + headerH + COLUMN_PADDING
                      const deltaX = curX - sd.startContentX
                      const deltaY = curY - sd.startContentY

                      moveSelectionDrag(deltaX, deltaY, true)
                      selectionDragRef.current = null

                      const dupSel =
                        dupSelectionRef.current?.ownerType === 'column' && dupSelectionRef.current.ownerId === col.id
                          ? dupSelectionRef.current.snapshot
                          : null
                      if (dupSel) dupSelectionRef.current = null

                      if (dupSel) {
                        setBoard((prev) => (prev ? injectDuplicateSelection(prev, dupSel) : prev))
                      }

                      setIsCardInteracting(false)
                      return
                    }

                    setDupGhost(null)
                    const nextX = snapToGrid(d.x + COLUMN_PADDING, GRID_OFFSET)
                    const nextY = snapToGrid(d.y + headerH + COLUMN_PADDING, GRID_OFFSET)

                    if (columnDragRafRef.current) {
                      window.cancelAnimationFrame(columnDragRafRef.current)
                      columnDragRafRef.current = null
                    }
                    pendingColumnDragRef.current = null

                    const dupSel =
                      dupSelectionRef.current?.ownerType === 'column' && dupSelectionRef.current.ownerId === col.id
                        ? dupSelectionRef.current.snapshot
                        : null
                    if (dupSel) dupSelectionRef.current = null

                    const dup = dupSel
                      ? null
                      : dupColumnDragRef.current?.sourceColumnId === col.id
                        ? dupColumnDragRef.current
                        : null
                    dupColumnDragRef.current = null

                    setBoard((prev) => {
                      if (!prev) return prev
                      const columns = (prev.columns ?? []).map((c) =>
                        c.id === col.id ? { ...c, x: nextX, y: nextY, width: CARD_WIDTH } : c,
                      )
                      let next = layoutBoard({ ...prev, columns })
                      if (dup) next = injectDuplicateColumn(next, dup)
                      if (dupSel) next = injectDuplicateSelection(next, dupSel)
                      return next
                    })
                    setIsCardInteracting(false)
                  }}
                >
                  <div
                    className={`columnContainer${
                      selectedColumnIds.includes(col.id) ? ' columnContainer--selected' : ''
                    }`}
                    style={{ ['--column-header-h' as any]: `${headerH}px` }}
                  >
                    <div
                      className={`columnHeader${columnDrop?.columnId === col.id ? ' columnHeader--drop' : ''}${
                        editingColumnId === col.id ? ' columnHeader--editing' : ''
                      }`}
                      onMouseDown={(e) => maybeSelectColumnOnMouseDown(e, col.id)}
                      onDoubleClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        startEditingColumn(col)
                      }}
                    >
                      {editingColumnId === col.id ? (
                        <input
                          ref={(el) => {
                            editingColumnInputRef.current = el
                          }}
                          className="columnTitleInput"
                          value={editingColumnName}
                          onChange={(e) => setEditingColumnName(e.target.value)}
                          onMouseDown={(e) => {
                            e.stopPropagation()
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEditingColumn()
                            if (e.key === 'Escape') cancelEditingColumn()
                          }}
                          onBlur={() => commitEditingColumn()}
                        />
                      ) : (
                        <div className="columnTitle">{col.name || 'List'}</div>
                      )}
                    </div>
                    <div className="columnBody" />
                  </div>
                </Rnd>
                  )
                })()
              ))}
              {columnDrop ? (
                <div
                  className="columnInsertLine"
                  style={{
                    left: `${(board.columns ?? []).find((c) => c.id === columnDrop.columnId)!.x}px`,
                    top: `${columnDrop.lineY}px`,
                    width: `${CARD_WIDTH}px`,
                  }}
                />
              ) : null}
              {selection ? (() => {
                const { left, right, top, bottom } = selectionBounds(selection)
                const x = left
                const y = top
                const w = right - left
                const h = bottom - top
                return (
                  <div
                    className="selectionBox"
                    style={{ left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }}
                  />
                )
              })() : null}
              {cards.map((card) => (
                <Rnd
                  key={card.id}
                  // drag snapping happens on drop (dot-grid aligned)
                  scale={zoomScale}
                  enableResizing={false}
                  position={{ x: card.x, y: card.y }}
                  size={{ width: CARD_WIDTH, height: card.height }}
                  onDragStart={(e, d) => {
                    setIsCardInteracting(true)
                    dupSelectionRef.current = null
                    selectionDragRef.current = null
                    setDupGhost(null)
                    listDetachDragRef.current = null
                    scheduleListDetachPreview(null)

                    const selectionStarted = startSelectionDrag('card', card.id, d.x, d.y)
                    scheduleColumnDrop(null)

                    // If dragging a selected card that lives in a list, allow multi-detach-on-drop
                    // (dragging them out of the list together).
                    const anchorColId = getCardColumnId(board.columns ?? [], card.id)
                    if (anchorColId && selectedIdsRef.current.includes(card.id)) {
                      const selectedInSameCol = selectedIdsRef.current.filter(
                        (id) => getCardColumnId(board.columns ?? [], id) === anchorColId,
                      )
                      if (selectedInSameCol.length > 1) {
                        const initial: Record<string, { x: number; y: number }> = {}
                        for (const id of selectedInSameCol) {
                          const c = board.cards.find((cc) => cc.id === id)
                          if (!c) continue
                          initial[id] = { x: c.x, y: c.y }
                        }
                        if (Object.keys(initial).length > 1) {
                          listDetachDragRef.current = {
                            anchorId: card.id,
                            columnId: anchorColId,
                            cardIds: selectedInSameCol,
                            initial,
                          }
                        }
                      }
                    }

                    if (isAltDragEvent(e)) {
                      const sel = buildDupSelectionSnapshot(board, card.id, undefined)
                      if (sel) {
                        dupSelectionRef.current = { ownerType: 'card', ownerId: card.id, snapshot: sel }
                        dupCardDragRef.current = null
                        setDupGhost({ kind: 'selection', snapshot: sel })
                      } else if (!selectionStarted) {
                        const sourceColumnId = getCardColumnId(board.columns ?? [], card.id)
                        const sourceIndex =
                          sourceColumnId != null
                            ? (board.columns ?? [])
                                .find((c) => c.id === sourceColumnId)
                                ?.cardIds.indexOf(card.id) ?? null
                            : null

                        const single: DupCardDrag = {
                          sourceCardId: card.id,
                          sourceColumnId,
                          sourceIndex,
                          snapshot:
                            card.type === 'image'
                              ? {
                                  type: 'image',
                                  x: card.x,
                                  y: card.y,
                                  height: card.height,
                                  src: card.src,
                                  naturalWidth: card.naturalWidth,
                                  naturalHeight: card.naturalHeight,
                                  note: card.note,
                                  noteExpanded: card.noteExpanded,
                                }
                              : card.type === 'link'
                                ? {
                                    type: 'link',
                                    x: card.x,
                                    y: card.y,
                                    height: card.height,
                                    url: card.url,
                                    title: card.title,
                                    image: card.image,
                                    siteName: card.siteName,
                                    note: card.note,
                                    noteExpanded: card.noteExpanded,
                                  }
                                : { type: 'text', x: card.x, y: card.y, height: card.height, text: card.text },
                        }
                        dupCardDragRef.current = single
                        setDupGhost({ kind: 'card', snapshot: single })
                      } else {
                        dupCardDragRef.current = null
                      }
                    } else {
                      dupCardDragRef.current = null
                    }
                  }}
                  onDrag={(_, d) => {
                    const sd = selectionDragRef.current
                    if (sd && sd.anchorType === 'card' && sd.anchorId === card.id) {
                      const deltaX = d.x - sd.startContentX
                      const deltaY = d.y - sd.startContentY
                      moveSelectionDrag(deltaX, deltaY, false)
                      const drop = computeColumnDropTarget(
                        board,
                        d.x,
                        d.y,
                        card.height,
                        card.id,
                      )
                      scheduleColumnDrop(drop)
                      return
                    }

                    const group = listDetachDragRef.current
                    if (group && group.anchorId === card.id) {
                      const col = (board.columns ?? []).find((c) => c.id === group.columnId)
                      const distFromColumn = col ? Math.abs(d.x - col.x) : 0
                      if (distFromColumn > GROUP_DETACH_PREVIEW_THRESHOLD) {
                        const anchorInit = group.initial[card.id]
                        if (anchorInit) {
                          scheduleListDetachPreview({
                            anchorId: group.anchorId,
                            columnId: group.columnId,
                            cardIds: group.cardIds,
                            initial: group.initial,
                            deltaX: d.x - anchorInit.x,
                            deltaY: d.y - anchorInit.y,
                          })
                        }
                      } else {
                        scheduleListDetachPreview(null)
                      }
                    }

                    const drop = computeColumnDropTarget(
                      board,
                      d.x,
                      d.y,
                      card.height,
                      card.id,
                    )
                    scheduleColumnDrop(drop)
                  }}
                  onDragStop={(_, d) => {
                    setDupGhost(null)
                    scheduleListDetachPreview(null)
                    const dupSel =
                      dupSelectionRef.current?.ownerType === 'card' && dupSelectionRef.current.ownerId === card.id
                        ? dupSelectionRef.current.snapshot
                        : null
                    if (dupSel) dupSelectionRef.current = null

                    const dup =
                      dupSel || dupCardDragRef.current?.sourceCardId !== card.id
                        ? null
                        : dupCardDragRef.current
                    dupCardDragRef.current = null

                    const applyDup = (b: Board) => {
                      let out = b
                      if (dup) out = injectDuplicateCard(out, dup)
                      if (dupSel) out = injectDuplicateSelection(out, dupSel)
                      return out
                    }

                    const sd = selectionDragRef.current
                    if (sd && sd.anchorType === 'card' && sd.anchorId === card.id) {
                      const rawDeltaX = d.x - sd.startContentX
                      const rawDeltaY = d.y - sd.startContentY
                      const { dx, dy } = computeSelectionDragDelta(sd, rawDeltaX, rawDeltaY, true)

                      // Support dropping multiple selected (free) cards into a list.
                      setBoard((prev) => {
                        if (!prev) return prev

                        const movedColumnSet = new Set(Object.keys(sd.initialColumns))
                        const columnsMoved = (prev.columns ?? []).map((col) => {
                          const init = sd.initialColumns[col.id]
                          if (!init) return col
                          return { ...col, x: init.x + dx, y: init.y + dy, width: CARD_WIDTH }
                        })

                        const cardsMoved = prev.cards.map((c) => {
                          const init = sd.initialCards[c.id]
                          if (!init) return c
                          const colId = getCardColumnId(prev.columns ?? [], c.id)
                          if (colId && movedColumnSet.has(colId)) return c
                          if (colId) return c
                          return { ...c, x: init.x + dx, y: init.y + dy, width: CARD_WIDTH }
                        })

                        let next = layoutBoard({ ...prev, columns: columnsMoved, cards: cardsMoved })

                        const movingCardIds = Object.keys(sd.initialCards)
                        const hasColumnsSelected = Object.keys(sd.initialColumns).length > 0
                        if (!hasColumnsSelected && movingCardIds.length > 1) {
                          const anchorInitial = sd.initialCards[sd.anchorId]
                          const anchorX = (anchorInitial?.x ?? d.x) + dx
                          const anchorY = (anchorInitial?.y ?? d.y) + dy
                          const drop = computeColumnDropTarget(next, anchorX, anchorY, card.height, card.id)
                          if (drop) {
                            const movingSet = new Set(movingCardIds)
                            const orderIndex = new Map(next.cards.map((c, idx) => [c.id, idx]))
                            const ordered = movingCardIds
                              .map((id) => {
                                const init = sd.initialCards[id]
                                return { id, x: (init?.x ?? 0) + dx, y: (init?.y ?? 0) + dy, idx: orderIndex.get(id) ?? 0 }
                              })
                              .sort((a, b) => {
                                if (a.y !== b.y) return a.y - b.y
                                if (a.x !== b.x) return a.x - b.x
                                return a.idx - b.idx
                              })
                              .map((x) => x.id)

                            let nextColumns = next.columns ?? []
                            for (const id of ordered) nextColumns = removeCardFromAllColumns(nextColumns, id, drop.columnId)
                            nextColumns = nextColumns.map((c) => {
                              if (c.id !== drop.columnId) return c
                              const without = c.cardIds.filter((id) => !movingSet.has(id))
                              const idx = clamp(drop.index, 0, without.length)
                              const cardIds = [...without.slice(0, idx), ...ordered, ...without.slice(idx)]
                              return { ...c, cardIds }
                            })

                            next = layoutBoard({ ...next, columns: nextColumns })
                          }
                        }

                        return dupSel ? applyDup(next) : next
                      })

                      selectionDragRef.current = null
                      scheduleColumnDrop(null)
                      setIsCardInteracting(false)
                      return
                    }

                    // If this card is in a column, allow dragging it out to remove from the list.
                    const boardX = d.x
                    const boardY = d.y
                    const colId = getCardColumnId(board.columns ?? [], card.id)
                    if (colId) {
                      const drop = computeColumnDropTarget(board, boardX, boardY, card.height, card.id)
                      scheduleColumnDrop(null)

                      // If dropped over a list (same or different), reorder/move into that list.
                      if (drop) {
                        // Option/Alt-dragging a list card should duplicate it into the target list,
                        // keeping the original card in its source list.
                        if (dup || dupSel) {
                          setBoard((prev) => {
                            if (!prev) return prev
                            const src = prev.cards.find((c) => c.id === card.id)
                            if (!src) return prev

                            const fromDup =
                              dup?.sourceCardId === card.id
                                ? dup
                                : dupSel?.cards.find((c) => c.sourceCardId === card.id) ?? null

                            const newId = nanoid()
                            const snap = fromDup?.snapshot
                            const height = snap ? snap.height : src.height

                            const nextCard: Card =
                              (snap?.type ?? src.type) === 'image'
                                ? ({
                                    id: newId,
                                    type: 'image',
                                    width: CARD_WIDTH,
                                    height,
                                    // x/y will be enforced by layout if it goes into a list
                                    x: src.x,
                                    y: src.y,
                                    src:
                                      snap && snap.type === 'image'
                                        ? snap.src
                                        : (src as ImageCard).src,
                                    naturalWidth:
                                      snap && snap.type === 'image'
                                        ? snap.naturalWidth
                                        : (src as ImageCard).naturalWidth,
                                  naturalHeight:
                                      snap && snap.type === 'image'
                                        ? snap.naturalHeight
                                        : (src as ImageCard).naturalHeight,
                                    note: snap && snap.type === 'image' ? snap.note : (src as ImageCard).note,
                                    noteExpanded:
                                      snap && snap.type === 'image'
                                        ? snap.noteExpanded
                                        : (src as ImageCard).noteExpanded,
                                  } satisfies ImageCard)
                                : (snap?.type ?? src.type) === 'link'
                                  ? ({
                                      id: newId,
                                      type: 'link',
                                      width: CARD_WIDTH,
                                      height,
                                      x: src.x,
                                      y: src.y,
                                      url: snap && snap.type === 'link' ? snap.url : (src as LinkCard).url,
                                      title: snap && snap.type === 'link' ? snap.title : (src as LinkCard).title,
                                      image: snap && snap.type === 'link' ? snap.image : (src as LinkCard).image,
                                      siteName:
                                        snap && snap.type === 'link' ? snap.siteName : (src as LinkCard).siteName,
                                      note: snap && snap.type === 'link' ? snap.note : (src as LinkCard).note,
                                      noteExpanded:
                                        snap && snap.type === 'link'
                                          ? snap.noteExpanded
                                          : (src as LinkCard).noteExpanded,
                                    } satisfies LinkCard)
                                  : ({
                                      id: newId,
                                      type: 'text',
                                      width: CARD_WIDTH,
                                      height,
                                      // x/y will be enforced by layout if it goes into a list
                                      x: src.x,
                                      y: src.y,
                                      text:
                                        snap && snap.type === 'text'
                                          ? snap.text
                                          : (src as TextCard).text,
                                    } satisfies TextCard)

                            const columns = (prev.columns ?? []).map((c) => {
                              if (c.id !== drop.columnId) return c
                              const idx = Math.max(0, Math.min(drop.index, c.cardIds.length))
                              const cardIds = [...c.cardIds.slice(0, idx), newId, ...c.cardIds.slice(idx)]
                              return { ...c, cardIds }
                            })

                            return layoutBoard({ ...prev, columns, cards: [...prev.cards, nextCard] })
                          })
                          listDetachDragRef.current = null
                          setIsCardInteracting(false)
                          return
                        }

                        setBoard((prev) => {
                          if (!prev) return prev
                          const columns = prev.columns ?? []
                          const target = columns.find((c) => c.id === drop.columnId)
                          if (!target) return prev

                          // Remove from current list(s), then insert into target at index.
                          let nextColumns = removeCardFromAllColumns(columns, card.id, drop.columnId)
                          nextColumns = nextColumns.map((c) => {
                            if (c.id !== drop.columnId) return c
                            const without = c.cardIds.filter((id) => id !== card.id)
                            const idx = Math.max(0, Math.min(drop.index, without.length))
                            const cardIds = [...without.slice(0, idx), card.id, ...without.slice(idx)]
                            return { ...c, cardIds }
                          })

                          let next = layoutBoard({ ...prev, columns: nextColumns })
                          return applyDup(next)
                        })
                        listDetachDragRef.current = null
                        setIsCardInteracting(false)
                        return
                      }

                      // Otherwise: if far enough horizontally, detach from the list.
                      const col = (board.columns ?? []).find((c) => c.id === colId)
                      const distFromColumn = col ? Math.abs(boardX - col.x) : DRAG_OUT_THRESHOLD + 1
                      if (distFromColumn > DRAG_OUT_THRESHOLD) {
                        // Option/Alt-dragging a list card out should create a free-card duplicate,
                        // and snap the original back into its list.
                        if (dup || dupSel) {
                          const group =
                            listDetachDragRef.current &&
                            listDetachDragRef.current.anchorId === card.id &&
                            listDetachDragRef.current.columnId === colId
                              ? listDetachDragRef.current
                              : null

                          const ids = group?.cardIds?.length ? group.cardIds : [card.id]
                          const initial = group?.initial ?? {}
                          const anchorInitial = initial[card.id] ?? { x: card.x, y: card.y }
                          const dropX = snapToGrid(boardX, GRID_OFFSET)
                          const dropY = snapToGrid(boardY, GRID_OFFSET)
                          const deltaX = dropX - anchorInitial.x
                          const deltaY = dropY - anchorInitial.y

                          setBoard((prev) => {
                            if (!prev) return prev
                            const byId = new Map(prev.cards.map((c) => [c.id, c]))
                            const dupById = new Map((dupSel?.cards ?? []).map((d) => [d.sourceCardId, d]))

                            const nextCards: Card[] = []
                            for (const id of ids) {
                              const src = byId.get(id)
                              if (!src) continue
                              const fromDup = dup?.sourceCardId === id ? dup : dupById.get(id) ?? null
                              const snap = fromDup?.snapshot
                              const h = snap ? snap.height : src.height
                              const newId = nanoid()
                              const init = initial[id] ?? { x: src.x, y: src.y }
                              if ((snap?.type ?? src.type) === 'image') {
                                nextCards.push({
                                  id: newId,
                                  type: 'image',
                                  width: CARD_WIDTH,
                                  height: h,
                                  src:
                                    snap && snap.type === 'image' ? snap.src : (src as ImageCard).src,
                                  naturalWidth:
                                    snap && snap.type === 'image'
                                      ? snap.naturalWidth
                                      : (src as ImageCard).naturalWidth,
                                  naturalHeight:
                                    snap && snap.type === 'image'
                                      ? snap.naturalHeight
                                      : (src as ImageCard).naturalHeight,
                                  note: snap && snap.type === 'image' ? snap.note : (src as ImageCard).note,
                                  noteExpanded:
                                    snap && snap.type === 'image'
                                      ? snap.noteExpanded
                                      : (src as ImageCard).noteExpanded,
                                  x: clamp(snapToGrid(init.x + deltaX, GRID_OFFSET), 0, BOARD_WIDTH - CARD_WIDTH),
                                  y: clamp(snapToGrid(init.y + deltaY, GRID_OFFSET), 0, BOARD_HEIGHT - h),
                                } satisfies ImageCard)
                              } else if ((snap?.type ?? src.type) === 'link') {
                                nextCards.push({
                                  id: newId,
                                  type: 'link',
                                  width: CARD_WIDTH,
                                  height: h,
                                  url: snap && snap.type === 'link' ? snap.url : (src as LinkCard).url,
                                  title: snap && snap.type === 'link' ? snap.title : (src as LinkCard).title,
                                  image: snap && snap.type === 'link' ? snap.image : (src as LinkCard).image,
                                  siteName:
                                    snap && snap.type === 'link' ? snap.siteName : (src as LinkCard).siteName,
                                  note: snap && snap.type === 'link' ? snap.note : (src as LinkCard).note,
                                  noteExpanded:
                                    snap && snap.type === 'link'
                                      ? snap.noteExpanded
                                      : (src as LinkCard).noteExpanded,
                                  x: clamp(snapToGrid(init.x + deltaX, GRID_OFFSET), 0, BOARD_WIDTH - CARD_WIDTH),
                                  y: clamp(snapToGrid(init.y + deltaY, GRID_OFFSET), 0, BOARD_HEIGHT - h),
                                } satisfies LinkCard)
                              } else {
                                nextCards.push({
                                  id: newId,
                                  type: 'text',
                                  width: CARD_WIDTH,
                                  height: h,
                                  text:
                                    snap && snap.type === 'text' ? snap.text : (src as TextCard).text,
                                  x: clamp(snapToGrid(init.x + deltaX, GRID_OFFSET), 0, BOARD_WIDTH - CARD_WIDTH),
                                  y: clamp(snapToGrid(init.y + deltaY, GRID_OFFSET), 0, BOARD_HEIGHT - h),
                                } satisfies TextCard)
                              }
                            }

                            // Keep columns unchanged (originals stay in list).
                            return layoutBoard({ ...prev, cards: [...prev.cards, ...nextCards] })
                          })
                          listDetachDragRef.current = null
                          setIsCardInteracting(false)
                          return
                        }

                        const group =
                          listDetachDragRef.current &&
                          listDetachDragRef.current.anchorId === card.id &&
                          listDetachDragRef.current.columnId === colId
                            ? listDetachDragRef.current
                            : null

                        const ids = group?.cardIds?.length ? group.cardIds : [card.id]
                        const idSet = new Set(ids)
                        const initial = group?.initial ?? {}
                        const anchorInitial = initial[card.id] ?? { x: card.x, y: card.y }
                        const dropX = snapToGrid(boardX, GRID_OFFSET)
                        const dropY = snapToGrid(boardY, GRID_OFFSET)
                        const deltaX = dropX - anchorInitial.x
                        const deltaY = dropY - anchorInitial.y

                        setBoard((prev) => {
                          if (!prev) return prev
                          let nextColumns = prev.columns ?? []
                          for (const id of ids) nextColumns = removeCardFromAllColumns(nextColumns, id)

                          const nextCards = prev.cards.map((c) => {
                            if (!idSet.has(c.id)) return c
                            const init = initial[c.id] ?? { x: c.x, y: c.y }
                            return {
                              ...c,
                              x: clamp(snapToGrid(init.x + deltaX, GRID_OFFSET), 0, BOARD_WIDTH - CARD_WIDTH),
                              y: clamp(snapToGrid(init.y + deltaY, GRID_OFFSET), 0, BOARD_HEIGHT - c.height),
                              width: CARD_WIDTH,
                            }
                          })

                          const next = { ...prev, columns: nextColumns, cards: nextCards }
                          return applyDup(layoutBoard(next))
                        })
                        listDetachDragRef.current = null
                        setIsCardInteracting(false)
                        return
                      }

                      // Otherwise, snap back into the column (layout will enforce).
                      // (For list cards, Option/Alt-duplication is handled via drop/detach cases above.)
                      listDetachDragRef.current = null
                      setIsCardInteracting(false)
                      return
                    }

                    const drop = computeColumnDropTarget(
                      board,
                      d.x,
                      d.y,
                      card.height,
                      card.id,
                    )
                    scheduleColumnDrop(null)
                    if (drop) {
                      const boardX = d.x
                      const boardY = d.y
                      setBoard((prev) => {
                        if (!prev) return prev
                        const columns = prev.columns ?? []
                        const target = columns.find((c) => c.id === drop.columnId)
                        if (!target) return prev

                        let nextColumns = removeCardFromAllColumns(columns, card.id)
                        nextColumns = nextColumns.map((c) => {
                          if (c.id !== drop.columnId) return c
                          const without = c.cardIds.filter((id) => id !== card.id)
                          const idx = Math.max(0, Math.min(drop.index, without.length))
                          const cardIds = [...without.slice(0, idx), card.id, ...without.slice(idx)]
                          return { ...c, cardIds }
                        })

                        const next = {
                          ...prev,
                          columns: nextColumns,
                          cards: prev.cards.map((c) =>
                            c.id === card.id
                              ? {
                                  ...c,
                                  x: clamp(snapToGrid(boardX, GRID_OFFSET), 0, BOARD_WIDTH - CARD_WIDTH),
                                  y: clamp(snapToGrid(boardY, GRID_OFFSET), 0, BOARD_HEIGHT - c.height),
                                }
                              : c,
                          ),
                        }

                        return applyDup(layoutBoard(next))
                      })
                      setIsCardInteracting(false)
                      return
                    }

                    setBoard((prev) => {
                      if (!prev) return prev
                      const moved = layoutBoard({
                        ...prev,
                        cards: prev.cards.map((c) =>
                          c.id === card.id
                            ? {
                                ...c,
                                x: clamp(snapToGrid(d.x, GRID_OFFSET), 0, BOARD_WIDTH - CARD_WIDTH),
                                y: clamp(snapToGrid(d.y, GRID_OFFSET), 0, BOARD_HEIGHT - c.height),
                                width: CARD_WIDTH,
                              }
                            : c,
                        ),
                      })
                      return dup || dupSel ? applyDup(moved) : moved
                    })
                    setIsCardInteracting(false)
                  }}
                  enableUserSelectHack={false}
                  dragHandleClassName="cardHeader"
                >
                  <div
                    className={`card${selectedIds.includes(card.id) ? ' card--selected' : ''}${
                      listDetachPreview &&
                      listDetachPreview.cardIds.includes(card.id) &&
                      listDetachPreview.anchorId !== card.id
                        ? ' card--detachSource'
                        : ''
                    }`}
                  >
                    <div className="cardHeader" onMouseDown={(e) => maybeSelectCardOnMouseDown(e, card.id)}>
                      <button
                        className="cardDelete"
                        aria-label="Delete card"
                        title="Delete"
                        onMouseDown={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                        }}
                        onTouchStart={(e) => {
                          e.stopPropagation()
                        }}
                        onClick={() => deleteCard(card.id)}
                      />
                    </div>
                    {card.type === 'text' ? (
                      editingTextId === card.id ? (
                        <textarea
                          className="cardBody"
                          placeholder="Write something…"
                          value={card.text}
                          data-card-id={card.id}
                          onMouseDown={(e) => {
                            e.stopPropagation()
                          }}
                          onKeyDown={(e) => {
                            if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
                              e.preventDefault()
                              const el = e.currentTarget
                              const start = el.selectionStart ?? 0
                              const end = el.selectionEnd ?? start
                              const next = applyBoldFormatting(el.value, start, end)
                              const prevValue = el.value
                              el.value = next.value
                              const nextHeight = cardHeightFromTextarea(el)
                              el.value = prevValue
                              updateCard(card.id, { text: next.value, height: nextHeight })
                              window.requestAnimationFrame(() => {
                                const target = textareaByIdRef.current.get(card.id)
                                if (!target) return
                                target.focus()
                                target.setSelectionRange(next.selectionStart, next.selectionEnd)
                              })
                            }
                          }}
                          ref={(el) => {
                            if (el) textareaByIdRef.current.set(card.id, el)
                            else textareaByIdRef.current.delete(card.id)
                          }}
                          onBlur={() => setEditingTextId(null)}
                          onChange={(e) => {
                            const text = e.target.value
                            updateCard(card.id, { text })
                            window.requestAnimationFrame(() => {
                              const target = textareaByIdRef.current.get(card.id)
                              if (!target) return
                              const nextHeight = cardHeightFromTextarea(target)
                              updateCard(card.id, { height: nextHeight })
                            })
                          }}
                        />
                      ) : (
                        <div
                          className="cardBody cardBody--display"
                          onMouseDown={(e) => {
                            e.stopPropagation()
                            startEditingTextCard(card.id)
                          }}
                        >
                          {card.text ? renderBoldText(card.text) : 'Write something…'}
                        </div>
                      )
                    ) : card.type === 'image' ? (
                      (() => {
                        const url = imageUrl(card)
                        const hasNote = Boolean(card.note?.trim())
                        const noteOpen = hasNote || card.noteExpanded
                        const baseHeight = imageCardBaseHeight(card)
                        const previewHeight = Math.max(0, baseHeight - CARD_HEADER_HEIGHT)
                        return (
                          <div className="cardImageCard">
                            <div
                              className="cardImagePreview"
                              style={{ height: `${previewHeight}px` }}
                              ref={(el) => {
                                if (el) imageCardPreviewByIdRef.current.set(card.id, el)
                                else imageCardPreviewByIdRef.current.delete(card.id)
                              }}
                            >
                              {url ? (
                                <img className="cardImage" src={url} alt="" draggable={false} />
                              ) : (
                                <div className="cardImagePlaceholder">Image cards require the desktop app.</div>
                              )}
                            </div>
                            <div
                              className="cardImageBody"
                              ref={(el) => {
                                if (el) imageCardBodyByIdRef.current.set(card.id, el)
                                else imageCardBodyByIdRef.current.delete(card.id)
                              }}
                            >
                              {!noteOpen ? (
                                <div className="cardImageNoteCta">
                                  <button
                                    className="cardLinkNoteButton"
                                    onMouseDown={(e) => {
                                      e.stopPropagation()
                                    }}
                                    onClick={() => {
                                      updateImageCard(card.id, { noteExpanded: true })
                                      window.requestAnimationFrame(() => {
                                        const target = imageNoteTextareaByIdRef.current.get(card.id)
                                        target?.focus()
                                      })
                                    }}
                                  >
                                    + Add note
                                  </button>
                                </div>
                              ) : (
                                <div className="cardImageNote cardImageNote--open">
                                  <textarea
                                    className="cardBody cardImageNoteInput"
                                    placeholder="Add a note…"
                                    value={card.note ?? ''}
                                    onMouseDown={(e) => {
                                      e.stopPropagation()
                                    }}
                                    onChange={(e) => {
                                      const el = e.currentTarget
                                      el.style.height = 'auto'
                                      el.style.height = `${linkNoteHeightFromTextarea(el)}px`
                                      updateImageCard(card.id, {
                                        note: e.target.value,
                                        noteExpanded: true,
                                      })
                                    }}
                                    onBlur={(e) => {
                                      if (e.currentTarget.value.trim()) return
                                      updateImageCard(card.id, {
                                        note: '',
                                        noteExpanded: false,
                                        height: baseHeight,
                                      })
                                    }}
                                    ref={(el) => {
                                      if (el) imageNoteTextareaByIdRef.current.set(card.id, el)
                                      else imageNoteTextareaByIdRef.current.delete(card.id)
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })()
                    ) : (
                      (() => {
                        const hasNote = Boolean(card.note?.trim())
                        const noteOpen = hasNote || card.noteExpanded
                        return (
                          <div className="cardLink">
                            <div className="cardLinkContent">
                              <div
                                className="cardLinkPreview"
                                ref={(el) => {
                                  if (el) linkCardPreviewByIdRef.current.set(card.id, el)
                                  else linkCardPreviewByIdRef.current.delete(card.id)
                                }}
                              >
                                {(() => {
                                  const url = linkImageUrl(card)
                                  return url ? (
                                    <div
                                      className="cardLinkImageWrap"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        openLink(card.url)
                                      }}
                                    >
                                      <img className="cardLinkImage" src={url} alt="" draggable={false} />
                                    </div>
                                  ) : null
                                })()}
                              </div>
                              <div
                                className="cardLinkBody"
                                ref={(el) => {
                                  if (el) linkCardBodyByIdRef.current.set(card.id, el)
                                  else linkCardBodyByIdRef.current.delete(card.id)
                                }}
                              >
                                <div className="cardLinkTitleWrap">
                                  <div
                                    className="cardLinkTitle"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      openLink(card.url)
                                    }}
                                  >
                                    {card.title || card.url}
                                  </div>
                                </div>
                                {!noteOpen ? (
                                  <div className="cardLinkNoteCta">
                                    <button
                                      className="cardLinkNoteButton"
                                      onMouseDown={(e) => {
                                        e.stopPropagation()
                                      }}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        updateLinkCard(card.id, { noteExpanded: true })
                                        window.requestAnimationFrame(() => {
                                          const target = linkNoteTextareaByIdRef.current.get(card.id)
                                          target?.focus()
                                        })
                                      }}
                                    >
                                      + Add note
                                    </button>
                                  </div>
                                ) : (
                                  <div className="cardLinkNote cardLinkNote--open">
                                    <textarea
                                      className="cardBody cardLinkNoteInput"
                                      placeholder="Add a note…"
                                      value={card.note ?? ''}
                                      onMouseDown={(e) => {
                                        e.stopPropagation()
                                      }}
                                      onChange={(e) => {
                                        const el = e.currentTarget
                                        el.style.height = 'auto'
                                        el.style.height = `${linkNoteHeightFromTextarea(el)}px`
                                        updateLinkCard(card.id, {
                                          note: e.target.value,
                                          noteExpanded: true,
                                        })
                                      }}
                                      onBlur={(e) => {
                                        if (e.currentTarget.value.trim()) return
                                        updateLinkCard(card.id, {
                                          note: '',
                                          noteExpanded: false,
                                          height: linkCardBaseHeight(card),
                                        })
                                      }}
                                      ref={(el) => {
                                        if (el) linkNoteTextareaByIdRef.current.set(card.id, el)
                                        else linkNoteTextareaByIdRef.current.delete(card.id)
                                      }}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })()
                    )}
                  </div>
                </Rnd>
              ))}
            </div>
          </TransformComponent>
        </TransformWrapper>
      </div>

      <div className="statusbar">
        <div className="statusLeft">
          <button
            className="zoomPill zoomPill--icon statusSettings"
            onClick={() => setIsSettingsOpen(true)}
            aria-label="Open settings"
            type="button"
          >
            <Settings size={16} />
          </button>
          <div className="statusText">
            Autosaves to <code>~/Documents/LANA/boards/{board.id ?? 'unknown'}/board.json</code>
          </div>
        </div>
        {uiNotice ? (
          <div className="statusNotice">
            <span>{uiNotice.message}</span>
            {uiNotice.actionLabel ? (
              <button
                className="statusNoticeAction"
                onClick={() => {
                  uiNotice.onAction?.()
                  setUiNotice(null)
                }}
                type="button"
              >
                {uiNotice.actionLabel}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="statusRight">
          <button
            className="zoomPill zoomPill--icon"
            title="Fit all items"
            onClick={() => {
              const controller = transformRef.current
              const wrapper = panZoomEl
              if (!controller || !wrapper || !board) return

              const bounds = computeContentBounds(board)
              if (!bounds) return

              const pad = 80
              const w = Math.max(1, bounds.right - bounds.left)
              const h = Math.max(1, bounds.bottom - bounds.top)
              const availW = Math.max(1, wrapper.clientWidth - pad * 2)
              const availH = Math.max(1, wrapper.clientHeight - pad * 2)
              const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(availW / w, availH / h)))
              const centerX = (bounds.left + bounds.right) / 2
              const centerY = (bounds.top + bounds.bottom) / 2
              const nextPositionX = wrapper.clientWidth / 2 - centerX * nextScale
              const nextPositionY = wrapper.clientHeight / 2 - centerY * nextScale

              commitTransform(nextPositionX, nextPositionY, nextScale, 180)
            }}
          >
            <FitToScreen size={18} />
          </button>
          <button
            className="zoomPill zoomPill--value"
            title="Reset zoom to 100%"
            onClick={() => {
              const controller = transformRef.current
              const wrapper = panZoomEl
              if (!controller || !wrapper) return

              const { scale, positionX, positionY } = transformStateRef.current
              const centerPx = wrapper.clientWidth / 2
              const centerPy = wrapper.clientHeight / 2

              const centerContentX = (centerPx - positionX) / scale
              const centerContentY = (centerPy - positionY) / scale

              const nextScale = 1
              const nextPositionX = centerPx - centerContentX * nextScale
              const nextPositionY = centerPy - centerContentY * nextScale

              commitTransform(nextPositionX, nextPositionY, nextScale, 150)
            }}
          >
            {Math.round(zoomScale * 100)}%
          </button>

          <button
            className={`themeToggle${theme === 'light' ? ' themeToggle--on' : ''}`}
            aria-label="Toggle light mode"
            aria-pressed={theme === 'light'}
            title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          />
        </div>
      </div>
      {pendingBoardDelete ? (
        <div className="modalOverlay" role="presentation" onClick={cancelBoardDelete}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-board-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modalTitle" id="delete-board-title">
              Delete board?
            </div>
            <div className="modalBody">
              This will move &quot;{pendingBoardDelete.name}&quot; to Trash. Deleted boards can be restored from the
              trash until the trash is emptied.
            </div>
            <div className="modalActions">
              <button className="btn" onClick={cancelBoardDelete} type="button">
                Cancel
              </button>
              <button className="btn btn--danger" onClick={() => void confirmBoardDelete()} type="button">
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingTrashEmpty ? (
        <div className="modalOverlay" role="presentation" onClick={cancelEmptyTrash}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="empty-trash-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modalTitle" id="empty-trash-title">
              Empty trash?
            </div>
            <div className="modalBody">
              Boards in the trash will be deleted permanently. This cannot be undone. Are you sure?
            </div>
            <div className="modalActions">
              <button className="btn" onClick={cancelEmptyTrash} type="button">
                Cancel
              </button>
              <button className="btn btn--danger" onClick={() => void confirmEmptyTrash()} type="button">
                Empty
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isSettingsOpen ? (
        <div className="settingsOverlay" role="presentation" onClick={() => setIsSettingsOpen(false)}>
          <div
            className="settingsModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settingsSidebar">
              <div className="settingsTitle" id="settings-title">
                Settings
              </div>
              <button
                className={`settingsTab${settingsTab === 'backup' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('backup')}
                type="button"
              >
                Backup
              </button>
              <button
                className={`settingsTab${settingsTab === 'chat' ? ' is-active' : ''}`}
                onClick={() => setSettingsTab('chat')}
                type="button"
              >
                Chat
              </button>
            </div>
            <div className="settingsContent">
              <div className="settingsHeaderRow">
                <div className="settingsHeader">{settingsTab === 'backup' ? 'Backup' : 'Chat'}</div>
                <button
                  className="btn btn--icon settingsClose"
                  onClick={() => setIsSettingsOpen(false)}
                  aria-label="Close settings"
                  type="button"
                >
                  <Close size={16} />
                </button>
              </div>
              {settingsTab === 'backup' ? (
                <>
                  <label className="settingsField settingsField--inline">
                    <input
                      className="settingsCheckbox"
                      type="checkbox"
                      checked={backupEnabled}
                      onChange={(e) => setBackupEnabled(e.target.checked)}
                    />
                    <span>Enable backups</span>
                  </label>
                  <div className={`settingsField${backupEnabled ? '' : ' is-disabled'}`}>
                    <div className="settingsFieldLabel">Backup folder</div>
                    <div className="settingsFolderRow">
                      <input
                        className="settingsInput"
                        type="text"
                        value={backupFolder}
                        onChange={(e) => setBackupFolder(e.target.value)}
                        placeholder="Choose a folder…"
                        disabled={!backupEnabled}
                      />
                      <button
                        className="btn settingsFolderButton"
                        onClick={() => void chooseBackupFolder()}
                        type="button"
                        disabled={!backupEnabled}
                      >
                        Choose
                      </button>
                    </div>
                  </div>
                  <div className="settingsHelp">
                    Backups are saved every 10 minutes and when the app closes. Only the most recent 3 backups are kept.
                  </div>
                  <div className="settingsActions">
                    <div className={`backupSuccess${backupSuccessAt ? ' is-visible' : ''}`} aria-hidden="true">
                      <Checkmark size={16} />
                    </div>
                    <button
                      className="btn"
                      onClick={() => void runBackup('manual')}
                      type="button"
                      disabled={!backupEnabled || !backupFolder}
                    >
                      Backup now
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="settingsHelp settingsHelp--block">
                    <p>
                      LANA chat is powered by Ollama, an open source LLM server. This keeps conversations local to your
                      computer and sidesteps the need for paid API keys.
                    </p>
                    <p>
                      Visit <button className="settingsInlineLink" onClick={() => openLink('https://ollama.com')} type="button">ollama.com</button> to download the app and install your preferred model. Type the model name into the field below exactly as it appears in Ollama.
                    </p>
                    <p>LANA will look for that model name served by Ollama at http://localhost:11434</p>
                  </div>
                  <div className="settingsField">
                    <div className="settingsFieldLabel">Model</div>
                    <input
                      className="settingsInput"
                      value={chatModel}
                      onChange={(e) => setChatModel(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                  <div className="settingsHelp">
                    This should match an installed Ollama model name on your machine.
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {isBackupClosing ? (
        <div className="modalOverlay" role="presentation">
          <div className="modal" role="alertdialog" aria-modal="true" aria-live="assertive">
            <div className="modalTitle">Backing up…</div>
            <div className="modalBody">Please wait while LANA saves your backup.</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
