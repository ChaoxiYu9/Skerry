use crate::backup::common::BackupResult;
use crate::database::db;
use crate::database::dto::{
    FullGameData, InsertCollectionData, InsertGameData, UpdateCollectionData, UpdateGameData,
    UpdateSettingsData,
};
use crate::database::repository::collections_repository::CollectionsRepository;
use crate::database::repository::game_stats_repository::GameStatsRepository;
use crate::database::repository::games_repository::{
    GameType, GamesRepository, SortOption, SortOrder,
};
use crate::database::repository::settings_repository::SettingsRepository;
use crate::entity::custom_data::CustomData;
use crate::entity::tasks;
use crate::entity::{game_statistics, savedata};
use crate::game::scan::ScanMode;
use crate::install::protocol::InstallRequest;
use crate::install::{
    ACTIVE_TASK_STATUSES, GameInstallTaskPayloadV1, NativeInstallHost, TaskRuntimeState, find_task,
    recover_interrupted_tasks, remove_task_artifacts, resume_pending_tasks_with_host,
    set_task_cancelled, spawn_task_with_host, wait_for_task_completion,
};
use chrono::{Datelike, NaiveDate};
use migration::MigratorTrait;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    IntoActiveModel, QueryFilter, QueryOrder, Set,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{PipeMode, ServerOptions};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex;

const DEFAULT_PIPE_NAME: &str = "skerry-native-ipc";
const DISPLAY_SOURCE_PRIORITY: [&str; 7] = [
    "bgm",
    "vndb",
    "hikarinagi",
    "dlsite",
    "erogamescape",
    "ymgal",
    "kun",
];
const DEVELOPER_SOURCE_PRIORITY: [&str; 7] = [
    "vndb",
    "erogamescape",
    "kun",
    "dlsite",
    "ymgal",
    "hikarinagi",
    "bgm",
];
const SOURCE_COVER_PRIORITY: [&str; 7] = [
    "hikarinagi",
    "bgm",
    "vndb",
    "erogamescape",
    "dlsite",
    "kun",
    "ymgal",
];
const CLOUD_COVER_EXTENSIONS: [&str; 7] = ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"];

type NativeIpcResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IpcRequest {
    method: String,
    #[serde(default)]
    payload: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IpcResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGameCard {
    id: String,
    title: String,
    developer: String,
    status: String,
    accent_index: i32,
    play_hours: f64,
    last_played: Option<i32>,
    cover_key: Option<String>,
    banner_key: Option<String>,
    image_uri: Option<String>,
    banner_uri: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGameDetail {
    id: String,
    title: String,
    developer: String,
    status: String,
    play_hours: f64,
    date: Option<String>,
    summary: String,
    tags: Vec<String>,
    local_path: Option<String>,
    executable: Option<String>,
    launch_type: String,
    steam_launch_id: Option<String>,
    save_path: Option<String>,
    autosave: Option<i32>,
    max_backups: Option<i32>,
    session_count: i32,
    savedata_count: u64,
    last_played: Option<i32>,
    image_uri: Option<String>,
    banner_uri: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCollectionGroup {
    id: String,
    name: String,
    game_count: u64,
    is_virtual: bool,
    icon: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCollectionCategory {
    id: String,
    name: String,
    game_count: u64,
    is_virtual: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstallTask {
    id: i64,
    task_type: String,
    title: String,
    status: String,
    stage: Option<String>,
    progress_current: i64,
    progress_total: Option<i64>,
    progress_unit: Option<String>,
    error_message: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadsSnapshot {
    embedded: Value,
    install_tasks: Vec<NativeInstallTask>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSettings {
    save_root_path: Option<String>,
    db_backup_path: Option<String>,
    install_root_path: Option<String>,
    le_path: Option<String>,
    magpie_path: Option<String>,
    detail_backdrop_path: Option<String>,
    bgm_signed_in: bool,
    bgm_display_name: Option<String>,
    hikarinagi_signed_in: bool,
    hikarinagi_display_name: Option<String>,
    vndb_token_configured: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeReportTopGame {
    id: String,
    title: String,
    minutes: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAnnualReport {
    years: Vec<i32>,
    selected_year: i32,
    total_minutes: i32,
    games_played: usize,
    active_days: usize,
    longest_streak: usize,
    monthly_minutes: Vec<i32>,
    weekday_minutes: Vec<i32>,
    top_games: Vec<NativeReportTopGame>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLaunchResult {
    status: String,
    message: String,
    process_id: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeState {
    game_id: String,
    running: bool,
    process_id: Option<u32>,
    started_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDetectedPath {
    path: String,
    label: String,
    confidence: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameTextFileCandidate {
    name: String,
    path: String,
    size: u64,
    modified_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectableCollection {
    id: i32,
    name: String,
    parent_id: Option<i32>,
    level: u8,
    is_selected: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCollectionMembership {
    game_id: i32,
    collections: Vec<SelectableCollection>,
}

#[derive(Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct NativeSimpleGamePayload {
    title: Option<String>,
    developer: Option<String>,
    summary: Option<String>,
    tags: Option<Vec<String>>,
    tag_text: Option<String>,
    date: Option<String>,
    local_path: Option<String>,
    executable: Option<String>,
    launch_type: Option<String>,
    steam_launch_id: Option<String>,
    save_path: Option<String>,
    autosave: Option<bool>,
    max_backups: Option<i32>,
    clear: Option<i32>,
}

impl Default for NativeSimpleGamePayload {
    fn default() -> Self {
        Self {
            title: None,
            developer: None,
            summary: None,
            tags: None,
            tag_text: None,
            date: None,
            local_path: None,
            executable: None,
            launch_type: None,
            steam_launch_id: None,
            save_path: None,
            autosave: None,
            max_backups: None,
            clear: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSavedataRecord {
    id: i32,
    game_id: i32,
    file: String,
    backup_time: i32,
    file_size: i32,
    backup_path: String,
}

#[derive(Debug, Clone)]
struct RunningNativeGame {
    process_id: u32,
    started_at: i64,
}

static NATIVE_RUNNING_GAMES: OnceLock<Mutex<HashMap<i32, RunningNativeGame>>> = OnceLock::new();
static NATIVE_TASK_RUNTIME: OnceLock<TaskRuntimeState> = OnceLock::new();

fn native_running_games() -> &'static Mutex<HashMap<i32, RunningNativeGame>> {
    NATIVE_RUNNING_GAMES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn native_task_runtime() -> TaskRuntimeState {
    NATIVE_TASK_RUNTIME
        .get_or_init(TaskRuntimeState::default)
        .clone()
}

fn native_resource_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn native_install_host() -> NativeInstallHost {
    NativeInstallHost::new(native_task_runtime(), native_resource_dir())
}

fn payload_task_id(payload: &Option<Value>, method: &str) -> Result<i64, String> {
    payload
        .as_ref()
        .and_then(|payload| payload.get("id").or_else(|| payload.get("taskId")))
        .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse::<i64>().ok()))
        .ok_or_else(|| format!("{method} 需要有效 taskId"))
}

fn payload_game_id(payload: &Option<Value>, method: &str) -> Result<i32, String> {
    payload
        .as_ref()
        .and_then(|payload| payload.get("id").or_else(|| payload.get("gameId")))
        .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse::<i64>().ok()))
        .and_then(|id| i32::try_from(id).ok())
        .ok_or_else(|| format!("{method} 需要有效 id"))
}

fn payload_collection_id(payload: &Option<Value>, method: &str) -> Result<i32, String> {
    payload
        .as_ref()
        .and_then(|payload| payload.get("collectionId").or_else(|| payload.get("id")))
        .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse::<i64>().ok()))
        .and_then(|id| i32::try_from(id).ok())
        .ok_or_else(|| format!("{method} 需要有效 collectionId"))
}

fn payload_i32_list(payload: &Value, key: &str) -> Result<Vec<i32>, String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("需要 {key} 数组"))?
        .iter()
        .map(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.parse::<i64>().ok())
                .and_then(|id| i32::try_from(id).ok())
                .ok_or_else(|| format!("{key} 包含无效 ID"))
        })
        .collect()
}

fn clean_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn split_tags(payload: &NativeSimpleGamePayload) -> Option<Vec<String>> {
    let tags = payload.tags.clone().unwrap_or_else(|| {
        payload
            .tag_text
            .as_deref()
            .unwrap_or_default()
            .split([',', '，', ';', '；'])
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(ToOwned::to_owned)
            .collect()
    });
    (!tags.is_empty()).then_some(tags)
}

fn simple_custom_data(payload: &NativeSimpleGamePayload) -> Option<CustomData> {
    let title = clean_text(payload.title.clone());
    let custom = CustomData {
        name: title.clone(),
        name_cn: title,
        developer: clean_text(payload.developer.clone()),
        summary: clean_text(payload.summary.clone()),
        tags: split_tags(payload),
        ..Default::default()
    };
    (custom.name.is_some()
        || custom.name_cn.is_some()
        || custom.developer.is_some()
        || custom.summary.is_some()
        || custom.tags.is_some())
    .then_some(custom)
}

fn simple_insert_game(payload: NativeSimpleGamePayload) -> InsertGameData {
    let custom_data = simple_custom_data(&payload);
    let steam_launch_id = clean_text(payload.steam_launch_id);
    let launch_type = payload
        .launch_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if steam_launch_id.is_some() {
                "steam"
            } else {
                "local"
            }
            .to_string()
        });
    InsertGameData {
        id_type: "custom".to_string(),
        date: clean_text(payload.date),
        localpath: clean_text(payload.local_path),
        executable: clean_text(payload.executable),
        launch_type,
        steam_launch_id,
        savepath: clean_text(payload.save_path),
        autosave: payload.autosave.map(i32::from),
        maxbackups: payload.max_backups,
        clear: payload.clear,
        le_launch: None,
        magpie: None,
        custom_data,
        sources: Vec::new(),
    }
}

async fn simple_update_game(
    db: &DatabaseConnection,
    game_id: i32,
    payload: NativeSimpleGamePayload,
) -> Result<UpdateGameData, String> {
    let current = GamesRepository::find_by_id(db, game_id)
        .await
        .map_err(|error| format!("读取当前游戏失败: {error}"))?
        .ok_or_else(|| format!("找不到游戏: {game_id}"))?;
    let mut custom = current.custom_data.unwrap_or_default();

    if payload.title.is_some() {
        let title = clean_text(payload.title.clone());
        custom.name = title.clone();
        custom.name_cn = title;
    }
    if payload.developer.is_some() {
        custom.developer = clean_text(payload.developer.clone());
    }
    if payload.summary.is_some() {
        custom.summary = clean_text(payload.summary.clone());
    }
    if payload.tags.is_some() || payload.tag_text.is_some() {
        custom.tags = split_tags(&payload);
    }

    let mut updates = UpdateGameData::default();
    if payload.date.is_some() {
        updates.date = Some(clean_text(payload.date));
    }
    if payload.local_path.is_some() {
        updates.localpath = Some(clean_text(payload.local_path));
    }
    if payload.executable.is_some() {
        updates.executable = Some(clean_text(payload.executable));
    }
    if let Some(launch_type) = payload.launch_type {
        updates.launch_type = clean_text(Some(launch_type));
    }
    if payload.steam_launch_id.is_some() {
        updates.steam_launch_id = Some(clean_text(payload.steam_launch_id));
    }
    if payload.save_path.is_some() {
        updates.savepath = Some(clean_text(payload.save_path));
    }
    if let Some(autosave) = payload.autosave {
        updates.autosave = Some(Some(i32::from(autosave)));
    }
    if payload.max_backups.is_some() {
        updates.maxbackups = Some(payload.max_backups);
    }
    if payload.clear.is_some() {
        updates.clear = Some(payload.clear);
    }
    updates.custom_data = Some(Some(custom));
    Ok(updates)
}

fn parse_scan_mode(value: Option<&Value>) -> ScanMode {
    match value.and_then(Value::as_str).unwrap_or("executable") {
        "first_level_directory" | "firstLevelDirectory" | "directory" | "folder" => {
            ScanMode::FirstLevelDirectory
        }
        _ => ScanMode::Executable,
    }
}

fn savedata_backup_file_path(
    save_root_path: Option<&str>,
    game_id: i32,
    file: &str,
) -> Result<PathBuf, String> {
    let root = if let Some(custom) = save_root_path.filter(|value| !value.trim().is_empty()) {
        PathBuf::from(custom).join("backups")
    } else {
        reina_path::get_base_data_dir()?.join("backups")
    };
    Ok(root.join(format!("game_{game_id}")).join(file))
}

async fn launch_native_game(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "games.launch")?;
    {
        let running = native_running_games().lock().await;
        if let Some(session) = running.get(&game_id) {
            return serde_json::to_value(NativeLaunchResult {
                status: "already_running".to_string(),
                message: "游戏已经在运行".to_string(),
                process_id: Some(session.process_id),
            })
            .map_err(|error| format!("序列化启动结果失败: {error}"));
        }
    }

    let game = GamesRepository::find_by_id(db, game_id)
        .await
        .map_err(|error| format!("查询游戏失败: {error}"))?
        .ok_or_else(|| format!("游戏不存在: {game_id}"))?;
    if game.launch_type == "steam" {
        let steam_id = game
            .steam_launch_id
            .as_deref()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .ok_or_else(|| "Steam 启动 ID 无效".to_string())?;
        let uri = format!("steam://rungameid/{steam_id}");
        TokioCommand::new("cmd.exe")
            .args(["/C", "start", "", &uri])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("打开 Steam 启动项失败: {error}"))?;

        return serde_json::to_value(NativeLaunchResult {
            status: "delegated".to_string(),
            message: format!("已交由 Steam 启动游戏 ({steam_id})"),
            process_id: None,
        })
        .map_err(|error| format!("序列化启动结果失败: {error}"));
    }

    let game_dir = PathBuf::from(
        game.localpath
            .as_deref()
            .ok_or_else(|| "游戏目录未设置".to_string())?,
    );
    let executable = game
        .executable
        .as_deref()
        .ok_or_else(|| "游戏启动文件未设置".to_string())?;
    let executable_path = game_dir.join(executable);
    if !executable_path.is_file() {
        return Err(format!("游戏启动文件不存在: {}", executable_path.display()));
    }

    let args = payload
        .as_ref()
        .and_then(|payload| payload.get("args"))
        .and_then(Value::as_array)
        .map(|args| args.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut command = TokioCommand::new(&executable_path);
    command
        .args(args)
        .current_dir(&game_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动游戏失败: {error}"))?;
    let process_id = child
        .id()
        .ok_or_else(|| "启动成功但无法获取进程号".to_string())?;
    let started_at = chrono::Utc::now().timestamp();
    native_running_games().lock().await.insert(
        game_id,
        RunningNativeGame {
            process_id,
            started_at,
        },
    );

    let db = db.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        let ended_at = chrono::Utc::now().timestamp();
        let duration_seconds = ended_at.saturating_sub(started_at);
        if duration_seconds >= 60 {
            let duration_minutes = (duration_seconds.saturating_add(30) / 60) as i32;
            if let (Ok(game_id), Ok(start_time), Ok(end_time)) = (
                i32::try_from(game_id),
                i32::try_from(started_at),
                i32::try_from(ended_at),
            ) {
                if let Err(error) = GameStatsRepository::record_session_with_statistics(
                    &db,
                    game_id,
                    start_time,
                    end_time,
                    duration_minutes,
                )
                .await
                {
                    eprintln!("native game session record failed: {error}");
                }
            }
        }
        native_running_games().lock().await.remove(&game_id);
    });

    serde_json::to_value(NativeLaunchResult {
        status: "tracking".to_string(),
        message: format!("成功启动游戏: {executable}"),
        process_id: Some(process_id),
    })
    .map_err(|error| format!("序列化启动结果失败: {error}"))
}

async fn stop_native_game(payload: Option<Value>) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "games.stop")?;
    let session = native_running_games().lock().await.get(&game_id).cloned();
    let Some(session) = session else {
        return Ok(
            json!({ "success": true, "message": "游戏当前没有原生运行会话", "terminatedCount": 0 }),
        );
    };

    TokioCommand::new("taskkill.exe")
        .args(["/PID", &session.process_id.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|error| format!("停止游戏失败: {error}"))?;
    Ok(json!({ "success": true, "message": "已请求停止游戏", "terminatedCount": 1 }))
}

async fn native_game_runtime(payload: Option<Value>) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "games.runtime")?;
    let session = native_running_games().lock().await.get(&game_id).cloned();
    serde_json::to_value(NativeRuntimeState {
        game_id: game_id.to_string(),
        running: session.is_some(),
        process_id: session.as_ref().map(|session| session.process_id),
        started_at: session.as_ref().map(|session| session.started_at),
    })
    .map_err(|error| format!("序列化运行状态失败: {error}"))
}

async fn detect_save_paths(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "games.detectSavePath")?;
    let game = GamesRepository::find_by_id(db, game_id)
        .await
        .map_err(|error| format!("读取游戏失败: {error}"))?
        .ok_or_else(|| format!("找不到游戏: {game_id}"))?;
    let Some(local_path) = game
        .localpath
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(json!([]));
    };

    let root = PathBuf::from(local_path);
    if !root.is_dir() {
        return Err(format!("游戏目录不存在: {}", root.display()));
    }

    let mut candidates = Vec::new();
    if let Some(save_path) = game
        .savepath
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let path = PathBuf::from(save_path);
        if path.is_dir() {
            candidates.push(NativeDetectedPath {
                path: path.to_string_lossy().into_owned(),
                label: "当前存档目录".to_string(),
                confidence: 100,
            });
        }
    }

    let known_names = [
        ("save", "Save", 96_u8),
        ("saves", "Saves", 96),
        ("savedata", "Save Data", 94),
        ("save_data", "Save Data", 94),
        ("userdata", "User Data", 88),
        ("data", "Data", 72),
        ("profile", "Profile", 84),
        ("profiles", "Profiles", 84),
    ];
    let entries = std::fs::read_dir(&root).map_err(|error| format!("扫描游戏目录失败: {error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let normalized = name.trim().to_ascii_lowercase();
        let Some((_, label, confidence)) = known_names
            .iter()
            .find(|(candidate, _, _)| *candidate == normalized)
        else {
            continue;
        };
        if candidates
            .iter()
            .any(|candidate: &NativeDetectedPath| candidate.path == path.to_string_lossy())
        {
            continue;
        }
        candidates.push(NativeDetectedPath {
            path: path.to_string_lossy().into_owned(),
            label: (*label).to_string(),
            confidence: *confidence,
        });
    }

    candidates.sort_by(|left, right| {
        right.confidence.cmp(&left.confidence).then_with(|| {
            left.path
                .to_ascii_lowercase()
                .cmp(&right.path.to_ascii_lowercase())
        })
    });
    serde_json::to_value(candidates).map_err(|error| format!("序列化存档路径失败: {error}"))
}

async fn game_text_files(db: &DatabaseConnection, payload: Option<Value>) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "games.textFiles")?;
    let game = GamesRepository::find_by_id(db, game_id)
        .await
        .map_err(|error| format!("读取游戏失败: {error}"))?
        .ok_or_else(|| format!("找不到游戏: {game_id}"))?;
    let Some(local_path) = game
        .localpath
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(json!([]));
    };
    let root = PathBuf::from(local_path);
    if !root.is_dir() {
        return Err(format!("游戏目录不存在: {}", root.display()));
    }

    let mut files = Vec::new();
    for entry in std::fs::read_dir(&root)
        .map_err(|error| format!("扫描游戏说明文件失败: {error}"))?
        .flatten()
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if !matches!(extension.as_deref(), Some("txt" | "md" | "rtf")) {
            continue;
        }
        let metadata = entry.metadata().ok();
        let modified_at = metadata.as_ref().and_then(|metadata| {
            metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        });
        files.push(GameTextFileCandidate {
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            path: path.to_string_lossy().into_owned(),
            size: metadata.map(|metadata| metadata.len()).unwrap_or_default(),
            modified_at,
        });
    }
    files.sort_by(|left, right| {
        let score = |name: &str| {
            let value = name.to_ascii_lowercase();
            if value.contains("readme") || value.contains("说明") || value.contains("guide") {
                0
            } else if value.contains("manual") || value.contains("howto") {
                1
            } else {
                2
            }
        };
        score(&left.name).cmp(&score(&right.name)).then_with(|| {
            left.name
                .to_ascii_lowercase()
                .cmp(&right.name.to_ascii_lowercase())
        })
    });
    serde_json::to_value(files).map_err(|error| format!("序列化说明文件失败: {error}"))
}

async fn open_native_path(payload: Option<Value>) -> Result<Value, String> {
    let path = payload
        .as_ref()
        .and_then(|payload| payload.get("path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "paths.open 需要 path".to_string())?;
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(format!("路径不存在: {}", path.display()));
    }

    #[cfg(windows)]
    {
        if path.is_file() {
            TokioCommand::new("explorer.exe")
                .arg("/select,")
                .arg(&path)
                .spawn()
                .map_err(|error| format!("打开路径失败: {error}"))?;
        } else {
            TokioCommand::new("explorer.exe")
                .arg(&path)
                .spawn()
                .map_err(|error| format!("打开路径失败: {error}"))?;
        }
    }
    #[cfg(not(windows))]
    {
        return Err("当前平台不支持打开文件管理器".to_string());
    }
    Ok(json!({ "path": path.to_string_lossy() }))
}

async fn collection_membership(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "collections.membership")?;
    GamesRepository::find_by_id(db, game_id)
        .await
        .map_err(|error| format!("读取游戏失败: {error}"))?
        .ok_or_else(|| format!("找不到游戏: {game_id}"))?;
    let selected_ids = CollectionsRepository::get_game_collection_ids(db, game_id)
        .await
        .map_err(|error| format!("读取游戏合集失败: {error}"))?;
    let selected_ids = selected_ids.into_iter().collect::<BTreeSet<_>>();
    let roots = CollectionsRepository::find_root_collections(db)
        .await
        .map_err(|error| format!("读取根合集失败: {error}"))?;
    let mut collections = Vec::new();
    for root in roots {
        collections.push(SelectableCollection {
            id: root.id,
            name: root.name,
            parent_id: root.parent_id,
            level: 0,
            is_selected: selected_ids.contains(&root.id),
        });
        let children = CollectionsRepository::find_children(db, root.id)
            .await
            .map_err(|error| format!("读取合集子项失败: {error}"))?;
        collections.extend(children.into_iter().map(|child| SelectableCollection {
            id: child.id,
            name: child.name,
            parent_id: child.parent_id,
            level: 1,
            is_selected: selected_ids.contains(&child.id),
        }));
    }
    serde_json::to_value(NativeCollectionMembership {
        game_id,
        collections,
    })
    .map_err(|error| format!("序列化合集归属失败: {error}"))
}

async fn suggest_embedded_name(payload: Option<Value>) -> Result<Value, String> {
    let link = payload
        .as_ref()
        .and_then(|payload| payload.get("link").or_else(|| payload.get("url")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "downloads.suggestEmbeddedName 需要 link".to_string())?;
    let name = link.split('/').last().unwrap_or("download").to_string();
    Ok(json!({ "name": name }))
}

async fn create_embedded_download(
    _db: &DatabaseConnection,
    _payload: Option<Value>,
) -> Result<Value, String> {
    Err("Downloads feature removed".to_string())
}

async fn import_database_from_payload(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let source_path = payload
        .as_ref()
        .and_then(|payload| payload.get("sourcePath").or_else(|| payload.get("path")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "settings.importDatabase 需要 sourcePath".to_string())?;
    let result =
        crate::backup::database::import_database_native(source_path.to_string(), db).await?;
    serde_json::to_value(result).map_err(|error| format!("序列化数据库导入结果失败: {error}"))
}

pub async fn run_native_ipc_service() -> NativeIpcResult<()> {
    let db = db::establish_connection().await?;
    migration::Migrator::up(&db, None).await?;
    match recover_interrupted_tasks(&db).await {
        Ok(task_ids) => resume_pending_tasks_with_host(native_install_host(), &db, task_ids),
        Err(error) => eprintln!("native task recovery failed: {error}"),
    }

    loop {
        let pipe_name = pipe_name();
        let server = ServerOptions::new()
            .pipe_mode(PipeMode::Message)
            .first_pipe_instance(false)
            .create(&pipe_name)?;

        server.connect().await?;
        let db = db.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_client(server, db).await {
                eprintln!("native ipc client failed: {error}");
            }
        });
    }
}

fn pipe_name() -> String {
    let name = std::env::var("SKERRY_NATIVE_PIPE_NAME")
        .ok()
        .filter(|value| !value.trim().is_empty() && !value.contains('\\') && !value.contains('/'))
        .unwrap_or_else(|| DEFAULT_PIPE_NAME.to_string());
    format!(r"\\.\pipe\{name}")
}

async fn handle_client(
    server: tokio::net::windows::named_pipe::NamedPipeServer,
    db: DatabaseConnection,
) -> NativeIpcResult<()> {
    let mut reader = BufReader::new(server);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).await?;

    let response = match serde_json::from_str::<IpcRequest>(&request_line) {
        Ok(request) => dispatch_request(&db, request).await,
        Err(error) => Err(format!("IPC 请求解析失败: {error}")),
    };

    let response = match response {
        Ok(data) => IpcResponse {
            ok: true,
            data: Some(data),
            error: None,
        },
        Err(error) => IpcResponse {
            ok: false,
            data: None,
            error: Some(error),
        },
    };

    let mut server = reader.into_inner();
    let mut response_line = serde_json::to_vec(&response)?;
    response_line.push(b'\n');
    server.write_all(&response_line).await?;
    server.flush().await?;
    Ok(())
}

async fn dispatch_request(db: &DatabaseConnection, request: IpcRequest) -> Result<Value, String> {
    match request.method.as_str() {
        "ping" => Ok(json!({ "pong": true })),
        "appInfo" => Ok(json!({
            "name": "Skerry Native Service",
            "version": env!("CARGO_PKG_VERSION"),
            "pipe": pipe_name()
        })),
        "games.list" => list_games(db, request.payload).await,
        "games.detail" => game_detail(db, request.payload).await,
        "games.create" => create_game(db, request.payload).await,
        "games.update" => update_game_native(db, request.payload).await,
        "games.delete" => delete_game_native(db, request.payload).await,
        "games.scan" => scan_games_native(db, request.payload).await,
        "games.importScanned" => import_scanned_games(db, request.payload).await,
        "games.detectSavePath" => detect_save_paths(db, request.payload).await,
        "games.textFiles" => game_text_files(db, request.payload).await,
        "paths.open" => open_native_path(request.payload).await,
        "collections.overview" => collections_overview(db).await,
        "collections.categories" => collection_categories(db, request.payload).await,
        "collections.developers" => developer_categories(db).await,
        "collections.games" => collection_games(db, request.payload).await,
        "collections.create" => create_collection_native(db, request.payload).await,
        "collections.update" => update_collection_native(db, request.payload).await,
        "collections.delete" => delete_collection_native(db, request.payload).await,
        "collections.addGames" => add_games_to_collections_native(db, request.payload).await,
        "collections.removeGames" => remove_games_from_collection_native(db, request.payload).await,
        "collections.setGameCollections" => set_game_collections_native(db, request.payload).await,
        "collections.membership" => collection_membership(db, request.payload).await,
        "downloads.list" => downloads_list(db).await,
        "downloads.embeddedControl" => embedded_download_control(request.payload).await,
        "downloads.installControl" => install_task_control(db, request.payload).await,
        "downloads.createInstall" => create_native_install_task(db, request.payload).await,
        "downloads.suggestEmbeddedName" => suggest_embedded_name(request.payload).await,
        "downloads.createEmbedded" => create_embedded_download(db, request.payload).await,
        "settings.get" => settings_get(db).await,
        "settings.update" => settings_update(db, request.payload).await,
        "settings.importDatabase" => import_database_from_payload(db, request.payload).await,
        "savedata.records" => savedata_records(db, request.payload).await,
        "savedata.create" => create_savedata_native(db, request.payload).await,
        "savedata.restore" => restore_savedata_native(db, request.payload).await,
        "savedata.delete" => delete_savedata_native(db, request.payload).await,
        "maintenance.backupDatabase" => backup_database_native(db).await,
        "maintenance.backupCovers" => backup_covers_native(db).await,
        "maintenance.backupAll" => backup_all_native(db).await,
        "report.annual" => annual_report(db, request.payload).await,
        "games.launch" => launch_native_game(db, request.payload).await,
        "games.stop" => stop_native_game(request.payload).await,
        "games.runtime" => native_game_runtime(request.payload).await,
        method => Err(format!("未知 IPC 方法: {method}")),
    }
}

async fn create_game(db: &DatabaseConnection, payload: Option<Value>) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "games.create 需要 payload".to_string())?;
    let source = payload
        .get("game")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    let game = if source.get("id_type").is_some() {
        serde_json::from_value::<InsertGameData>(source)
            .map_err(|error| format!("新增游戏参数无效: {error}"))?
    } else {
        let simple = serde_json::from_value::<NativeSimpleGamePayload>(source)
            .map_err(|error| format!("新增游戏参数无效: {error}"))?;
        if simple_custom_data(&simple).is_none()
            && clean_text(simple.local_path.clone()).is_none()
            && clean_text(simple.steam_launch_id.clone()).is_none()
        {
            return Err("games.create 需要标题、游戏目录或 Steam ID".to_string());
        }
        simple_insert_game(simple)
    };
    let inserted = GamesRepository::insert(db, game)
        .await
        .map_err(|error| format!("新增游戏失败: {error}"))?;
    let stats = GameStatsRepository::get_statistics(db, inserted.id)
        .await
        .map_err(|error| format!("读取新增游戏统计失败: {error}"))?;
    serde_json::to_value(to_native_game_detail(&inserted, stats.as_ref(), 0))
        .map_err(|error| format!("序列化新增游戏失败: {error}"))
}

async fn update_game_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "games.update")?;
    let payload = payload.ok_or_else(|| "games.update 需要 payload".to_string())?;
    let updates = if let Some(updates) = payload.get("updates").cloned() {
        serde_json::from_value::<UpdateGameData>(updates)
            .map_err(|error| format!("更新游戏参数无效: {error}"))?
    } else {
        let source = payload
            .get("game")
            .cloned()
            .unwrap_or_else(|| payload.clone());
        let simple = serde_json::from_value::<NativeSimpleGamePayload>(source)
            .map_err(|error| format!("更新游戏参数无效: {error}"))?;
        simple_update_game(db, game_id, simple).await?
    };
    let updated = GamesRepository::update(db, game_id, updates)
        .await
        .map_err(|error| format!("更新游戏失败: {error}"))?;
    let stats = GameStatsRepository::get_statistics(db, updated.id)
        .await
        .map_err(|error| format!("读取更新后游戏统计失败: {error}"))?;
    let savedata_count = GamesRepository::get_savedata_count(db, updated.id)
        .await
        .map_err(|error| format!("读取更新后存档数量失败: {error}"))?;
    serde_json::to_value(to_native_game_detail(
        &updated,
        stats.as_ref(),
        savedata_count,
    ))
    .map_err(|error| format!("序列化更新游戏失败: {error}"))
}

async fn delete_game_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "games.delete")?;
    if native_running_games().lock().await.contains_key(&game_id) {
        let _ = stop_native_game(Some(json!({ "id": game_id }))).await;
    }
    let rows_affected = GamesRepository::delete(db, game_id)
        .await
        .map(|result| result.rows_affected)
        .map_err(|error| format!("删除游戏失败: {error}"))?;
    if rows_affected > 0
        && let Err(error) = crate::game::cover::delete_game_cover_dir(game_id).await
    {
        log::warn!(
            "原生删除游戏后清理封面目录失败 game_id={}: {}",
            game_id,
            error
        );
    }
    Ok(json!({ "id": game_id, "rowsAffected": rows_affected }))
}

async fn scan_games_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "games.scan 需要 payload".to_string())?;
    let path = payload
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "games.scan 需要 path".to_string())?;
    let max_depth = payload
        .get("maxDepth")
        .or_else(|| payload.get("max_depth"))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(4);
    let scan_mode = parse_scan_mode(payload.get("scanMode").or_else(|| payload.get("scan_mode")));
    let results = crate::game::scan::scan_directory_for_games_with_db(
        db,
        path.to_string(),
        max_depth,
        scan_mode,
    )
    .await?;
    serde_json::to_value(results).map_err(|error| format!("序列化扫描结果失败: {error}"))
}

async fn import_scanned_games(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "games.importScanned 需要 payload".to_string())?;
    let items = payload
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "games.importScanned 需要 items 数组".to_string())?;
    let mut games = Vec::with_capacity(items.len());
    for item in items {
        let title = item
            .get("name")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let local_path = item
            .get("path")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let executable = item
            .get("executable")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| {
                item.get("executables")
                    .and_then(Value::as_array)
                    .and_then(|values| values.first())
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            });
        games.push(simple_insert_game(NativeSimpleGamePayload {
            title,
            local_path,
            executable,
            ..Default::default()
        }));
    }
    let result = GamesRepository::insert_batch(db, games).await;
    serde_json::to_value(result).map_err(|error| format!("序列化导入结果失败: {error}"))
}

async fn collection_games(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "collections.games 需要 payload".to_string())?;
    let collection_id = payload_collection_id(&Some(payload.clone()), "collections.games")?;
    let ids = CollectionsRepository::get_games_in_collection(db, collection_id)
        .await
        .map_err(|error| format!("读取集合游戏失败: {error}"))?;
    let games = GamesRepository::find_all(
        db,
        GameType::All,
        SortOption::Namesort,
        SortOrder::Asc,
        Some("zh-CN".to_string()),
    )
    .await
    .map_err(|error| format!("读取集合游戏卡片失败: {error}"))?;
    let stats = GameStatsRepository::get_all_statistics(db)
        .await
        .map_err(|error| format!("读取集合游戏统计失败: {error}"))?;
    let stats_by_id: HashMap<i32, game_statistics::Model> =
        stats.into_iter().map(|stat| (stat.game_id, stat)).collect();
    let mut by_id = games
        .into_iter()
        .map(|game| (game.id, game))
        .collect::<HashMap<_, _>>();
    let cards = ids
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .map(|game| to_native_game_card(&game, stats_by_id.get(&game.id)))
        .collect::<Vec<_>>();
    serde_json::to_value(cards).map_err(|error| format!("序列化集合游戏失败: {error}"))
}

async fn create_collection_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "collections.create 需要 payload".to_string())?;
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "collections.create 需要 name".to_string())?
        .to_string();
    let parent_id = payload
        .get("parentId")
        .or_else(|| payload.get("parent_id"))
        .and_then(|value| value.as_i64())
        .and_then(|value| i32::try_from(value).ok());
    let sort_order = payload
        .get("sortOrder")
        .or_else(|| payload.get("sort_order"))
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .unwrap_or(0);
    let icon = payload
        .get("icon")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let collection = CollectionsRepository::create(
        db,
        InsertCollectionData {
            name,
            parent_id,
            sort_order,
            icon,
        }
        .cleaned(),
    )
    .await
    .map_err(|error| format!("创建集合失败: {error}"))?;
    serde_json::to_value(collection).map_err(|error| format!("序列化集合失败: {error}"))
}

async fn update_collection_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let collection_id = payload_collection_id(&payload, "collections.update")?;
    let payload = payload.ok_or_else(|| "collections.update 需要 payload".to_string())?;
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let parent_id = if payload.get("parentId").is_some() || payload.get("parent_id").is_some() {
        Some(
            payload
                .get("parentId")
                .or_else(|| payload.get("parent_id"))
                .and_then(|value| value.as_i64())
                .and_then(|value| i32::try_from(value).ok()),
        )
    } else {
        None
    };
    let sort_order = payload
        .get("sortOrder")
        .or_else(|| payload.get("sort_order"))
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok());
    let icon = if payload.get("icon").is_some() {
        Some(
            payload
                .get("icon")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        )
    } else {
        None
    };
    let collection = CollectionsRepository::update(
        db,
        collection_id,
        UpdateCollectionData {
            name,
            parent_id,
            sort_order,
            icon,
        }
        .cleaned(),
    )
    .await
    .map_err(|error| format!("更新集合失败: {error}"))?;
    serde_json::to_value(collection).map_err(|error| format!("序列化集合失败: {error}"))
}

async fn delete_collection_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let collection_id = payload_collection_id(&payload, "collections.delete")?;
    let rows_affected = CollectionsRepository::delete(db, collection_id)
        .await
        .map(|result| result.rows_affected)
        .map_err(|error| format!("删除集合失败: {error}"))?;
    Ok(json!({ "id": collection_id, "rowsAffected": rows_affected }))
}

async fn add_games_to_collections_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "collections.addGames 需要 payload".to_string())?;
    let game_ids = payload_i32_list(&payload, "gameIds")?;
    let collection_ids = if payload.get("collectionIds").is_some() {
        payload_i32_list(&payload, "collectionIds")?
    } else {
        vec![payload_collection_id(
            &Some(payload.clone()),
            "collections.addGames",
        )?]
    };
    CollectionsRepository::add_games_to_collections(db, game_ids.clone(), collection_ids.clone())
        .await
        .map_err(|error| format!("添加游戏到集合失败: {error}"))?;
    Ok(json!({ "gameIds": game_ids, "collectionIds": collection_ids }))
}

async fn remove_games_from_collection_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "collections.removeGames 需要 payload".to_string())?;
    let collection_id = payload_collection_id(&Some(payload.clone()), "collections.removeGames")?;
    let game_ids = payload_i32_list(&payload, "gameIds")?;
    let rows_affected =
        CollectionsRepository::remove_games_from_collection(db, game_ids.clone(), collection_id)
            .await
            .map(|result| result.rows_affected)
            .map_err(|error| format!("从集合移除游戏失败: {error}"))?;
    Ok(json!({ "collectionId": collection_id, "gameIds": game_ids, "rowsAffected": rows_affected }))
}

async fn set_game_collections_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload =
        payload.ok_or_else(|| "collections.setGameCollections 需要 payload".to_string())?;
    let game_id = payload_game_id(&Some(payload.clone()), "collections.setGameCollections")?;
    let collection_ids = payload_i32_list(&payload, "collectionIds")?;
    CollectionsRepository::set_game_collections(db, game_id, collection_ids.clone())
        .await
        .map_err(|error| format!("设置游戏集合失败: {error}"))?;
    Ok(json!({ "gameId": game_id, "collectionIds": collection_ids }))
}

fn to_native_savedata_record(
    save_root_path: Option<&str>,
    record: savedata::Model,
) -> Result<NativeSavedataRecord, String> {
    let backup_path = savedata_backup_file_path(save_root_path, record.game_id, &record.file)?;
    Ok(NativeSavedataRecord {
        id: record.id,
        game_id: record.game_id,
        file: record.file,
        backup_time: record.backup_time,
        file_size: record.file_size,
        backup_path: backup_path.to_string_lossy().to_string(),
    })
}

async fn savedata_records(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "savedata.records")?;
    let settings = SettingsRepository::get_all_settings(db)
        .await
        .map_err(|error| format!("读取设置失败: {error}"))?;
    let records = GamesRepository::get_savedata_records(db, game_id)
        .await
        .map_err(|error| format!("读取存档记录失败: {error}"))?;
    let native_records = records
        .into_iter()
        .map(|record| to_native_savedata_record(settings.save_root_path.as_deref(), record))
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::to_value(native_records).map_err(|error| format!("序列化存档记录失败: {error}"))
}

async fn create_savedata_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let game_id = payload_game_id(&payload, "savedata.create")?;
    let payload = payload.ok_or_else(|| "savedata.create 需要 payload".to_string())?;
    let source_path = payload
        .get("sourcePath")
        .or_else(|| payload.get("source_path"))
        .or_else(|| payload.get("savePath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "savedata.create 需要 sourcePath".to_string())?;
    let info = crate::backup::savedata::create_savedata_backup_with_db(
        db,
        i64::from(game_id),
        source_path.to_string(),
    )
    .await?;
    let backup_time =
        i32::try_from(info.backup_time).map_err(|_| "存档备份时间超出数据库范围".to_string())?;
    let file_size =
        i32::try_from(info.file_size).map_err(|_| "存档备份文件过大，超过记录范围".to_string())?;
    let id = GamesRepository::save_savedata_record(
        db,
        game_id,
        &info.folder_name,
        backup_time,
        file_size,
    )
    .await
    .map_err(|error| format!("保存存档记录失败: {error}"))?;
    let record = NativeSavedataRecord {
        id,
        game_id,
        file: info.folder_name,
        backup_time,
        file_size,
        backup_path: info.backup_path,
    };
    serde_json::to_value(record).map_err(|error| format!("序列化新存档记录失败: {error}"))
}

async fn restore_savedata_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "savedata.restore 需要 payload".to_string())?;
    let game_id = payload
        .get("gameId")
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.parse::<i64>().ok())
        })
        .and_then(|value| i32::try_from(value).ok());
    let backup_id = payload
        .get("backupId")
        .or_else(|| payload.get("id"))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.parse::<i64>().ok())
        })
        .and_then(|value| i32::try_from(value).ok());
    let backup_path = if let Some(path) = payload
        .get("backupFilePath")
        .or_else(|| payload.get("backupPath"))
        .or_else(|| payload.get("backup_file_path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        path.to_string()
    } else {
        let backup_id = backup_id
            .ok_or_else(|| "savedata.restore 需要 backupId 或 backupFilePath".to_string())?;
        let record = GamesRepository::get_savedata_record_by_id(db, backup_id)
            .await
            .map_err(|error| format!("读取备份记录失败: {error}"))?
            .ok_or_else(|| "备份记录不存在".to_string())?;
        let settings = SettingsRepository::get_all_settings(db)
            .await
            .map_err(|error| format!("读取设置失败: {error}"))?;
        savedata_backup_file_path(
            settings.save_root_path.as_deref(),
            record.game_id,
            &record.file,
        )?
        .to_string_lossy()
        .to_string()
    };
    let target_path = if let Some(path) = payload
        .get("targetPath")
        .or_else(|| payload.get("savePath"))
        .or_else(|| payload.get("target_path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        path.to_string()
    } else {
        let game_id = game_id.ok_or_else(|| {
            "savedata.restore 需要 targetPath，或提供 gameId 以使用游戏存档目录".to_string()
        })?;
        GamesRepository::find_by_id(db, game_id)
            .await
            .map_err(|error| format!("读取游戏失败: {error}"))?
            .and_then(|game| game.savepath)
            .filter(|path| !path.trim().is_empty())
            .ok_or_else(|| "游戏未设置存档目录".to_string())?
    };
    crate::backup::savedata::restore_savedata_backup(backup_path.clone(), target_path.clone())
        .await?;
    Ok(json!({ "backupPath": backup_path, "targetPath": target_path, "restored": true }))
}

async fn delete_savedata_native(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let backup_id = payload
        .as_ref()
        .and_then(|payload| payload.get("backupId").or_else(|| payload.get("id")))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.parse::<i64>().ok())
        })
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| "savedata.delete 需要 backupId".to_string())?;
    crate::backup::savedata::delete_savedata_backup_with_db(db, backup_id).await?;
    Ok(json!({ "id": backup_id, "deleted": true }))
}

async fn backup_database_native(db: &DatabaseConnection) -> Result<Value, String> {
    let result = crate::backup::database::backup_database_file(db).await?;
    serde_json::to_value(result).map_err(|error| format!("序列化数据库备份结果失败: {error}"))
}

async fn backup_covers_native(db: &DatabaseConnection) -> Result<Value, String> {
    let result = crate::backup::covers::backup_custom_covers_archive(db, false).await?;
    serde_json::to_value(result).map_err(|error| format!("序列化封面备份结果失败: {error}"))
}

async fn backup_all_native(db: &DatabaseConnection) -> Result<Value, String> {
    let database: BackupResult = crate::backup::database::backup_database_file(db).await?;
    let covers: BackupResult =
        crate::backup::covers::backup_custom_covers_archive(db, false).await?;
    Ok(json!({ "database": database, "covers": covers }))
}

async fn annual_report(db: &DatabaseConnection, payload: Option<Value>) -> Result<Value, String> {
    let requested_year = payload
        .as_ref()
        .and_then(|payload| payload.get("year"))
        .and_then(Value::as_i64)
        .and_then(|year| i32::try_from(year).ok());
    let current_year = chrono::Local::now().year();
    let selected_year = requested_year.unwrap_or(current_year);

    let stats = GameStatsRepository::get_all_statistics(db)
        .await
        .map_err(|error| format!("读取年度统计失败: {error}"))?;
    let games = GamesRepository::find_all(
        db,
        GameType::All,
        SortOption::Namesort,
        SortOrder::Asc,
        Some("zh-CN".to_string()),
    )
    .await
    .map_err(|error| format!("读取年度游戏信息失败: {error}"))?;
    let games_by_id = games
        .into_iter()
        .map(|game| (game.id, game))
        .collect::<HashMap<_, _>>();

    let mut years = BTreeSet::from([current_year]);
    let mut monthly_minutes = vec![0; 12];
    let mut weekday_minutes = vec![0; 7];
    let mut active_dates = BTreeSet::<String>::new();
    let mut game_minutes = HashMap::<i32, i32>::new();
    let mut games_played = 0usize;
    let mut total_minutes = 0;

    for stat in &stats {
        let daily_stats = parse_daily_stats_json(stat.daily_stats.as_deref());
        let mut minutes_for_game = 0;
        for (date_text, playtime) in daily_stats {
            if playtime <= 0 {
                continue;
            }
            let Ok(date) = NaiveDate::parse_from_str(&date_text, "%Y-%m-%d") else {
                continue;
            };
            years.insert(date.year());
            if date.year() != selected_year {
                continue;
            }

            let month_index = date.month0() as usize;
            let weekday_index = date.weekday().num_days_from_sunday() as usize;
            monthly_minutes[month_index] += playtime;
            weekday_minutes[weekday_index] += playtime;
            active_dates.insert(date_text);
            minutes_for_game += playtime;
            total_minutes += playtime;
        }

        if minutes_for_game > 0 {
            game_minutes.insert(stat.game_id, minutes_for_game);
            games_played += 1;
        }
    }

    let mut years = years.into_iter().collect::<Vec<_>>();
    years.sort_by(|left, right| right.cmp(left));

    let mut top_games = game_minutes
        .into_iter()
        .filter_map(|(game_id, minutes)| {
            games_by_id.get(&game_id).map(|game| NativeReportTopGame {
                id: game_id.to_string(),
                title: resolve_display_fields(game, None).title,
                minutes,
            })
        })
        .collect::<Vec<_>>();
    top_games.sort_by(|left, right| right.minutes.cmp(&left.minutes));
    top_games.truncate(8);

    let report = NativeAnnualReport {
        years,
        selected_year,
        total_minutes,
        games_played,
        active_days: active_dates.len(),
        longest_streak: longest_streak(&active_dates),
        monthly_minutes,
        weekday_minutes,
        top_games,
    };

    serde_json::to_value(report).map_err(|error| format!("序列化年度报告失败: {error}"))
}

fn parse_daily_stats_json(daily_stats: Option<&str>) -> Vec<(String, i32)> {
    let Some(daily_stats) = daily_stats else {
        return Vec::new();
    };
    let Ok(Value::Array(records)) = serde_json::from_str::<Value>(daily_stats) else {
        return Vec::new();
    };

    records
        .into_iter()
        .filter_map(|record| {
            let date = record.get("date")?.as_str()?.to_string();
            let playtime = record
                .get("playtime")?
                .as_i64()
                .and_then(|value| i32::try_from(value).ok())?;
            Some((date, playtime))
        })
        .collect()
}

fn longest_streak(active_dates: &BTreeSet<String>) -> usize {
    let mut longest = 0;
    let mut current = 0;
    let mut previous: Option<NaiveDate> = None;
    for date in active_dates
        .iter()
        .filter_map(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
    {
        current = if previous
            .is_some_and(|previous| date.signed_duration_since(previous).num_days() == 1)
        {
            current + 1
        } else {
            1
        };
        longest = longest.max(current);
        previous = Some(date);
    }

    longest
}

async fn settings_get(db: &DatabaseConnection) -> Result<Value, String> {
    let settings = SettingsRepository::get_all_settings(db)
        .await
        .map_err(|error| format!("读取设置失败: {error}"))?;
    let bgm_signed_in = settings
        .bgm_auth
        .as_ref()
        .is_some_and(|auth| !auth.access_token.is_empty());
    let hikarinagi_signed_in = settings
        .hikarinagi_auth
        .as_ref()
        .is_some_and(|auth| !auth.access_token.is_empty());
    let native_settings = NativeSettings {
        save_root_path: settings.save_root_path,
        db_backup_path: settings.db_backup_path,
        install_root_path: settings.install_root_path,
        le_path: settings.le_path,
        magpie_path: settings.magpie_path,
        detail_backdrop_path: settings.detail_backdrop_path,
        bgm_display_name: settings
            .bgm_auth
            .as_ref()
            .and_then(|auth| auth.nickname.clone().or_else(|| auth.username.clone())),
        bgm_signed_in,
        hikarinagi_display_name: settings
            .hikarinagi_auth
            .as_ref()
            .and_then(|auth| auth.name.clone()),
        hikarinagi_signed_in,
        vndb_token_configured: settings
            .vndb_token
            .as_ref()
            .is_some_and(|token| !token.trim().is_empty()),
    };

    serde_json::to_value(native_settings).map_err(|error| format!("序列化设置失败: {error}"))
}

async fn settings_update(db: &DatabaseConnection, payload: Option<Value>) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "settings.update 需要 payload".to_string())?;
    let data: UpdateSettingsData =
        serde_json::from_value(payload).map_err(|error| format!("设置参数无效: {error}"))?;
    SettingsRepository::update_settings(db, data)
        .await
        .map_err(|error| format!("保存设置失败: {error}"))?;
    settings_get(db).await
}

async fn downloads_list(db: &DatabaseConnection) -> Result<Value, String> {
    let embedded: Vec<serde_json::Value> = Vec::new();
    let install_tasks = crate::entity::tasks::Entity::find()
        .order_by_desc(crate::entity::tasks::Column::CreatedAt)
        .all(db)
        .await
        .map_err(|error| format!("读取安装任务失败: {error}"))?
        .into_iter()
        .map(|task| NativeInstallTask {
            id: task.id,
            task_type: task.task_type,
            title: task.title,
            status: task.status,
            stage: task.stage,
            progress_current: task.progress_current,
            progress_total: task.progress_total,
            progress_unit: task.progress_unit,
            error_message: task.error_message,
            created_at: task.created_at,
            updated_at: task.updated_at,
        })
        .collect::<Vec<_>>();

    serde_json::to_value(NativeDownloadsSnapshot {
        embedded: serde_json::to_value(embedded)
            .map_err(|error| format!("序列化内置下载队列失败: {error}"))?,
        install_tasks,
    })
    .map_err(|error| format!("序列化下载队列失败: {error}"))
}

async fn create_native_install_task(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload.ok_or_else(|| "downloads.createInstall 需要 payload".to_string())?;
    let request_value = payload
        .get("request")
        .cloned()
        .ok_or_else(|| "downloads.createInstall 需要 request".to_string())?;
    let request: InstallRequest = serde_json::from_value::<InstallRequest>(request_value)
        .map_err(|error| format!("安装请求无效: {error}"))?
        .validate()?;
    let install_root = payload
        .get("installRoot")
        .and_then(Value::as_str)
        .ok_or_else(|| "downloads.createInstall 需要 installRoot".to_string())?;
    let install_root = crate::utils::fs::normalize_install_root_path(install_root)?;
    let payload = GameInstallTaskPayloadV1::new(request.clone(), &install_root);
    let dedupe_key = format!("game_install:{}:{}", request.provider, request.resource_id);
    if tasks::Entity::find()
        .filter(tasks::Column::DedupeKey.eq(&dedupe_key))
        .filter(tasks::Column::Status.is_in(ACTIVE_TASK_STATUSES.iter().copied()))
        .one(db)
        .await
        .map_err(|error| format!("检查重复任务失败: {error}"))?
        .is_some()
    {
        return Err("该资源已有进行中的安装任务".to_string());
    }

    let now = chrono::Utc::now().timestamp();
    let task = tasks::ActiveModel {
        id: NotSet,
        task_type: Set("game_install".to_string()),
        title: Set(request.title.clone()),
        status: Set("pending".to_string()),
        stage: Set(None),
        payload_json: Set(serde_json::to_value(&payload)
            .map_err(|error| format!("序列化安装请求失败: {error}"))?),
        result_json: Set(None),
        progress_current: Set(0),
        progress_total: Set(Some(request.size as i64)),
        progress_unit: Set(Some("bytes".to_string())),
        dedupe_key: Set(Some(dedupe_key)),
        error_code: Set(None),
        error_message: Set(None),
        created_at: Set(now),
        started_at: Set(None),
        updated_at: Set(now),
        finished_at: Set(None),
    }
    .insert(db)
    .await
    .map_err(|error| format!("创建安装任务失败: {error}"))?;
    spawn_task_with_host(native_install_host(), db.clone(), task.id)?;
    serde_json::to_value(task).map_err(|error| format!("序列化安装任务失败: {error}"))
}

async fn install_task_control(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let task_id = payload_task_id(&payload, "downloads.installControl")?;
    let action = payload
        .as_ref()
        .and_then(|payload| payload.get("action"))
        .and_then(Value::as_str)
        .ok_or_else(|| "downloads.installControl 需要 action".to_string())?;
    match action {
        "pause" => pause_native_task(db, task_id).await,
        "resume" => resume_native_task(db, task_id).await,
        "cancel" => cancel_native_task(db, task_id).await,
        "delete" => {
            delete_native_task(db, task_id).await?;
            Ok(json!({ "deleted": true, "id": task_id }))
        }
        "retry" => retry_native_task(db, task_id).await,
        other => Err(format!("不支持的安装任务操作: {other}")),
    }
}

async fn pause_native_task(db: &DatabaseConnection, task_id: i64) -> Result<Value, String> {
    let task = find_task(db, task_id).await?;
    if task.status == "paused" {
        return serde_json::to_value(task).map_err(|error| format!("序列化任务失败: {error}"));
    }
    if task.task_type != "game_install"
        || task.status != "running"
        || task.stage.as_deref() != Some("downloading")
    {
        return Err("只有正在下载的任务可以暂停".to_string());
    }
    let completion = native_task_runtime()
        .pause(task_id)
        .ok_or_else(|| "下载任务当前不在运行".to_string())?;
    wait_for_task_completion(completion).await;
    let task = find_task(db, task_id).await?;
    serde_json::to_value(task).map_err(|error| format!("序列化任务失败: {error}"))
}

async fn resume_native_task(db: &DatabaseConnection, task_id: i64) -> Result<Value, String> {
    let task = find_task(db, task_id).await?;
    if task.task_type != "game_install"
        || task.status != "paused"
        || task.stage.as_deref() != Some("downloading")
    {
        return Err("只有已暂停的下载任务可以继续".to_string());
    }
    let mut active = task.into_active_model();
    active.status = Set("pending".to_string());
    active.error_code = Set(None);
    active.error_message = Set(None);
    active.updated_at = Set(chrono::Utc::now().timestamp());
    active.finished_at = Set(None);
    let task = active
        .update(db)
        .await
        .map_err(|error| format!("恢复下载任务失败: {error}"))?;
    spawn_task_with_host(native_install_host(), db.clone(), task.id)?;
    serde_json::to_value(task).map_err(|error| format!("序列化任务失败: {error}"))
}

async fn cancel_native_task(db: &DatabaseConnection, task_id: i64) -> Result<Value, String> {
    let task = find_task(db, task_id).await?;
    if matches!(task.status.as_str(), "completed" | "failed" | "cancelled") {
        return serde_json::to_value(task).map_err(|error| format!("序列化任务失败: {error}"));
    }
    if let Some(completion) = native_task_runtime().cancel(task_id) {
        wait_for_task_completion(completion).await;
    }
    let task = find_task(db, task_id).await?;
    let task = if matches!(task.status.as_str(), "completed" | "failed" | "cancelled") {
        task
    } else {
        set_task_cancelled(db, task_id)
            .await
            .map_err(|failure| failure.message)?
    };
    serde_json::to_value(task).map_err(|error| format!("序列化任务失败: {error}"))
}

async fn delete_native_task(db: &DatabaseConnection, task_id: i64) -> Result<(), String> {
    let task = find_task(db, task_id).await?;
    if !matches!(task.status.as_str(), "failed" | "completed" | "cancelled") {
        return Err("只有失败、已完成或已取消的任务可以删除".to_string());
    }
    if let Some(completion) = native_task_runtime().completion(task_id) {
        wait_for_task_completion(completion).await;
    }
    let task = find_task(db, task_id).await?;
    let payload: GameInstallTaskPayloadV1 = serde_json::from_value(task.payload_json.clone())
        .map_err(|error| format!("任务载荷无效: {error}"))?;
    remove_task_artifacts(&payload, task_id)
        .await
        .map_err(|failure| failure.message)?;
    tasks::Entity::delete_by_id(task_id)
        .exec(db)
        .await
        .map_err(|error| format!("删除任务失败: {error}"))?;
    Ok(())
}

async fn retry_native_task(db: &DatabaseConnection, task_id: i64) -> Result<Value, String> {
    let task = find_task(db, task_id).await?;
    if task.task_type != "game_install" || !matches!(task.status.as_str(), "failed" | "cancelled") {
        return Err("只有失败或已取消的安装任务可以重试".to_string());
    }
    let mut active = task.into_active_model();
    active.status = Set("pending".to_string());
    active.stage = Set(None);
    active.error_code = Set(None);
    active.error_message = Set(None);
    active.started_at = Set(None);
    active.updated_at = Set(chrono::Utc::now().timestamp());
    active.finished_at = Set(None);
    let task = active
        .update(db)
        .await
        .map_err(|error| format!("重试安装任务失败: {error}"))?;
    spawn_task_with_host(native_install_host(), db.clone(), task.id)?;
    serde_json::to_value(task).map_err(|error| format!("序列化任务失败: {error}"))
}

async fn embedded_download_control(_payload: Option<Value>) -> Result<Value, String> {
    Err("Downloads feature removed".to_string())
}

async fn collections_overview(db: &DatabaseConnection) -> Result<Value, String> {
    let groups = CollectionsRepository::get_root_collections_with_count(db, None)
        .await
        .map_err(|error| format!("读取收藏夹分组失败: {error}"))?;
    let game_count = GamesRepository::count(db)
        .await
        .map_err(|error| format!("读取游戏数量失败: {error}"))?;

    let mut native_groups = Vec::with_capacity(groups.len() + 1);
    native_groups.push(NativeCollectionGroup {
        id: "default_developer".to_string(),
        name: "开发商".to_string(),
        game_count,
        is_virtual: true,
        icon: Some("developer".to_string()),
    });
    native_groups.extend(groups.into_iter().map(|group| NativeCollectionGroup {
        id: group.id.to_string(),
        name: group.name,
        game_count: group.game_count,
        is_virtual: false,
        icon: group.icon,
    }));

    serde_json::to_value(native_groups).map_err(|error| format!("序列化收藏夹分组失败: {error}"))
}

async fn collection_categories(
    db: &DatabaseConnection,
    payload: Option<Value>,
) -> Result<Value, String> {
    let group_id = payload
        .as_ref()
        .and_then(|payload| payload.get("groupId"))
        .and_then(Value::as_i64)
        .and_then(|id| i32::try_from(id).ok())
        .ok_or_else(|| "collections.categories 需要有效 groupId".to_string())?;

    let categories = CollectionsRepository::get_categories_with_count(db, group_id, None)
        .await
        .map_err(|error| format!("读取收藏夹分类失败: {error}"))?;
    let native_categories = categories
        .into_iter()
        .map(|category| NativeCollectionCategory {
            id: category.id.to_string(),
            name: category.name,
            game_count: category.game_count,
            is_virtual: false,
        })
        .collect::<Vec<_>>();

    serde_json::to_value(native_categories)
        .map_err(|error| format!("序列化收藏夹分类失败: {error}"))
}

async fn developer_categories(db: &DatabaseConnection) -> Result<Value, String> {
    let games = GamesRepository::find_all(
        db,
        GameType::All,
        SortOption::Namesort,
        SortOrder::Asc,
        Some("zh-CN".to_string()),
    )
    .await
    .map_err(|error| format!("读取开发商分类失败: {error}"))?;
    let counts = games
        .iter()
        .fold(BTreeMap::<String, u64>::new(), |mut counts, game| {
            let custom_developer = game
                .custom_data
                .as_ref()
                .and_then(|custom| custom.developer.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            let source_developer = if custom_developer.is_none() {
                let source_data = source_data_by_key(game);
                first_source_string(&source_data, &DEVELOPER_SOURCE_PRIORITY, "developer")
            } else {
                None
            };
            let name = custom_developer
                .or(source_developer)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "未知开发商".to_string());
            *counts.entry(name).or_default() += 1;
            counts
        });
    let categories = counts
        .into_iter()
        .map(|(name, game_count)| NativeCollectionCategory {
            id: format!("developer:{name}"),
            name,
            game_count,
            is_virtual: true,
        })
        .collect::<Vec<_>>();

    serde_json::to_value(categories).map_err(|error| format!("序列化开发商分类失败: {error}"))
}

async fn list_games(db: &DatabaseConnection, payload: Option<Value>) -> Result<Value, String> {
    let limit = payload
        .as_ref()
        .and_then(|payload| payload.get("limit"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let query = payload
        .as_ref()
        .and_then(|payload| payload.get("query"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(|query| query.to_lowercase());

    let games = GamesRepository::find_all(
        db,
        GameType::All,
        SortOption::Addtime,
        SortOrder::Desc,
        Some("zh-CN".to_string()),
    )
    .await
    .map_err(|error| format!("读取游戏列表失败: {error}"))?;

    let stats = GameStatsRepository::get_all_statistics(db)
        .await
        .map_err(|error| format!("读取游戏统计失败: {error}"))?;
    let stats_by_id: HashMap<i32, game_statistics::Model> =
        stats.into_iter().map(|stat| (stat.game_id, stat)).collect();

    let cards = games
        .into_iter()
        .filter(|game| {
            let Some(query) = query.as_deref() else {
                return true;
            };
            let display = resolve_display_fields(game, stats_by_id.get(&game.id));
            display.title.to_lowercase().contains(query)
                || display.developer.to_lowercase().contains(query)
                || display.status.to_lowercase().contains(query)
        })
        .take(if limit == 0 { usize::MAX } else { limit })
        .map(|game| {
            let game_id = game.id;
            to_native_game_card(&game, stats_by_id.get(&game_id))
        })
        .collect::<Vec<_>>();

    serde_json::to_value(cards).map_err(|error| format!("序列化游戏列表失败: {error}"))
}

async fn game_detail(db: &DatabaseConnection, payload: Option<Value>) -> Result<Value, String> {
    let game_id = payload
        .as_ref()
        .and_then(|payload| payload.get("id"))
        .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse::<i64>().ok()))
        .and_then(|id| i32::try_from(id).ok())
        .ok_or_else(|| "games.detail 需要有效 id".to_string())?;

    let game = GamesRepository::find_by_id(db, game_id)
        .await
        .map_err(|error| format!("读取游戏详情失败: {error}"))?
        .ok_or_else(|| format!("找不到游戏: {game_id}"))?;
    let stats = GameStatsRepository::get_statistics(db, game_id)
        .await
        .map_err(|error| format!("读取游戏统计失败: {error}"))?;
    let savedata_count = GamesRepository::get_savedata_count(db, game_id)
        .await
        .map_err(|error| format!("读取存档数量失败: {error}"))?;

    serde_json::to_value(to_native_game_detail(&game, stats.as_ref(), savedata_count))
        .map_err(|error| format!("序列化游戏详情失败: {error}"))
}

fn to_native_game_card(
    game: &FullGameData,
    stats: Option<&game_statistics::Model>,
) -> NativeGameCard {
    let display = resolve_display_fields(game, stats);

    NativeGameCard {
        id: game.id.to_string(),
        title: display.title,
        developer: display.developer,
        status: display.status,
        accent_index: game.id.rem_euclid(6),
        play_hours: display.play_hours,
        last_played: stats.and_then(|stats| stats.last_played),
        cover_key: display.cover_key,
        banner_key: display.banner_key,
        image_uri: display.image_uri,
        banner_uri: display.banner_uri,
    }
}

fn to_native_game_detail(
    game: &FullGameData,
    stats: Option<&game_statistics::Model>,
    savedata_count: u64,
) -> NativeGameDetail {
    let source_data = source_data_by_key(game);
    let display = resolve_display_fields(game, stats);
    let summary = first_non_empty([
        game.custom_data
            .as_ref()
            .and_then(|custom| custom.summary.as_deref()),
        first_source_string(
            &source_data,
            &["hikarinagi", "ymgal", "bgm", "kun", "vndb", "dlsite"],
            "summary",
        )
        .as_deref(),
        first_source_string(
            &source_data,
            &["hikarinagi", "ymgal", "bgm", "kun", "vndb", "dlsite"],
            "description",
        )
        .as_deref(),
    ])
    .unwrap_or_else(|| "暂无简介".to_string());
    let tags = game
        .custom_data
        .as_ref()
        .and_then(|custom| custom.tags.clone())
        .filter(|tags| !tags.is_empty())
        .unwrap_or_else(|| {
            merge_source_string_arrays(&source_data, &SOURCE_COVER_PRIORITY, "tags")
        });

    NativeGameDetail {
        id: game.id.to_string(),
        title: display.title,
        developer: display.developer,
        status: display.status,
        play_hours: display.play_hours,
        date: game.date.clone(),
        summary,
        tags: tags.into_iter().take(12).collect(),
        local_path: game.localpath.clone(),
        executable: game.executable.clone(),
        launch_type: game.launch_type.clone(),
        steam_launch_id: game.steam_launch_id.clone(),
        save_path: game.savepath.clone(),
        autosave: game.autosave,
        max_backups: game.maxbackups,
        session_count: stats
            .and_then(|stats| stats.session_count)
            .unwrap_or_default(),
        savedata_count,
        last_played: stats.and_then(|stats| stats.last_played),
        image_uri: display.image_uri,
        banner_uri: display.banner_uri,
    }
}

struct NativeDisplayFields {
    title: String,
    developer: String,
    status: String,
    play_hours: f64,
    cover_key: Option<String>,
    banner_key: Option<String>,
    image_uri: Option<String>,
    banner_uri: Option<String>,
}

fn resolve_display_fields(
    game: &FullGameData,
    stats: Option<&game_statistics::Model>,
) -> NativeDisplayFields {
    let source_data = source_data_by_key(game);
    let source_name_cn = first_source_string(&source_data, &DISPLAY_SOURCE_PRIORITY, "name_cn");
    let source_name = first_source_string(&source_data, &DISPLAY_SOURCE_PRIORITY, "name");
    let source_developer =
        first_source_string(&source_data, &DEVELOPER_SOURCE_PRIORITY, "developer");
    let source_image_uri = first_source_string(&source_data, &SOURCE_COVER_PRIORITY, "image");
    let custom_cover_key = game
        .custom_data
        .as_ref()
        .and_then(|custom| custom.image.clone());
    let banner_key = game
        .custom_data
        .as_ref()
        .and_then(|custom| custom.banner.clone());
    let custom_cover_uri = custom_cover_key
        .as_deref()
        .and_then(|key| local_cover_uri(game.id, "cover", key));
    let local_banner_uri = banner_key
        .as_deref()
        .and_then(|key| local_cover_uri(game.id, "banner", key));
    let cached_cover_uri = cached_cloud_cover_uri(game.id);
    let title = first_non_empty([
        game.custom_data
            .as_ref()
            .and_then(|custom| custom.name_cn.as_deref()),
        game.custom_data
            .as_ref()
            .and_then(|custom| custom.name.as_deref()),
        source_name_cn.as_deref(),
        source_name.as_deref(),
    ])
    .unwrap_or_else(|| format!("Game {}", game.id));
    let developer = first_non_empty([
        game.custom_data
            .as_ref()
            .and_then(|custom| custom.developer.as_deref()),
        source_developer.as_deref(),
    ])
    .unwrap_or_else(|| "未知开发商".to_string());
    let play_minutes = stats.and_then(|stats| stats.total_time).unwrap_or_default();
    let play_hours = ((play_minutes as f64 / 60.0) * 10.0).round() / 10.0;
    let status = if play_minutes > 0 {
        "游玩中"
    } else if game.localpath.is_some() || game.steam_launch_id.is_some() {
        "未开始"
    } else {
        "心愿"
    };

    NativeDisplayFields {
        title,
        developer,
        status: status.to_string(),
        play_hours,
        cover_key: custom_cover_key,
        banner_key,
        image_uri: custom_cover_uri
            .or(cached_cover_uri)
            .or(source_image_uri)
            .or_else(|| local_banner_uri.clone()),
        banner_uri: local_banner_uri,
    }
}

fn local_cover_uri(game_id: i32, kind: &str, key: &str) -> Option<String> {
    let path = reina_path::get_base_data_dir()
        .ok()?
        .join("covers")
        .join(format!("game_{game_id}"))
        .join(format!("{kind}_{game_id}_{key}"));
    file_uri_if_exists(&path)
}

fn cached_cloud_cover_uri(game_id: i32) -> Option<String> {
    let game_dir = reina_path::get_base_data_dir()
        .ok()?
        .join("covers")
        .join(format!("game_{game_id}"));
    for ext in CLOUD_COVER_EXTENSIONS {
        let path = game_dir.join(format!("cloud_cover_{game_id}.{ext}"));
        if let Some(uri) = file_uri_if_exists(&path) {
            return Some(uri);
        }
    }

    std::fs::read_dir(game_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find_map(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .filter(|name| {
                    name.starts_with(&format!("cloud_cover_{game_id}.")) && !name.contains(".part.")
                })
                .and_then(|_| file_uri_if_exists(&path))
        })
}

fn file_uri_if_exists(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }

    url::Url::from_file_path(PathBuf::from(path))
        .ok()
        .map(|url| url.to_string())
}

fn source_data_by_key(game: &FullGameData) -> HashMap<String, Value> {
    game.sources
        .iter()
        .filter_map(|source| {
            source
                .data
                .as_ref()
                .map(|data| (source.source.to_ascii_lowercase(), data.clone()))
        })
        .collect()
}

fn first_source_string(
    source_data: &HashMap<String, Value>,
    priority: &[&str],
    field: &str,
) -> Option<String> {
    priority.iter().find_map(|source| {
        source_data
            .get(*source)
            .and_then(|data| data.get(field))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn merge_source_string_arrays(
    source_data: &HashMap<String, Value>,
    priority: &[&str],
    field: &str,
) -> Vec<String> {
    let mut values = Vec::new();
    for source in priority {
        let Some(array) = source_data
            .get(*source)
            .and_then(|data| data.get(field))
            .and_then(Value::as_array)
        else {
            continue;
        };

        for item in array {
            let Some(value) = item
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if !values.iter().any(|existing| existing == value) {
                values.push(value.to_string());
            }
        }
    }

    values
}

fn first_non_empty<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
