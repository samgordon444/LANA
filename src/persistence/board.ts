import { invoke } from '@tauri-apps/api/core'
import type { Board, BoardMeta, ChatMessage, ChatStore, LinkMetadata } from '../types'

export async function listBoards(): Promise<BoardMeta[]> {
  return await invoke<BoardMeta[]>('list_boards')
}

export async function createBoard(name: string): Promise<BoardMeta> {
  return await invoke<BoardMeta>('create_board', { name })
}

export async function deleteBoard(boardId: string): Promise<void> {
  await invoke('delete_board', { boardId })
}

export async function loadBoard(boardId: string): Promise<Board> {
  return await invoke<Board>('load_board', { boardId })
}

export async function saveBoard(boardId: string, board: Board): Promise<void> {
  await invoke('save_board', { boardId, board })
}

export async function loadChat(boardId: string): Promise<ChatStore> {
  return await invoke<ChatStore>('load_chat', { boardId })
}

export async function saveChat(boardId: string, chat: ChatStore): Promise<void> {
  await invoke('save_chat', { boardId, chat })
}

export async function getAssetsDir(boardId: string): Promise<string> {
  return await invoke<string>('get_assets_dir', { boardId })
}

export async function saveImage(boardId: string, filename: string, bytesBase64: string): Promise<string> {
  // Tauri invokes use camelCase args and map to Rust snake_case params.
  return await invoke<string>('save_image', { boardId, filename, bytesBase64 })
}

export async function fetchLinkMetadata(boardId: string, url: string): Promise<LinkMetadata> {
  return await invoke<LinkMetadata>('fetch_link_metadata', { boardId, url })
}

export async function ollamaChat(model: string, messages: ChatMessage[]): Promise<ChatMessage> {
  return await invoke<ChatMessage>('ollama_chat', { model, messages })
}

export async function openExternalUrl(url: string): Promise<void> {
  await invoke('open_external_url', { url })
}
