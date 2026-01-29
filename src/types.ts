export type TextCard = {
  id: string
  type: 'text'
  x: number
  y: number
  width: number
  height: number
  text: string
}

export type ImageCard = {
  id: string
  type: 'image'
  x: number
  y: number
  width: number
  height: number
  // Stored as a relative path under the board folder, e.g. "assets/<id>.png"
  src: string
  naturalWidth: number
  naturalHeight: number
  note?: string
  noteExpanded?: boolean
}

export type LinkCard = {
  id: string
  type: 'link'
  x: number
  y: number
  width: number
  height: number
  url: string
  title: string
  // Stored as a relative path under the board folder, e.g. "assets/<id>.png"
  image?: string
  siteName?: string
  note?: string
  noteExpanded?: boolean
}

export type Card = TextCard | ImageCard | LinkCard

export type Column = {
  id: string
  name: string
  x: number
  y: number
  width: number
  gap: number
  cardIds: string[]
}

export type Board = {
  id: string
  name: string
  cards: Card[]
  columns: Column[]
}

export type BoardMeta = {
  id: string
  name: string
  updatedAt: number
}

export type LinkMetadata = {
  url: string
  title: string
  image?: string
  siteName?: string
}

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type ChatEntry = {
  id: string
  role: 'user' | 'assistant' | 'system-note'
  content: string
  createdAt: number
  sessionId?: string
}

export type ChatStore = {
  version: number
  messages: ChatEntry[]
  summary?: string
  summaryUpTo: number
  lastSessionId?: string
}
