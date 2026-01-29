# AGENTS.md
This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Common commands
- Dev server (Vite): `npm run dev`
- Build (TypeScript + Vite): `npm run build`
- Preview production build: `npm run preview`
- Lint: `npm run lint`
- Tauri app (desktop) dev: `npm run tauri:dev`
- Tauri app (desktop) build: `npm run tauri:build`

Tests: no test scripts are defined in `package.json` at the moment.

## High-level architecture
- **Frontend (React + Vite)** lives in `src/`.
  - Entry: `src/main.tsx` mounts `<App />`.
  - `src/App.tsx` is the core UI and state manager (board canvas, cards, lists/columns, selection, drag/resize, zoom/pan, history/undo, autosave).
  - `src/types.ts` defines the core domain model: `Board`, `Column`, and `Card` (text/image/link variants).
  - `src/persistence/board.ts` is the frontend persistence layer that calls Tauri commands via `@tauri-apps/api` (`invoke`) for load/save, assets, and link metadata.
- **Backend (Tauri + Rust)** lives in `src-tauri/`.
  - `src-tauri/src/lib.rs` registers the command handlers (`list_boards`, `create_board`, `delete_board`, `load_board`, `save_board`, `save_image`, `get_assets_dir`, `fetch_link_metadata`, `open_external_url`).
  - Boards are stored on disk as JSON under the user’s Documents folder: `Documents/LANA/boards/<boardId>/board.json`; images are stored under `.../assets/`.
  - `fetch_link_metadata` fetches OpenGraph/Twitter metadata and optionally downloads a preview image into the board’s assets directory.

## Notes on data flow
- The React app treats the Rust layer as the source of truth for persistence; UI state is normalized and autosaved via `save_board`.
- Board lists (metadata) are maintained by the Rust index file (`boards.json`) and kept in sync with on-disk boards.
