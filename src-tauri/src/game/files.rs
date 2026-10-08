use crate::database::dto::FullGameData;
use crate::database::repository::games_repository::GamesRepository;
use sea_orm::DatabaseConnection;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;
use tauri_plugin_opener::open_path;
use walkdir::WalkDir;

#[derive(Debug, Clone, serde::Serialize)]
pub struct GameTextFileCandidate {
    pub path: String,
    pub name: String,
}

const SAVE_FILE_EXTENSIONS: &[&str] = &[
    "sav", "dat", "save", "sfs", "rpgsave", "rvdata", "rvdata2", "json", "xml", "yaml", "yml",
    "cfg", "config", "backup",
];

const SAVE_FILE_KEYWORDS: &[&str] = &[
    "save",
    "sav",
    "slot",
    "data",
    "record",
    "progress",
    "file",
    "state",
    "status",
    "profile",
    "account",
    "user",
    "game",
    "session",
    "checkpoint",
    "quick",
    "auto",
];

const SAVE_DIRECTORY_PATTERNS: &[&str] = &[
    "save",
    "saves",
    "savedata",
    "save_data",
    "userdata",
    "user_data",
    "data",
    "game",
    "games",
    "appdata",
    "local",
    "roaming",
];

const SAVE_DIRECTORY_SUFFIXES: &[&str] = &[
    "data",
    "save",
    "saves",
    "games",
    "game",
    "user",
    "profile",
    "config",
    "settings",
    "storage",
    "backup",
    "cache",
    "temp",
    "local",
    "roaming",
    "存档",
    "保存",
    "数据",
    "配置",
    "设置",
    "档案",
    "记录",
    "进度",
    "system",
    "content",
    "resources",
    "assets",
    "files",
    "documents",
    "セーブ",
    "データ",
    "設定",
    "システム",
    "コンフィグ",
];

const CHINESE_LOCALIZATION_SUFFIXES: &[&str] = &[
    "chs",
    "cht",
    "cn",
    "zh",
    "zhcn",
    "zhtw",
    "sc",
    "tc",
    "chinese",
    "简体",
    "繁体",
    "中文",
    "汉化",
    "汉化版",
    "steam简中",
];

const EXCLUDE_PATH_KEYWORDS: &[&str] = &[
    "potatovn",
    ".potatovn",
    "potato vn",
    "potato-vn",
    "potato_vn",
    "skerry",
    "reinamanager",
    "windows",
    "system32",
    "syswow64",
    "drivers",
    "driverstore",
    "servicing",
    "microsoft",
    "winsxs",
    "program files",
    "program files (x86)",
    "programdata",
    "steamapps",
    "epic games",
    "uplay",
    "ubisoft",
    "origin",
    "ea games",
    "gog",
    "battle.net",
    "blizzard",
    "riot games",
    "discord",
    "visual studio",
    "msbuild",
    "nuget",
    "dotnet",
    "sdk",
    "vscode",
    "android",
    "google",
    "chrome",
    "mozilla",
    "firefox",
    "edge",
    "opera",
    "wechat",
    "qq",
    "nvidia",
    "amd",
    "intel",
    "cache",
    "caches",
    "temporary",
    "logs",
    "log",
    "$recycle.bin",
    "system volume information",
];

#[derive(Debug, Clone)]
struct SaveDirectoryCandidate {
    directory: PathBuf,
    score: f64,
}

async fn load_game(db: &DatabaseConnection, game_id: u32) -> Result<FullGameData, String> {
    GamesRepository::find_by_id(db, game_id as i32)
        .await
        .map_err(|error| format!("查询游戏失败: {error}"))?
        .ok_or_else(|| format!("游戏不存在: {game_id}"))
}

fn text_priority(path: &Path) -> u8 {
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if [
        "readme", "read me", "manual", "说明", "安装", "须知", "攻略",
    ]
    .iter()
    .any(|token| name.contains(token))
    {
        0
    } else {
        1
    }
}

fn find_text_file(root: &Path) -> Option<PathBuf> {
    let mut candidates = collect_text_files(root);
    candidates.sort_by_key(|path| (text_priority(path), path.to_string_lossy().len()));
    candidates.into_iter().next()
}

fn collect_text_files(root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return candidates;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("txt"))
        {
            candidates.push(path);
        }
    }
    candidates.sort_by_key(|path| (text_priority(path), path.to_string_lossy().len()));
    candidates
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn push_clean_keyword(keywords: &mut HashSet<String>, value: impl AsRef<str>) {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return;
    }
    let lower = value.to_lowercase();
    keywords.insert(lower.clone());
    let compact = lower
        .chars()
        .filter(|ch| {
            !ch.is_whitespace() && !matches!(ch, '_' | '-' | '.' | ':' | '!' | '！' | '・' | '·')
        })
        .collect::<String>();
    if compact.len() >= 3 {
        keywords.insert(compact);
    }
}

fn collect_value_strings(value: &Value, keys: &[&str], keywords: &mut HashSet<String>) {
    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(item) = object.get(*key) {
                match item {
                    Value::String(value) => push_clean_keyword(keywords, value),
                    Value::Array(values) => {
                        for child in values {
                            if let Some(value) = child.as_str() {
                                push_clean_keyword(keywords, value);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

fn game_keywords(game: &FullGameData) -> HashSet<String> {
    let mut keywords = HashSet::new();
    if let Some(custom) = &game.custom_data {
        if let Some(value) = &custom.name {
            push_clean_keyword(&mut keywords, value);
        }
        if let Some(value) = &custom.name_cn {
            push_clean_keyword(&mut keywords, value);
        }
        if let Some(value) = &custom.developer {
            push_clean_keyword(&mut keywords, value);
        }
        if let Some(values) = &custom.aliases {
            for value in values {
                push_clean_keyword(&mut keywords, value);
            }
        }
    }
    for source in &game.sources {
        if let Some(data) = &source.data {
            collect_value_strings(
                data,
                &[
                    "name",
                    "name_cn",
                    "developer",
                    "aliases",
                    "all_titles",
                    "title",
                ],
                &mut keywords,
            );
        }
    }
    keywords.retain(|value| value.chars().count() >= 2);
    keywords
}

fn standard_user_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(path) = env::var_os("USERPROFILE") {
        let user = PathBuf::from(path);
        push_unique_path(&mut roots, user.clone());
        push_unique_path(&mut roots, user.join("Documents"));
        push_unique_path(&mut roots, user.join("Documents").join("My Games"));
        push_unique_path(&mut roots, user.join("Saved Games"));
    }
    for key in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(path) = env::var_os(key) {
            push_unique_path(&mut roots, PathBuf::from(path));
        }
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local_app_data);
        if let Some(parent) = local.parent() {
            push_unique_path(&mut roots, parent.join("LocalLow"));
        }
    }
    roots
}

fn candidate_roots(game: &FullGameData, keywords: &HashSet<String>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(localpath) = game.localpath.as_deref() {
        push_unique_path(&mut roots, PathBuf::from(localpath));
    }
    for root in standard_user_roots() {
        push_unique_path(&mut roots, root.clone());
        for keyword in keywords.iter().take(24) {
            push_unique_path(&mut roots, root.join(keyword));
        }
    }
    roots
}

fn should_exclude_path(path: &Path, game_root: Option<&Path>) -> bool {
    if let Some(game_root) = game_root {
        if path.starts_with(game_root) {
            return false;
        }
    }
    let lower = path.to_string_lossy().to_lowercase();
    EXCLUDE_PATH_KEYWORDS
        .iter()
        .any(|keyword| lower.contains(keyword))
}

fn contains_any(value: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|pattern| value.contains(pattern))
}

fn save_file_score(path: &Path, keywords: &HashSet<String>, game_root: Option<&Path>) -> f64 {
    if should_exclude_path(path, game_root) {
        return 0.0;
    }
    let mut score = 0.0;
    if let Some(game_root) = game_root {
        if path.starts_with(game_root) {
            score += 35.0;
        }
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let directory = path
        .parent()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            SAVE_FILE_EXTENSIONS
                .iter()
                .any(|expected| ext.eq_ignore_ascii_case(expected))
        })
    {
        score += 28.0;
    }
    if contains_any(&file_name, SAVE_FILE_KEYWORDS) {
        score += 18.0;
    }
    if contains_any(&directory, SAVE_DIRECTORY_PATTERNS) {
        score += 16.0;
    }
    if contains_any(&directory, SAVE_DIRECTORY_SUFFIXES) {
        score += 12.0;
    }
    if contains_any(&directory, CHINESE_LOCALIZATION_SUFFIXES) {
        score += 10.0;
    }
    for keyword in keywords {
        if keyword.len() >= 3 && directory.contains(keyword) {
            score += 46.0;
            break;
        }
    }
    if let Ok(metadata) = fs::metadata(path) {
        let size = metadata.len();
        if (1024..10 * 1024 * 1024).contains(&size) {
            score += 10.0;
        } else if (100..100 * 1024 * 1024).contains(&size) {
            score += 5.0;
        }
        if let Ok(modified) = metadata.modified() {
            if let Ok(elapsed) = modified.elapsed() {
                if elapsed.as_secs() < 24 * 60 * 60 {
                    score += 8.0;
                }
            }
        }
    }
    score
}

fn scan_save_directory(game: &FullGameData) -> Option<PathBuf> {
    if let Some(savepath) = game.savepath.as_deref() {
        let savepath = PathBuf::from(savepath);
        if savepath.is_dir() {
            return Some(savepath);
        }
    }

    let keywords = game_keywords(game);
    let game_root = game.localpath.as_deref().map(PathBuf::from);
    let mut directory_scores: HashMap<PathBuf, f64> = HashMap::new();
    for root in candidate_roots(game, &keywords) {
        if !root.exists() || should_exclude_path(&root, game_root.as_deref()) {
            continue;
        }
        let max_depth = if game_root
            .as_ref()
            .is_some_and(|game_root| root == *game_root)
        {
            5
        } else {
            3
        };
        for entry in WalkDir::new(&root)
            .max_depth(max_depth)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .take(2600)
        {
            let path = entry.path();
            if should_exclude_path(path, game_root.as_deref()) {
                continue;
            }
            if entry.file_type().is_dir() {
                let lower = path.to_string_lossy().to_lowercase();
                let mut directory_score = 0.0;
                if contains_any(&lower, SAVE_DIRECTORY_PATTERNS) {
                    directory_score += 14.0;
                }
                if contains_any(&lower, SAVE_DIRECTORY_SUFFIXES) {
                    directory_score += 8.0;
                }
                for keyword in &keywords {
                    if keyword.len() >= 3 && lower.contains(keyword) {
                        directory_score += 60.0;
                        break;
                    }
                }
                if directory_score > 0.0 {
                    *directory_scores.entry(path.to_path_buf()).or_insert(0.0) += directory_score;
                }
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let score = save_file_score(path, &keywords, game_root.as_deref());
            if score <= 0.0 {
                continue;
            }
            if let Some(directory) = path.parent() {
                *directory_scores
                    .entry(directory.to_path_buf())
                    .or_insert(0.0) += score;
            }
        }
    }

    directory_scores
        .into_iter()
        .map(|(directory, score)| SaveDirectoryCandidate { directory, score })
        .filter(|candidate| candidate.directory.is_dir())
        .max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(Ordering::Equal))
        .map(|candidate| candidate.directory)
}

#[command]
pub async fn open_game_readme_text(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
) -> Result<String, String> {
    open_game_readme_text_for_game(db.inner(), game_id).await
}

pub async fn open_game_readme_text_for_game(
    db: &DatabaseConnection,
    game_id: u32,
) -> Result<String, String> {
    let game = load_game(db, game_id).await?;
    let root = PathBuf::from(game.localpath.ok_or_else(|| "游戏目录未设置".to_string())?);
    if !root.is_dir() {
        return Err("游戏目录不存在".to_string());
    }
    let file =
        find_text_file(&root).ok_or_else(|| "游戏目录中没有找到 TXT 说明文件".to_string())?;
    open_path(&file, None::<&str>).map_err(|error| format!("打开说明文本失败: {error}"))?;
    Ok(file.to_string_lossy().to_string())
}

#[command]
pub async fn list_game_readme_texts(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
) -> Result<Vec<GameTextFileCandidate>, String> {
    list_game_readme_texts_for_game(db.inner(), game_id).await
}

pub async fn list_game_readme_texts_for_game(
    db: &DatabaseConnection,
    game_id: u32,
) -> Result<Vec<GameTextFileCandidate>, String> {
    let game = load_game(db, game_id).await?;
    let root = PathBuf::from(game.localpath.ok_or_else(|| "游戏目录未设置".to_string())?);
    if !root.is_dir() {
        return Err("游戏目录不存在".to_string());
    }
    Ok(collect_text_files(&root)
        .into_iter()
        .map(|path| GameTextFileCandidate {
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            path: path.to_string_lossy().to_string(),
        })
        .collect())
}

#[command]
pub async fn open_game_readme_text_path(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
    path: String,
) -> Result<String, String> {
    open_game_readme_text_path_for_game(db.inner(), game_id, path).await
}

pub async fn open_game_readme_text_path_for_game(
    db: &DatabaseConnection,
    game_id: u32,
    path: String,
) -> Result<String, String> {
    let game = load_game(db, game_id).await?;
    let root = PathBuf::from(game.localpath.ok_or_else(|| "游戏目录未设置".to_string())?);
    let file = PathBuf::from(path);
    if !root.is_dir() || !file.is_file() || !file.starts_with(&root) {
        return Err("说明文本路径无效".to_string());
    }
    if !file
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("txt"))
    {
        return Err("请选择 TXT 文本文件".to_string());
    }
    open_path(&file, None::<&str>).map_err(|error| format!("打开说明文本失败: {error}"))?;
    Ok(file.to_string_lossy().to_string())
}

#[command]
pub async fn detect_game_save_directory(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
) -> Result<Option<String>, String> {
    detect_game_save_directory_for_game(db.inner(), game_id).await
}

pub async fn detect_game_save_directory_for_game(
    db: &DatabaseConnection,
    game_id: u32,
) -> Result<Option<String>, String> {
    let game = load_game(db, game_id).await?;
    Ok(tokio::task::spawn_blocking(move || {
        scan_save_directory(&game).map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("检测存档目录失败: {error}"))?)
}

#[command]
pub async fn open_game_save_directory(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
) -> Result<String, String> {
    open_game_save_directory_for_game(db.inner(), game_id).await
}

pub async fn open_game_save_directory_for_game(
    db: &DatabaseConnection,
    game_id: u32,
) -> Result<String, String> {
    let game = load_game(db, game_id).await?;
    let savepath = game
        .savepath
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "请先手动指定存档目录".to_string())?;
    let directory = PathBuf::from(savepath);
    if !directory.is_dir() {
        return Err(format!(
            "存档目录不存在或不是文件夹: {}",
            directory.display()
        ));
    }
    open_path(&directory, None::<&str>).map_err(|error| format!("打开存档目录失败: {error}"))?;
    Ok(directory.to_string_lossy().to_string())
}
