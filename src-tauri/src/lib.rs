use base64::Engine;
use reqwest::header::CONTENT_TYPE;
use scraper::{Html, Selector};
use std::net::IpAddr;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use url::Url;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      list_boards,
      list_trashed_boards,
      create_board,
      delete_board,
      empty_trash,
      restore_board,
      fetch_link_metadata,
      ollama_chat,
      load_chat,
      save_chat,
      open_external_url,
      load_board,
      save_board,
      save_image,
      get_assets_dir
    ])
    .setup(|app| {
      let paths = AppPaths::new(app.handle())?;
      ensure_root_dir(&paths)?;
      ensure_board_index(&paths)?;
      app.manage(paths);

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[derive(Clone)]
struct AppPaths {
  root_dir: std::path::PathBuf,
  index_file: std::path::PathBuf,
}

impl AppPaths {
  fn new(app: &tauri::AppHandle) -> Result<Self, String> {
    let documents_dir = app
      .path()
      .document_dir()
      .map_err(|e| format!("failed to resolve Documents dir: {e}"))?;

    let root_dir = documents_dir.join("LANA").join("boards");
    let index_file = root_dir.join("boards.json");

    Ok(Self {
      root_dir,
      index_file,
    })
  }
}

#[derive(Clone)]
struct BoardPaths {
  dir: std::path::PathBuf,
  file: std::path::PathBuf,
  tmp: std::path::PathBuf,
  assets_dir: std::path::PathBuf,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Card {
  id: String,
  #[serde(rename = "type")]
  r#type: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  #[serde(default)]
  text: String,
  #[serde(default)]
  src: Option<String>,
  #[serde(default, rename = "naturalWidth")]
  natural_width: Option<f64>,
  #[serde(default, rename = "naturalHeight")]
  natural_height: Option<f64>,
  #[serde(default)]
  url: Option<String>,
  #[serde(default)]
  title: Option<String>,
  #[serde(default)]
  description: Option<String>,
  #[serde(default)]
  image: Option<String>,
  #[serde(default, rename = "siteName")]
  site_name: Option<String>,
  #[serde(default)]
  note: Option<String>,
  #[serde(default, rename = "noteExpanded")]
  note_expanded: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Column {
  id: String,
  #[serde(default = "default_column_name")]
  name: String,
  x: f64,
  y: f64,
  width: f64,
  gap: f64,
  #[serde(rename = "cardIds")]
  card_ids: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Board {
  id: String,
  name: String,
  cards: Vec<Card>,
  #[serde(default)]
  columns: Vec<Column>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct BoardMeta {
  id: String,
  name: String,
  #[serde(rename = "updatedAt")]
  updated_at: i64,
  #[serde(default, skip_serializing_if = "Option::is_none", rename = "deletedAt")]
  deleted_at: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct BoardIndex {
  version: u32,
  boards: Vec<BoardMeta>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct LinkMetadata {
  url: String,
  title: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  image: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none", rename = "siteName")]
  site_name: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct OllamaMessage {
  role: String,
  content: String,
}

#[derive(Debug, Clone, serde::Serialize)]
struct OllamaChatRequest {
  model: String,
  messages: Vec<OllamaMessage>,
  stream: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct OllamaChatResponse {
  message: OllamaMessage,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ChatEntry {
  id: String,
  role: String,
  content: String,
  #[serde(rename = "createdAt")]
  created_at: i64,
  #[serde(skip_serializing_if = "Option::is_none", rename = "sessionId")]
  session_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ChatStore {
  version: u32,
  messages: Vec<ChatEntry>,
  #[serde(default)]
  summary: Option<String>,
  #[serde(default, rename = "summaryUpTo")]
  summary_up_to: usize,
  #[serde(default, rename = "lastSessionId")]
  last_session_id: Option<String>,
}

fn empty_board(id: &str, name: &str) -> Board {
  Board {
    id: id.to_string(),
    name: name.to_string(),
    cards: vec![],
    columns: vec![],
  }
}

fn default_column_name() -> String {
  "List".to_string()
}

fn now_millis() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

fn ensure_root_dir(paths: &AppPaths) -> Result<(), String> {
  std::fs::create_dir_all(&paths.root_dir).map_err(|e| format!("create boards dir failed: {e}"))?;
  Ok(())
}

fn board_paths(root_dir: &std::path::Path, board_id: &str) -> BoardPaths {
  let dir = root_dir.join(board_id);
  let file = dir.join("board.json");
  let tmp = dir.join("board.json.tmp");
  let assets_dir = dir.join("assets");
  BoardPaths {
    dir,
    file,
    tmp,
    assets_dir,
  }
}

fn is_valid_board_id(board_id: &str) -> bool {
  if board_id.is_empty() || board_id.len() > 64 {
    return false;
  }
  if board_id.contains('/') || board_id.contains('\\') || board_id.contains("..") {
    return false;
  }
  board_id
    .chars()
    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn ensure_board_file(paths: &BoardPaths, board_id: &str, board_name: &str) -> Result<(), String> {
  std::fs::create_dir_all(&paths.dir).map_err(|e| format!("create dir failed: {e}"))?;
  std::fs::create_dir_all(&paths.assets_dir).map_err(|e| format!("create assets dir failed: {e}"))?;

  if !paths.file.exists() {
    write_board_atomic(paths, &empty_board(board_id, board_name))?;
  }

  Ok(())
}

fn write_board_atomic(paths: &BoardPaths, board: &Board) -> Result<(), String> {
  let json = serde_json::to_string_pretty(board).map_err(|e| format!("serialize failed: {e}"))?;

  std::fs::write(&paths.tmp, json).map_err(|e| format!("write temp failed: {e}"))?;

  if paths.file.exists() {
    let _ = std::fs::remove_file(&paths.file);
  }

  std::fs::rename(&paths.tmp, &paths.file).map_err(|e| format!("rename failed: {e}"))?;
  Ok(())
}

fn write_index_atomic(paths: &AppPaths, index: &BoardIndex) -> Result<(), String> {
  let json = serde_json::to_string_pretty(index).map_err(|e| format!("serialize failed: {e}"))?;
  let tmp = paths.index_file.with_extension("json.tmp");
  std::fs::write(&tmp, json).map_err(|e| format!("write index temp failed: {e}"))?;
  if paths.index_file.exists() {
    let _ = std::fs::remove_file(&paths.index_file);
  }
  std::fs::rename(&tmp, &paths.index_file).map_err(|e| format!("rename index failed: {e}"))?;
  Ok(())
}

fn read_index(paths: &AppPaths) -> Result<BoardIndex, String> {
  ensure_root_dir(paths)?;
  if !paths.index_file.exists() {
    return rebuild_index_from_fs(paths);
  }
  let text = std::fs::read_to_string(&paths.index_file)
    .map_err(|e| format!("read index failed: {e}"))?;
  match serde_json::from_str::<BoardIndex>(&text) {
    Ok(index) => {
      if index.boards.is_empty() {
        rebuild_index_from_fs(paths)
      } else {
        sync_index_with_fs(paths, index)
      }
    }
    Err(_) => rebuild_index_from_fs(paths),
  }
}

fn ensure_board_index(paths: &AppPaths) -> Result<BoardIndex, String> {
  ensure_root_dir(paths)?;
  rebuild_index_from_fs(paths)
}

fn ensure_board_index_contains(
  paths: &AppPaths,
  mut index: BoardIndex,
  board_id: &str,
  board_name: &str,
) -> Result<BoardIndex, String> {
  if let Some(meta) = index.boards.iter_mut().find(|b| b.id == board_id) {
    meta.name = board_name.to_string();
    meta.updated_at = now_millis();
    meta.deleted_at = None;
  } else {
    index.boards.push(BoardMeta {
      id: board_id.to_string(),
      name: board_name.to_string(),
      updated_at: now_millis(),
      deleted_at: None,
    });
  }
  write_index_atomic(paths, &index)?;
  Ok(index)
}

fn generate_board_id(paths: &AppPaths, index: &BoardIndex) -> String {
  let base = format!("board-{}", now_millis());
  if !index.boards.iter().any(|b| b.id == base) && !paths.root_dir.join(&base).exists() {
    return base;
  }
  let mut i = 1;
  loop {
    let candidate = format!("{base}-{i}");
    if !index.boards.iter().any(|b| b.id == candidate)
      && !paths.root_dir.join(&candidate).exists()
    {
      return candidate;
    }
    i += 1;
  }
}

fn is_safe_url(url: &Url) -> bool {
  let host = match url.host_str() {
    Some(host) => host,
    None => return false,
  };
  if host.eq_ignore_ascii_case("localhost") || host.ends_with(".local") {
    return false;
  }
  if let Ok(ip) = host.parse::<IpAddr>() {
    return match ip {
      IpAddr::V4(v4) => {
        !(v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified())
      }
      IpAddr::V6(v6) => {
        !(v6.is_loopback()
          || v6.is_unicast_link_local()
          || v6.is_unique_local()
          || v6.is_unspecified())
      }
    };
  }
  true
}

fn clean_text(value: &str) -> Option<String> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    None
  } else {
    Some(trimmed.to_string())
  }
}

fn meta_content(doc: &Html, selector: &str) -> Option<String> {
  let sel = Selector::parse(selector).ok()?;
  let el = doc.select(&sel).next()?;
  let content = el.value().attr("content")?;
  clean_text(content)
}

fn title_text(doc: &Html) -> Option<String> {
  let sel = Selector::parse("title").ok()?;
  let el = doc.select(&sel).next()?;
  clean_text(&el.inner_html())
}

fn ext_from_content_type(content_type: &str) -> Option<&'static str> {
  let ct = content_type.to_ascii_lowercase();
  if ct.starts_with("image/jpeg") || ct.starts_with("image/jpg") {
    Some(".jpg")
  } else if ct.starts_with("image/png") {
    Some(".png")
  } else if ct.starts_with("image/webp") {
    Some(".webp")
  } else if ct.starts_with("image/gif") {
    Some(".gif")
  } else {
    None
  }
}

fn save_asset_bytes(
  paths: &AppPaths,
  board_id: &str,
  bytes: &[u8],
  ext: &str,
) -> Result<String, String> {
  let index = read_index(paths)?;
  let name = index
    .boards
    .iter()
    .find(|b| b.id == board_id)
    .map(|b| b.name.as_str())
    .unwrap_or("Untitled");
  let board_paths = board_paths(&paths.root_dir, board_id);
  ensure_board_file(&board_paths, board_id, name)?;

  let safe_ext = if ext.starts_with('.') { ext.to_string() } else { format!(".{ext}") };
  let filename = format!("link-{}{}", now_millis(), safe_ext);
  let safe_name = filename
    .replace('\\', "_")
    .replace('/', "_")
    .replace("..", "_");

  let out = board_paths.assets_dir.join(&safe_name);
  let tmp = board_paths.assets_dir.join(format!("{safe_name}.tmp"));
  std::fs::write(&tmp, bytes).map_err(|e| format!("write temp image failed: {e}"))?;
  if out.exists() {
    let _ = std::fs::remove_file(&out);
  }
  std::fs::rename(&tmp, &out).map_err(|e| format!("rename image failed: {e}"))?;
  Ok(format!("assets/{safe_name}"))
}

fn read_board_name(file: &std::path::Path) -> Option<String> {
  std::fs::read_to_string(file)
    .ok()
    .and_then(|text| serde_json::from_str::<Board>(&text).ok())
    .map(|b| b.name)
}

fn file_modified_millis(file: &std::path::Path) -> Option<i64> {
  std::fs::metadata(file)
    .and_then(|m| m.modified())
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as i64)
}

fn rebuild_index_from_fs(paths: &AppPaths) -> Result<BoardIndex, String> {
  ensure_root_dir(paths)?;
  let mut boards = Vec::new();
  let entries = std::fs::read_dir(&paths.root_dir)
    .map_err(|e| format!("read boards dir failed: {e}"))?;
  for entry in entries.flatten() {
    let path = entry.path();
    if !path.is_dir() {
      continue;
    }
    let board_id = match path.file_name().and_then(|n| n.to_str()) {
      Some(name) => name.to_string(),
      None => continue,
    };
    if !is_valid_board_id(&board_id) {
      continue;
    }
    let board_file = path.join("board.json");
    if !board_file.exists() {
      continue;
    }
    let name = read_board_name(&board_file).unwrap_or_else(|| board_id.clone());
    let updated_at = file_modified_millis(&board_file).unwrap_or_else(now_millis);
    boards.push(BoardMeta {
      id: board_id,
      name,
      updated_at,
      deleted_at: None,
    });
  }
  let trash_dir = paths.root_dir.join("trash");
  if trash_dir.exists() {
    let trash_entries = std::fs::read_dir(&trash_dir)
      .map_err(|e| format!("read trash dir failed: {e}"))?;
    for entry in trash_entries.flatten() {
      let path = entry.path();
      if !path.is_dir() {
        continue;
      }
      let board_id = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name.to_string(),
        None => continue,
      };
      if !is_valid_board_id(&board_id) {
        continue;
      }
      let board_file = path.join("board.json");
      if !board_file.exists() {
        continue;
      }
      let name = read_board_name(&board_file).unwrap_or_else(|| board_id.clone());
      let deleted_at = file_modified_millis(&board_file).unwrap_or_else(now_millis);
      boards.push(BoardMeta {
        id: board_id,
        name,
        updated_at: deleted_at,
        deleted_at: Some(deleted_at),
      });
    }
  }
  let index = BoardIndex { version: 1, boards };
  write_index_atomic(paths, &index)?;
  Ok(index)
}

fn sync_index_with_fs(paths: &AppPaths, mut index: BoardIndex) -> Result<BoardIndex, String> {
  ensure_root_dir(paths)?;
  let mut changed = false;
  let mut seen = std::collections::HashSet::new();
  let mut seen_trash = std::collections::HashSet::new();

  let entries = std::fs::read_dir(&paths.root_dir)
    .map_err(|e| format!("read boards dir failed: {e}"))?;
  for entry in entries.flatten() {
    let path = entry.path();
    if !path.is_dir() {
      continue;
    }
    let board_id = match path.file_name().and_then(|n| n.to_str()) {
      Some(name) => name.to_string(),
      None => continue,
    };
    if !is_valid_board_id(&board_id) {
      continue;
    }
    let board_file = path.join("board.json");
    if !board_file.exists() {
      continue;
    }
    seen.insert(board_id.clone());
    let name = read_board_name(&board_file).unwrap_or_else(|| board_id.clone());
    let updated_at = file_modified_millis(&board_file).unwrap_or_else(now_millis);
    match index.boards.iter_mut().find(|b| b.id == board_id) {
      Some(meta) => {
        if meta.name != name || meta.updated_at != updated_at {
          meta.name = name;
          meta.updated_at = updated_at;
          changed = true;
        }
      }
      None => {
        index.boards.push(BoardMeta {
          id: board_id,
          name,
          updated_at,
          deleted_at: None,
        });
        changed = true;
      }
    }
  }

  let trash_dir = paths.root_dir.join("trash");
  if trash_dir.exists() {
    let trash_entries = std::fs::read_dir(&trash_dir)
      .map_err(|e| format!("read trash dir failed: {e}"))?;
    for entry in trash_entries.flatten() {
      let path = entry.path();
      if !path.is_dir() {
        continue;
      }
      let board_id = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name.to_string(),
        None => continue,
      };
      if !is_valid_board_id(&board_id) {
        continue;
      }
      let board_file = path.join("board.json");
      if !board_file.exists() {
        continue;
      }
      seen_trash.insert(board_id.clone());
      let name = read_board_name(&board_file).unwrap_or_else(|| board_id.clone());
      let deleted_at = file_modified_millis(&board_file).unwrap_or_else(now_millis);
      match index.boards.iter_mut().find(|b| b.id == board_id) {
        Some(meta) => {
          if meta.name != name
            || meta.updated_at != deleted_at
            || meta.deleted_at != Some(deleted_at)
          {
            meta.name = name;
            meta.updated_at = deleted_at;
            meta.deleted_at = Some(deleted_at);
            changed = true;
          }
        }
        None => {
          index.boards.push(BoardMeta {
            id: board_id,
            name,
            updated_at: deleted_at,
            deleted_at: Some(deleted_at),
          });
          changed = true;
        }
      }
    }
  }

  let before_len = index.boards.len();
  index.boards.retain(|b| {
    if b.deleted_at.is_some() {
      seen_trash.contains(&b.id)
    } else {
      seen.contains(&b.id)
    }
  });
  if index.boards.len() != before_len {
    changed = true;
  }

  if changed {
    write_index_atomic(paths, &index)?;
  }
  Ok(index)
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  let parsed = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
  let scheme = parsed.scheme();
  if scheme != "http" && scheme != "https" {
    return Err("unsupported url scheme".to_string());
  }

  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg(parsed.as_str())
      .status()
      .map_err(|e| format!("open failed: {e}"))?;
  }

  #[cfg(target_os = "windows")]
  {
    std::process::Command::new("cmd")
      .arg("/C")
      .arg("start")
      .arg("")
      .arg(parsed.as_str())
      .status()
      .map_err(|e| format!("open failed: {e}"))?;
  }

  #[cfg(target_os = "linux")]
  {
    std::process::Command::new("xdg-open")
      .arg(parsed.as_str())
      .status()
      .map_err(|e| format!("open failed: {e}"))?;
  }

  Ok(())
}

#[tauri::command]
fn list_boards(paths: tauri::State<'_, AppPaths>) -> Result<Vec<BoardMeta>, String> {
  let index = read_index(&paths)?;
  Ok(index
    .boards
    .into_iter()
    .filter(|b| b.deleted_at.is_none())
    .collect())
}

#[tauri::command]
fn list_trashed_boards(paths: tauri::State<'_, AppPaths>) -> Result<Vec<BoardMeta>, String> {
  let mut boards: Vec<BoardMeta> = read_index(&paths)?
    .boards
    .into_iter()
    .filter(|b| b.deleted_at.is_some())
    .collect();
  boards.sort_by_key(|b| b.deleted_at.unwrap_or(0));
  boards.reverse();
  Ok(boards)
}

#[tauri::command]
fn empty_trash(paths: tauri::State<'_, AppPaths>) -> Result<(), String> {
  let mut index = read_index(&paths)?;
  index.boards.retain(|b| b.deleted_at.is_none());
  write_index_atomic(&paths, &index)?;

  let trash_dir = paths.root_dir.join("trash");
  if trash_dir.exists() {
    std::fs::remove_dir_all(&trash_dir).map_err(|e| format!("empty trash failed: {e}"))?;
  }
  Ok(())
}

#[tauri::command]
fn create_board(paths: tauri::State<'_, AppPaths>, name: String) -> Result<BoardMeta, String> {
  let index = read_index(&paths)?;
  let board_id = generate_board_id(&paths, &index);
  let safe_name = if name.trim().is_empty() {
    "Untitled"
  } else {
    name.trim()
  };
  let board_paths = board_paths(&paths.root_dir, &board_id);
  ensure_board_file(&board_paths, &board_id, safe_name)?;
  let meta = BoardMeta {
    id: board_id,
    name: safe_name.to_string(),
    updated_at: now_millis(),
    deleted_at: None,
  };
  let mut next = index;
  next.boards.push(meta.clone());
  write_index_atomic(&paths, &next)?;
  Ok(meta)
}

#[tauri::command]
fn delete_board(paths: tauri::State<'_, AppPaths>, board_id: String) -> Result<(), String> {
  if !is_valid_board_id(&board_id) {
    return Err("invalid board id".to_string());
  }
  let mut index = read_index(&paths)?;
  let mut found = false;
  for meta in index.boards.iter_mut() {
    if meta.id == board_id {
      meta.deleted_at = Some(now_millis());
      found = true;
      break;
    }
  }
  if !found {
    return Err("board not found".to_string());
  }
  write_index_atomic(&paths, &index)?;
  let board_paths = board_paths(&paths.root_dir, &board_id);
  if board_paths.dir.exists() {
    let trash_dir = paths.root_dir.join("trash");
    std::fs::create_dir_all(&trash_dir)
      .map_err(|e| format!("create trash dir failed: {e}"))?;
    let dest = trash_dir.join(&board_id);
    if dest.exists() {
      let _ = std::fs::remove_dir_all(&dest);
    }
    std::fs::rename(&board_paths.dir, &dest)
      .map_err(|e| format!("move board to trash failed: {e}"))?;
  }
  Ok(())
}

#[tauri::command]
fn restore_board(paths: tauri::State<'_, AppPaths>, board_id: String) -> Result<(), String> {
  if !is_valid_board_id(&board_id) {
    return Err("invalid board id".to_string());
  }
  let trash_dir = paths.root_dir.join("trash");
  let src = trash_dir.join(&board_id);
  if !src.exists() {
    return Err("board not found in trash".to_string());
  }
  let dest = paths.root_dir.join(&board_id);
  if dest.exists() {
    return Err("board already exists".to_string());
  }
  std::fs::rename(&src, &dest).map_err(|e| format!("restore board failed: {e}"))?;

  let board_file = dest.join("board.json");
  let name = read_board_name(&board_file).unwrap_or_else(|| board_id.clone());
  let mut index = read_index(&paths)?;
  index = ensure_board_index_contains(&paths, index, &board_id, &name)?;
  write_index_atomic(&paths, &index)?;
  Ok(())
}

#[tauri::command]
async fn fetch_link_metadata(
  paths: tauri::State<'_, AppPaths>,
  board_id: String,
  url: String,
) -> Result<LinkMetadata, String> {
  if !is_valid_board_id(&board_id) {
    return Err("invalid board id".to_string());
  }
  let parsed = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
  let scheme = parsed.scheme();
  if scheme != "http" && scheme != "https" {
    return Err("unsupported url scheme".to_string());
  }
  if !is_safe_url(&parsed) {
    return Err("blocked url host".to_string());
  }

  let client = reqwest::Client::builder()
    .user_agent("LANA/0.1")
    .build()
    .map_err(|e| format!("http client failed: {e}"))?;

  let resp = client
    .get(parsed.clone())
    .send()
    .await
    .map_err(|e| format!("fetch failed: {e}"))?;

  let final_url = resp.url().clone();
  let text = resp.text().await.map_err(|e| format!("read body failed: {e}"))?;

  let (title, site_name, image_url) = {
    let doc = Html::parse_document(&text);
    let title = meta_content(&doc, "meta[property='og:title']")
      .or_else(|| meta_content(&doc, "meta[name='twitter:title']"))
      .or_else(|| title_text(&doc))
      .or_else(|| final_url.host_str().map(|h| h.to_string()))
      .unwrap_or_else(|| "Link".to_string());

    let site_name = meta_content(&doc, "meta[property='og:site_name']")
      .or_else(|| final_url.host_str().map(|h| h.to_string()));

    let image_url = meta_content(&doc, "meta[property='og:image']")
      .or_else(|| meta_content(&doc, "meta[name='twitter:image']"));

    (title, site_name, image_url)
  };

  let mut image: Option<String> = None;
  if let Some(raw_image) = image_url {
    if let Ok(resolved) = final_url.join(&raw_image) {
      if is_safe_url(&resolved) {
        if let Ok(img_resp) = client.get(resolved.clone()).send().await {
          if img_resp.status().is_success() {
            let content_type = img_resp
              .headers()
              .get(CONTENT_TYPE)
              .and_then(|v| v.to_str().ok())
              .unwrap_or("")
              .to_string();
            if content_type.starts_with("image/") {
              if let Ok(bytes) = img_resp.bytes().await {
                if bytes.len() <= 5 * 1024 * 1024 {
                  let ext = ext_from_content_type(&content_type).unwrap_or(".img");
                  if let Ok(saved) = save_asset_bytes(&paths, &board_id, &bytes, ext) {
                    image = Some(saved);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  Ok(LinkMetadata {
    url: final_url.to_string(),
    title,
    image,
    site_name,
  })
}

#[tauri::command]
async fn ollama_chat(model: String, messages: Vec<OllamaMessage>) -> Result<OllamaMessage, String> {
  if model.trim().is_empty() {
    return Err("model is required".to_string());
  }

  let client = reqwest::Client::builder()
    .user_agent("LANA/0.1")
    .build()
    .map_err(|e| format!("http client failed: {e}"))?;

  let req_body = OllamaChatRequest {
    model,
    messages,
    stream: false,
  };

  let resp = client
    .post("http://127.0.0.1:11434/api/chat")
    .json(&req_body)
    .send()
    .await
    .map_err(|e| format!("ollama request failed: {e}"))?;

  let status = resp.status();
  let body = resp.text().await.map_err(|e| format!("ollama read failed: {e}"))?;
  if !status.is_success() {
    return Err(format!("ollama error ({status}): {body}"));
  }

  let parsed: OllamaChatResponse =
    serde_json::from_str(&body).map_err(|e| format!("ollama parse failed: {e}"))?;
  Ok(parsed.message)
}

#[tauri::command]
fn get_assets_dir(paths: tauri::State<'_, AppPaths>, board_id: String) -> Result<String, String> {
  if !is_valid_board_id(&board_id) {
    return Err("invalid board id".to_string());
  }
  let index = read_index(&paths)?;
  let name = index
    .boards
    .iter()
    .find(|b| b.id == board_id)
    .map(|b| b.name.clone())
    .unwrap_or_else(|| "Untitled".to_string());
  let board_paths = board_paths(&paths.root_dir, &board_id);
  ensure_board_file(&board_paths, &board_id, &name)?;
  let _ = ensure_board_index_contains(&paths, index, &board_id, &name)?;
  Ok(board_paths.assets_dir.to_string_lossy().to_string())
}

#[tauri::command]
fn load_chat(paths: tauri::State<'_, AppPaths>, board_id: String) -> Result<ChatStore, String> {
  if !is_valid_board_id(&board_id) {
    return Err("invalid board id".to_string());
  }
  let index = read_index(&paths)?;
  let name = index
    .boards
    .iter()
    .find(|b| b.id == board_id)
    .map(|b| b.name.as_str())
    .unwrap_or("Untitled");
  let board_paths = board_paths(&paths.root_dir, &board_id);
  ensure_board_file(&board_paths, &board_id, name)?;

  let chat_path = board_paths.dir.join("chat.json");
  if !chat_path.exists() {
    return Ok(ChatStore {
      version: 1,
      messages: vec![],
      summary: None,
      summary_up_to: 0,
      last_session_id: None,
    });
  }

  let raw = std::fs::read_to_string(&chat_path).map_err(|e| format!("read chat failed: {e}"))?;
  let chat: ChatStore = serde_json::from_str(&raw).map_err(|e| format!("parse chat failed: {e}"))?;
  Ok(chat)
}

#[tauri::command]
fn save_chat(
  paths: tauri::State<'_, AppPaths>,
  board_id: String,
  chat: ChatStore,
) -> Result<(), String> {
  if !is_valid_board_id(&board_id) {
    return Err("invalid board id".to_string());
  }
  let index = read_index(&paths)?;
  let name = index
    .boards
    .iter()
    .find(|b| b.id == board_id)
    .map(|b| b.name.as_str())
    .unwrap_or("Untitled");
  let board_paths = board_paths(&paths.root_dir, &board_id);
  ensure_board_file(&board_paths, &board_id, name)?;

  let chat_path = board_paths.dir.join("chat.json");
  let tmp_path = board_paths.dir.join("chat.json.tmp");
  let serialized =
    serde_json::to_string_pretty(&chat).map_err(|e| format!("serialize chat failed: {e}"))?;
  std::fs::write(&tmp_path, serialized).map_err(|e| format!("write chat failed: {e}"))?;
  std::fs::rename(&tmp_path, &chat_path).map_err(|e| format!("write chat failed: {e}"))?;
  Ok(())
}

#[tauri::command]
fn save_image(
  paths: tauri::State<'_, AppPaths>,
  board_id: String,
  filename: String,
  bytes_base64: String,
) -> Result<String, String> {
  if !is_valid_board_id(&board_id) {
    return Err("invalid board id".to_string());
  }
  let index = read_index(&paths)?;
  let name = index
    .boards
    .iter()
    .find(|b| b.id == board_id)
    .map(|b| b.name.as_str())
    .unwrap_or("Untitled");
  let board_paths = board_paths(&paths.root_dir, &board_id);
  ensure_board_file(&board_paths, &board_id, name)?;

  let decoded = base64::engine::general_purpose::STANDARD
    .decode(bytes_base64.as_bytes())
    .map_err(|e| format!("base64 decode failed: {e}"))?;

  let safe_name = filename.replace('\\', "_").replace('/', "_").replace("..", "_");

  let out = board_paths.assets_dir.join(&safe_name);
  let tmp = board_paths.assets_dir.join(format!("{safe_name}.tmp"));

  std::fs::write(&tmp, decoded).map_err(|e| format!("write temp image failed: {e}"))?;
  if out.exists() {
    let _ = std::fs::remove_file(&out);
  }
  std::fs::rename(&tmp, &out).map_err(|e| format!("rename image failed: {e}"))?;

  Ok(format!("assets/{safe_name}"))
}

#[tauri::command]
fn load_board(paths: tauri::State<'_, AppPaths>, board_id: String) -> Result<Board, String> {
  if !is_valid_board_id(&board_id) {
    return Err("invalid board id".to_string());
  }
  let index = read_index(&paths)?;
  let name = index
    .boards
    .iter()
    .find(|b| b.id == board_id)
    .map(|b| b.name.as_str())
    .unwrap_or("Untitled");
  let board_paths = board_paths(&paths.root_dir, &board_id);
  ensure_board_file(&board_paths, &board_id, name)?;

  let text = std::fs::read_to_string(&board_paths.file).map_err(|e| format!("read failed: {e}"))?;

  match serde_json::from_str::<Board>(&text) {
    Ok(mut board) => {
      if board.id != board_id {
        board.id = board_id.clone();
        write_board_atomic(&board_paths, &board)?;
      }
      Ok(board)
    }
    Err(_) => {
      let board = empty_board(&board_id, name);
      write_board_atomic(&board_paths, &board)?;
      Ok(board)
    }
  }
}

#[tauri::command]
fn save_board(
  paths: tauri::State<'_, AppPaths>,
  board_id: String,
  board: Board,
) -> Result<(), String> {
  if !is_valid_board_id(&board_id) {
    return Err("invalid board id".to_string());
  }
  if board.id != board_id {
    return Err(format!(
      "board id mismatch (payload {}, expected {})",
      board.id, board_id
    ));
  }
  let index = read_index(&paths)?;
  if let Some(meta) = index.boards.iter().find(|b| b.id == board_id) {
    if meta.deleted_at.is_some() {
      return Err("board is deleted".to_string());
    }
  }
  let board_paths = board_paths(&paths.root_dir, &board_id);
  ensure_board_file(&board_paths, &board_id, &board.name)?;
  write_board_atomic(&board_paths, &board)?;
  let _ = ensure_board_index_contains(&paths, index, &board_id, &board.name)?;
  Ok(())
}
