# LANA — Features & Controls

A whiteboard built with **Tauri + React + TypeScript + Vite**.

## Storage & persistence

- **Boards on disk**: `~/Documents/LANA/boards/<boardId>/board.json`
- **Assets** (images/link previews): `~/Documents/LANA/boards/<boardId>/assets/`
- **Chat history** (per board): `~/Documents/LANA/boards/<boardId>/chat.json`
- **Autosave**: debounced (~400ms) after board changes; paused while dragging.
- **Board index**: `~/Documents/LANA/boards/boards.json`

## Data model (overview)

- **Cards**: text, image, link
- **Columns**: Lists with ordered card IDs
- **Board**: cards + columns

## Canvas

- Large board surface: **20,000 × 20,000**
- Initial viewport centered around **25% / 25%** of board size
- Visible dot grid; cards snap to the grid on drop

## Cards

- **Create**: toolbar button or press **N**
- **Double-click empty space**: create a new text card
- **Move**: drag the card header
- **Delete**: red square button on the card header
- **Text cards**:
  - Fixed width; auto-grow/shrink height based on content
  - Bold formatting via `**bold**` (no rich text toolbar)
  - Shortcut while editing: **Cmd/Ctrl + B** wraps selection in `**` markers
- **Image cards**:
  - Created by pasting images (desktop app)
  - Fixed width; height based on aspect ratio
- **Link cards**:
  - Paste a URL to create a link card
  - Optional preview image (fetched metadata)

## Selection

- **Marquee selection**: click + drag on empty space to select items within rectangle
- **Click selection**: click a card or list header
- **Multi-select**: Shift + click
- **Group drag**: drag any selected item to move the whole selection
- **Escape**: clear selection; if editing a text card, exits edit mode and deselects

## Lists / Columns

- **Create list**: select 1+ cards → click **Create list** in toolbar
- **Reorder within a list**: drag list cards; insertion line shows target position
- **Move into list**: drag free cards over a list and drop
- **Move between lists**: drag list cards across lists
- **Detach**: when a list is selected, toolbar button switches to **Detach cards**
- **Rename**: double-click list header to edit
- **Delete list**: select list header and press Delete/Backspace (deletes list + cards)

## Undo/Redo

- **Undo**: Cmd+Z / Ctrl+Z
- **Redo**: Cmd+Shift+Z / Ctrl+Y

## Pan & zoom

- **Two-finger scroll**: pan
- **Pinch (ctrl + wheel)**: zoom
- **Space + drag**: pan
- **Middle mouse drag**: pan
- **Zoom % pill**: click to reset to 100%

## Chat (local Ollama)

- Per-board chat drawer on the right (does not block board)
- History persists per board and survives restarts
- **Context policy**: rolling summary + last N messages (N=8)
- Session marker appears when a new app session starts
- Model default: `llama3.2:3b` (editable in chat header)

## Known limitations

- No in-app user accounts or cloud sync
- No rich text beyond bold markers
- No manual card resize (fixed width)
