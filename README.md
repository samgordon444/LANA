# LANA

A whiteboard built with **Tauri + React + TypeScript + Vite**.

## Highlights

- Multi-board workspace with autosave to disk
- Text, image, and link cards
- Lists/columns with drag-in, reorder, and detach
- Per-board local chat via Ollama (rolling summary + recent messages context)
- Fast pan/zoom board with grid snapping
- Light/dark mode
- Local backups manager

## Storage

Boards and assets live under:

```
~/Documents/LANA/boards/
```

Each board stores:
- `board.json` (board content)
- `assets/` (images and link previews)
- `chat.json` (chat history + summary)

## Development

To run locally:
- npm Install (often solves run issues): `npm install`
- Tauri dev: `npm run tauri:dev`

To build app:
- Tauri build: `npm run tauri:build`

## Local chat (Ollama)

Chat uses a local Ollama server. Default model is `llama3.2:3b` (editable in the chat header).

Quick setup:

```
ollama serve
ollama pull llama3.2:3b
```

The app will connect to `http://127.0.0.1:11434`.

## License
GPL-3.0

Fork it, modify it, ship it — just keep derivatives open and include source.

## Copyright
Copyright 2026 Sam Gordon
