use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sea_orm::{DatabaseConnection, EntityTrait};
use tauri::Manager;
use tauri::command;
use tauri::http::StatusCode;
use tokio::sync::{Notify, RwLock, Semaphore, watch};

use super::thumbnail::{local_cover_path, parse_card_width, read_cover_file};
use crate::database::repository::to_database_game_id;
use crate::entity::prelude::Games;
use crate::utils::image::{
    content_type_for_extension, content_type_for_file, infer_image_extension, make_image_response,
    make_status_response,
};
use skerry_path::get_base_data_dir;

const DEFAULT_COVER_EXTENSION: &str = "jpg";
const DEFAULT_CLOUD_COVER_FILE_NAME: &str = "cloud_cover";
const MAX_CONCURRENT_COVER_DOWNLOADS: usize = 100;
/// 可重试失败后的等待间隔；表项数量就是可重试次数
const COVER_RETRY_DELAYS: &[Duration] = &[Duration::from_millis(500), Duration::from_millis(1000)];

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct DownloadKey {
    game_id: i64,
    generation: u64,
    url_hash: u64,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct CoverCacheKey {
    game_id: i64,
    url_hash: u64,
}

/// 正在下载中的任务表：key=(game_id, generation)，value=watch sender（false=进行中，true=已结束）
type DownloadingMap = Arc<Mutex<HashMap<DownloadKey, Arc<watch::Sender<bool>>>>>;
type CacheMutationLocks = Arc<Mutex<HashMap<i64, Weak<tokio::sync::Mutex<()>>>>>;

pub struct DownloadState {
    semaphore: Arc<Semaphore>,
    /// 每个游戏最近命中的来源 URL 对应的磁盘缓存路径；文件本身仍是缓存事实。
    cached_cover_paths: Arc<RwLock<HashMap<CoverCacheKey, PathBuf>>>,
    /// 缓存代数：删缓存时递增，使旧下载任务失去写盘资格
    cache_generations: Arc<RwLock<HashMap<i64, u64>>>,
    /// 代数变化时唤醒退避中的请求，避免失效任务继续空等。
    generation_changed: Notify,
    /// 删除墓碑：记录已删除游戏，阻止下载任务继续写入封面
    tombstoned_ids: Arc<RwLock<HashSet<i64>>>,
    /// 正在下载中的任务；同 game_id + generation 的后续请求订阅 watch channel 等待其完成
    downloading: DownloadingMap,
    /// 按游戏串行化缓存发布与失效，避免旧下载越过清理重新发布文件。
    cache_mutation_locks: CacheMutationLocks,
}

impl DownloadState {
    pub async fn mark_game_deleted(&self, game_id: i64) {
        self.apply_game_presence(game_id, false).await;
    }

    async fn apply_game_presence(&self, game_id: i64, exists: bool) {
        if exists && !self.is_game_deleted_marked(game_id).await {
            return;
        }

        let mutation_lock = self.cache_mutation_lock(game_id);
        let _guard = mutation_lock.lock().await;

        let changed = {
            let mut tombstoned_ids = self.tombstoned_ids.write().await;
            if exists {
                tombstoned_ids.remove(&game_id)
            } else {
                tombstoned_ids.insert(game_id)
            }
        };

        if !changed || exists {
            return;
        }

        self.bump_cache_generation(game_id).await;
        self.forget_game_cover_paths(game_id).await;
    }

    fn cache_mutation_lock(&self, game_id: i64) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .cache_mutation_locks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        locks.retain(|_, lock| lock.strong_count() > 0);

        if let Some(lock) = locks.get(&game_id).and_then(Weak::upgrade) {
            return lock;
        }

        let lock = Arc::new(tokio::sync::Mutex::new(()));
        locks.insert(game_id, Arc::downgrade(&lock));
        lock
    }

    async fn cache_generation(&self, game_id: i64) -> u64 {
        self.cache_generations
            .read()
            .await
            .get(&game_id)
            .copied()
            .unwrap_or(0)
    }

    async fn bump_cache_generation(&self, game_id: i64) -> u64 {
        let mut generations = self.cache_generations.write().await;
        let generation = generations.entry(game_id).or_insert(0);
        *generation = generation.saturating_add(1);
        let new_generation = *generation;
        drop(generations);
        self.generation_changed.notify_waiters();
        new_generation
    }

    async fn is_cache_generation_current(&self, game_id: i64, generation: u64) -> bool {
        self.cache_generation(game_id).await == generation
    }

    async fn wait_for_retry_or_generation_change(
        &self,
        game_id: i64,
        generation: u64,
        delay: Duration,
    ) -> bool {
        let deadline = tokio::time::Instant::now() + delay;
        loop {
            let generation_changed = self.generation_changed.notified();
            tokio::pin!(generation_changed);
            generation_changed.as_mut().enable();

            if !self.is_cache_generation_current(game_id, generation).await {
                return false;
            }

            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return self.is_cache_generation_current(game_id, generation).await;
            }

            tokio::select! {
                _ = tokio::time::sleep(remaining) => {
                    return self.is_cache_generation_current(game_id, generation).await;
                }
                _ = &mut generation_changed => {}
            }
        }
    }

    async fn cached_cover_path(&self, key: CoverCacheKey) -> Option<PathBuf> {
        self.cached_cover_paths.read().await.get(&key).cloned()
    }

    async fn remember_cover_path(&self, key: CoverCacheKey, path: PathBuf) {
        let mut paths = self.cached_cover_paths.write().await;
        paths.retain(|cached_key, _| cached_key.game_id != key.game_id || *cached_key == key);
        paths.insert(key, path);
    }

    async fn forget_cover_path_if_current(&self, key: CoverCacheKey, path: &Path) {
        let mut paths = self.cached_cover_paths.write().await;
        if paths.get(&key).is_some_and(|current| current == path) {
            paths.remove(&key);
        }
    }

    async fn forget_game_cover_paths(&self, game_id: i64) {
        self.cached_cover_paths
            .write()
            .await
            .retain(|key, _| key.game_id != game_id);
    }

    async fn publish_cache_file_if_current(
        &self,
        key: CoverCacheKey,
        generation: u64,
        temp_path: &Path,
        cache_path: &Path,
        bytes: &[u8],
    ) -> Result<(), CachePublishError> {
        let mutation_lock = self.cache_mutation_lock(key.game_id);
        let _guard = mutation_lock.lock().await;

        if !self
            .is_cache_generation_current(key.game_id, generation)
            .await
        {
            return Err(CachePublishError::Stale);
        }

        if let Err(error) = tokio::fs::write(temp_path, bytes).await {
            remove_file_if_exists(temp_path).await;
            return Err(CachePublishError::Write(error));
        }

        if let Err(error) = tokio::fs::rename(temp_path, cache_path).await {
            remove_file_if_exists(temp_path).await;
            return Err(CachePublishError::Rename(error));
        }

        self.remember_cover_path(key, cache_path.to_path_buf())
            .await;

        Ok(())
    }

    async fn is_game_deleted_marked(&self, game_id: i64) -> bool {
        self.tombstoned_ids.read().await.contains(&game_id)
    }
}

/// RAII guard：下载结束时（无论成功/失败/panic/取消）自动唤醒等待者，并清理 downloading 表
struct DownloadCleanupGuard {
    downloading: DownloadingMap,
    key: DownloadKey,
    sender: Arc<watch::Sender<bool>>,
}

impl Drop for DownloadCleanupGuard {
    fn drop(&mut self) {
        // 发送"完成"信号；等待者收到后自行检查磁盘缓存是否成功
        let _ = self.sender.send(true);
        self.downloading
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

fn infer_cache_extension(cloud_url: &str) -> String {
    infer_image_extension(cloud_url).unwrap_or_else(|| DEFAULT_COVER_EXTENSION.to_string())
}

fn cloud_cover_url_hash(cloud_url: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    cloud_url.hash(&mut hasher);
    hasher.finish()
}

fn cloud_cover_cache_key(game_id: i64, cloud_url: &str) -> CoverCacheKey {
    CoverCacheKey {
        game_id,
        url_hash: cloud_cover_url_hash(cloud_url),
    }
}

fn cloud_cover_file_stem(game_id: i64, cloud_url: &str) -> String {
    let url_hash = cloud_cover_url_hash(cloud_url);
    format!("{DEFAULT_CLOUD_COVER_FILE_NAME}_{game_id}_{url_hash:016x}")
}

fn get_game_cover_dir(game_id: i64) -> Result<PathBuf, String> {
    Ok(get_base_data_dir()?
        .join("covers")
        .join(format!("game_{}", game_id)))
}

fn build_cache_path(
    game_cover_dir: &Path,
    game_id: i64,
    cloud_url: &str,
    extension: &str,
) -> PathBuf {
    game_cover_dir.join(format!(
        "{}.{}",
        cloud_cover_file_stem(game_id, cloud_url),
        extension
    ))
}

fn build_temp_cache_path(
    game_cover_dir: &Path,
    game_id: i64,
    cloud_url: &str,
    extension: &str,
) -> PathBuf {
    let unique_suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    game_cover_dir.join(format!(
        "{}.{extension}.part.{unique_suffix}",
        cloud_cover_file_stem(game_id, cloud_url)
    ))
}

async fn get_cached_cloud_cover(
    game_cover_dir: &Path,
    game_id: i64,
    cloud_url: Option<&str>,
) -> Option<PathBuf> {
    let cloud_url = cloud_url?;
    let file_stem = cloud_cover_file_stem(game_id, cloud_url);

    // 冷启动或索引失效时按兼容顺序探测常见扩展名。
    const COMMON_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"];
    for ext in COMMON_EXTENSIONS {
        let path = game_cover_dir.join(format!("{file_stem}.{ext}"));
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return Some(path);
        }
    }

    // 兼容未知扩展名的旧缓存文件；命中后路径会进入内存索引。
    let mut entries = tokio::fs::read_dir(game_cover_dir).await.ok()?;
    let expected_prefix = format!("{file_stem}.");

    while let Some(entry) = entries.next_entry().await.ok()? {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&expected_prefix) && !name.contains(".part.") {
            return Some(path);
        }
    }

    None
}

async fn read_cached_cloud_cover(
    state: &DownloadState,
    game_cover_dir: &Path,
    game_id: i64,
    cloud_url: Option<&str>,
    card_width: Option<u32>,
) -> Option<(PathBuf, Vec<u8>)> {
    let cloud_url = cloud_url?;
    let key = cloud_cover_cache_key(game_id, cloud_url);

    if let Some(path) = state.cached_cover_path(key).await {
        if let Ok(cover) = read_cover_file(&path, card_width).await {
            return Some(cover);
        }
        state.forget_cover_path_if_current(key, &path).await;
    }

    let path = get_cached_cloud_cover(game_cover_dir, game_id, Some(cloud_url)).await?;
    let cover = read_cover_file(&path, card_width).await.ok()?;
    state.remember_cover_path(key, path.clone()).await;
    Some(cover)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CoverGameIdError {
    Malformed,
    OutsideDatabaseRange,
}

impl CoverGameIdError {
    fn response_status(self) -> StatusCode {
        match self {
            Self::Malformed => StatusCode::BAD_REQUEST,
            Self::OutsideDatabaseRange => StatusCode::NOT_FOUND,
        }
    }
}

fn parse_game_id_from_uri(parsed: &url::Url) -> Result<i64, CoverGameIdError> {
    let game_id = if let Some(host) = parsed.host_str()
        && host != "localhost"
        && let Ok(id) = host.parse::<i64>()
    {
        id
    } else {
        parsed
            .path()
            .trim_start_matches('/')
            .parse::<i64>()
            .map_err(|_| CoverGameIdError::Malformed)?
    };

    to_database_game_id(game_id).ok_or(CoverGameIdError::OutsideDatabaseRange)?;
    Ok(game_id)
}

async fn remove_file_if_exists(path: &Path) {
    match tokio::fs::remove_file(path).await {
        Ok(_) => {}
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => log::warn!("删除失败的封面缓存文件失败 {:?}: {}", path, err),
    }
}

#[derive(Debug)]
enum CoverDownloadError {
    Retryable(String),
    NonRetryableRequest(String),
    GameDeleted(String),
    Stale(String),
    NonRetryable(String),
}

fn classify_cover_request_error(stage: &str, error: reqwest::Error) -> CoverDownloadError {
    // reqwest reports some mid-request socket closures as request errors rather than connect errors.
    let is_retryable = error.is_connect()
        || error.is_timeout()
        || error.is_body()
        || error.is_decode()
        || (error.is_request()
            && !error.is_builder()
            && !error.is_redirect()
            && !error.is_status());
    let message = format!("{stage}: {}", error.without_url());
    if is_retryable {
        CoverDownloadError::Retryable(message)
    } else {
        CoverDownloadError::NonRetryableRequest(message)
    }
}

#[derive(Debug)]
enum CachePublishError {
    Stale,
    Write(std::io::Error),
    Rename(std::io::Error),
}

#[derive(Debug, Eq, PartialEq)]
enum CoverRetryTransition {
    Retry {
        attempt: usize,
        delay: Duration,
    },
    Exhausted {
        retry_count: usize,
        last_error: String,
    },
}

#[derive(Default)]
struct CoverRetryProgress {
    completed_retries: usize,
}

impl CoverRetryProgress {
    fn current_attempt(&self) -> usize {
        self.completed_retries
    }

    fn record_retryable_failure(&mut self, error: String) -> CoverRetryTransition {
        let Some(delay) = COVER_RETRY_DELAYS.get(self.completed_retries).copied() else {
            return CoverRetryTransition::Exhausted {
                retry_count: self.completed_retries,
                last_error: error,
            };
        };

        self.completed_retries += 1;
        CoverRetryTransition::Retry {
            attempt: self.completed_retries,
            delay,
        }
    }
}

async fn game_exists_in_db(
    db: &DatabaseConnection,
    game_id: i64,
) -> Result<bool, CoverDownloadError> {
    let Some(database_game_id) = to_database_game_id(game_id) else {
        return Ok(false);
    };

    Games::find_by_id(database_game_id)
        .one(db)
        .await
        .map(|game| game.is_some())
        .map_err(|e| CoverDownloadError::NonRetryable(format!("检查游戏状态失败: {}", e)))
}

async fn ensure_game_cover_writable(
    state: &DownloadState,
    db: &DatabaseConnection,
    game_id: i64,
) -> Result<(), CoverDownloadError> {
    let exists = game_exists_in_db(db, game_id).await?;

    state.apply_game_presence(game_id, exists).await;
    match exists {
        true => Ok(()),
        false => Err(CoverDownloadError::GameDeleted(format!(
            "游戏已删除 game_id={}",
            game_id
        ))),
    }
}

fn make_ok_response(bytes: Vec<u8>, content_type: &str) -> tauri::http::Response<Vec<u8>> {
    make_image_response(bytes, content_type, "max-age=31536000, immutable")
}

#[command]
pub async fn delete_cloud_cache(
    game_id: i64,
    state: tauri::State<'_, DownloadState>,
) -> Result<(), String> {
    let game_cover_dir = get_game_cover_dir(game_id)?;
    invalidate_cloud_cover_cache(state.inner(), game_id, &game_cover_dir).await
}

async fn invalidate_cloud_cover_cache(
    state: &DownloadState,
    game_id: i64,
    game_cover_dir: &Path,
) -> Result<(), String> {
    let mutation_lock = state.cache_mutation_lock(game_id);
    let _guard = mutation_lock.lock().await;

    let expected_prefix = format!("{DEFAULT_CLOUD_COVER_FILE_NAME}_{game_id}_");
    let legacy_prefix = format!("{DEFAULT_CLOUD_COVER_FILE_NAME}_{game_id}.");

    state.bump_cache_generation(game_id).await;
    state.forget_game_cover_paths(game_id).await;

    if !game_cover_dir.exists() {
        return Ok(());
    }

    let mut entries = tokio::fs::read_dir(&game_cover_dir)
        .await
        .map_err(|e| format!("无法读取封面目录: {}", e))?;

    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("读取目录项失败: {}", e))?
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();
        if !file_name_str.starts_with(&expected_prefix)
            && !file_name_str.starts_with(&legacy_prefix)
        {
            continue;
        }
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| format!("删除云端缓存失败: {}", e))?;
    }

    Ok(())
}

/// 单次下载尝试：发起请求 → 写 .part 临时文件 → rename 为正式缓存
/// 成功时返回图片字节（内存中已有，无需再次读盘）
async fn try_download_once(
    url: &str,
    client: &reqwest::Client,
    game_cover_dir: &Path,
    game_id: i64,
    generation: u64,
    db: &DatabaseConnection,
    state: &DownloadState,
) -> Result<Vec<u8>, CoverDownloadError> {
    let extension = infer_cache_extension(url);
    let cache_key = cloud_cover_cache_key(game_id, url);
    let cache_path = build_cache_path(game_cover_dir, game_id, url, &extension);
    let temp_path = build_temp_cache_path(game_cover_dir, game_id, url, &extension);

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| classify_cover_request_error("发起请求失败", error))?;

    if !response.status().is_success() {
        return Err(CoverDownloadError::NonRetryable(format!(
            "HTTP 状态码异常: {}",
            response.status()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| classify_cover_request_error("读取响应体失败", error))?
        .to_vec();

    ensure_game_cover_writable(state, db, game_id).await?;
    match state
        .publish_cache_file_if_current(cache_key, generation, &temp_path, &cache_path, &bytes)
        .await
    {
        Ok(()) => {}
        Err(CachePublishError::Stale) => {
            return Err(CoverDownloadError::Stale(format!(
                "封面下载写盘前已过期 game_id={} generation={}",
                game_id, generation
            )));
        }
        Err(CachePublishError::Write(error)) => {
            return Err(CoverDownloadError::NonRetryable(format!(
                "写入临时文件失败: {}",
                error
            )));
        }
        Err(CachePublishError::Rename(error)) => {
            // rename 失败（如跨盘符）不阻止本次返回，bytes 仍有效
            log::warn!(
                "封面 rename 失败 game_id={}: {}，本次直接返回内存字节",
                game_id,
                error
            );
        }
    }

    Ok(bytes)
}

/// 按 Skerry 的固定退避时序重试封面下载（总尝试次数 = 1 + 延迟表项数）
/// 成功时返回图片字节，并已写入磁盘缓存
async fn fetch_and_cache_cover(
    game_id: i64,
    generation: u64,
    url: &str,
    game_cover_dir: &Path,
    db: &DatabaseConnection,
    state: &DownloadState,
    client_for_attempt: fn() -> reqwest::Client,
) -> Result<Vec<u8>, CoverDownloadError> {
    // 目录只在进入下载流程时创建一次，避免重试阶段重复创建
    ensure_game_cover_writable(state, db, game_id).await?;
    tokio::fs::create_dir_all(game_cover_dir)
        .await
        .map_err(|e| CoverDownloadError::NonRetryable(format!("创建缓存目录失败: {}", e)))?;

    let mut retry_progress = CoverRetryProgress::default();
    loop {
        if !state.is_cache_generation_current(game_id, generation).await {
            return Err(CoverDownloadError::Stale(format!(
                "封面下载重试前已过期 game_id={} generation={}",
                game_id, generation
            )));
        }

        let attempt = retry_progress.current_attempt();
        let client = client_for_attempt();
        match try_download_once(url, &client, game_cover_dir, game_id, generation, db, state).await
        {
            Ok(bytes) => {
                if !state.is_cache_generation_current(game_id, generation).await {
                    return Err(CoverDownloadError::Stale(format!(
                        "封面下载返回前已过期 game_id={} generation={}",
                        game_id, generation
                    )));
                }
                log::debug!(
                    "封面缓存完成 game_id={} generation={} attempt={}",
                    game_id,
                    generation,
                    attempt
                );
                return Ok(bytes);
            }
            Err(CoverDownloadError::Retryable(e)) => {
                log::debug!(
                    "封面下载失败 game_id={} attempt={}/{}: {}",
                    game_id,
                    attempt,
                    COVER_RETRY_DELAYS.len(),
                    e
                );
                match retry_progress.record_retryable_failure(e) {
                    CoverRetryTransition::Retry { attempt, delay } => {
                        if !state.is_cache_generation_current(game_id, generation).await {
                            return Err(CoverDownloadError::Stale(format!(
                                "封面下载重试前已过期 game_id={} generation={}",
                                game_id, generation
                            )));
                        }
                        log::debug!(
                            "封面下载重试 game_id={} attempt={}/{} delay={}ms",
                            game_id,
                            attempt,
                            COVER_RETRY_DELAYS.len(),
                            delay.as_millis()
                        );
                        if !state
                            .wait_for_retry_or_generation_change(game_id, generation, delay)
                            .await
                        {
                            return Err(CoverDownloadError::Stale(format!(
                                "封面下载重试等待期间已过期 game_id={} generation={}",
                                game_id, generation
                            )));
                        }
                    }
                    CoverRetryTransition::Exhausted {
                        retry_count,
                        last_error,
                    } => {
                        return Err(CoverDownloadError::Retryable(format!(
                            "下载最终失败（已重试 {} 次）: {}",
                            retry_count, last_error
                        )));
                    }
                }
            }
            Err(CoverDownloadError::GameDeleted(e)) => {
                log::debug!(
                    "封面下载终止（游戏已删除） game_id={} attempt={}/{}: {}",
                    game_id,
                    attempt,
                    COVER_RETRY_DELAYS.len(),
                    e
                );
                return Err(CoverDownloadError::GameDeleted(e));
            }
            Err(CoverDownloadError::Stale(e)) => {
                log::debug!(
                    "封面下载终止（已过期） game_id={} attempt={}/{}: {}",
                    game_id,
                    attempt,
                    COVER_RETRY_DELAYS.len(),
                    e
                );
                return Err(CoverDownloadError::Stale(e));
            }
            Err(CoverDownloadError::NonRetryableRequest(e)) => {
                log::warn!(
                    "封面请求无法重试 game_id={} attempt={}/{}: {}",
                    game_id,
                    attempt,
                    COVER_RETRY_DELAYS.len(),
                    e
                );
                return Err(CoverDownloadError::NonRetryableRequest(e));
            }
            Err(CoverDownloadError::NonRetryable(e)) => {
                log::warn!(
                    "封面下载终止（不可重试） game_id={} attempt={}/{}: {}",
                    game_id,
                    attempt,
                    COVER_RETRY_DELAYS.len(),
                    e
                );
                return Err(CoverDownloadError::NonRetryable(e));
            }
        }
    }
}

pub fn register_game_cover_protocol<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder
        .manage(DownloadState {
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_COVER_DOWNLOADS)),
            cached_cover_paths: Arc::new(RwLock::new(HashMap::new())),
            cache_generations: Arc::new(RwLock::new(HashMap::new())),
            generation_changed: Notify::new(),
            tombstoned_ids: Arc::new(RwLock::new(HashSet::new())),
            downloading: Arc::new(Mutex::new(HashMap::new())),
            cache_mutation_locks: Arc::new(Mutex::new(HashMap::new())),
        })
        .register_asynchronous_uri_scheme_protocol("skerry-cover", |app, request, responder| {
            let app_handle = app.app_handle().clone();
            let request_uri = request.uri().to_string();

            tauri::async_runtime::spawn(async move {
                // ── 解析请求 URI ──────────────────────────────────────
                let parsed = match url::Url::parse(&request_uri) {
                    Ok(u) => u,
                    Err(_) => {
                        responder.respond(make_status_response(StatusCode::BAD_REQUEST));
                        return;
                    }
                };

                let game_id = match parse_game_id_from_uri(&parsed) {
                    Ok(id) => id,
                    Err(error) => {
                        responder.respond(make_status_response(error.response_status()));
                        return;
                    }
                };

                let cloud_url = parsed
                    .query_pairs()
                    .find(|(k, _)| k == "url")
                    .map(|(_, v)| v.into_owned());

                let card_width = match parsed.query_pairs().find(|(key, _)| key == "width") {
                    Some((_, value)) => match parse_card_width(&value) {
                        Some(width) => Some(width),
                        None => {
                            responder.respond(make_status_response(StatusCode::BAD_REQUEST));
                            return;
                        }
                    },
                    None => None,
                };

                let game_cover_dir = match get_game_cover_dir(game_id) {
                    Ok(dir) => dir,
                    Err(_) => {
                        responder.respond(make_status_response(StatusCode::INTERNAL_SERVER_ERROR));
                        return;
                    }
                };

                let state = app_handle.state::<DownloadState>();
                let db = app_handle.state::<DatabaseConnection>();

                if state.is_game_deleted_marked(game_id).await {
                    match ensure_game_cover_writable(&state, db.inner(), game_id).await {
                        Ok(_) => {}
                        Err(CoverDownloadError::GameDeleted(_)) => {
                            responder.respond(make_status_response(StatusCode::NOT_FOUND));
                            return;
                        }
                        Err(CoverDownloadError::NonRetryable(e)) => {
                            log::warn!("检查游戏状态失败 game_id={}: {}", game_id, e);
                            responder
                                .respond(make_status_response(StatusCode::INTERNAL_SERVER_ERROR));
                            return;
                        }
                        Err(CoverDownloadError::Retryable(_)) => unreachable!(),
                        Err(CoverDownloadError::NonRetryableRequest(_)) => unreachable!(),
                        Err(CoverDownloadError::Stale(_)) => unreachable!(),
                    }
                }

                if let Some((_, token)) = parsed.query_pairs().find(|(key, _)| key == "local") {
                    let Some(path) = local_cover_path(&game_cover_dir, game_id, &token) else {
                        responder.respond(make_status_response(StatusCode::BAD_REQUEST));
                        return;
                    };
                    match read_cover_file(&path, card_width).await {
                        Ok((path, bytes)) => {
                            responder.respond(make_ok_response(bytes, content_type_for_file(&path)))
                        }
                        Err(error) => {
                            log::warn!("local card cover game_id={game_id}: {error}");
                            responder.respond(make_status_response(StatusCode::NOT_FOUND));
                        }
                    }
                    return;
                }

                // ── 步骤 1：读索引路径；冷启动或失效时按现有扩展顺序发现 ──
                if let Some((cache_path, bytes)) = read_cached_cloud_cover(
                    &state,
                    &game_cover_dir,
                    game_id,
                    cloud_url.as_deref(),
                    card_width,
                )
                .await
                {
                    responder.respond(make_ok_response(bytes, content_type_for_file(&cache_path)));
                    return;
                }

                // ── 步骤 2：无缓存，需要下载 ─────────────────────────────
                let Some(url) = cloud_url else {
                    responder.respond(make_status_response(StatusCode::NOT_FOUND));
                    return;
                };

                let generation = state.cache_generation(game_id).await;
                let url_hash = cloud_cover_url_hash(url.as_str());
                let download_key = DownloadKey {
                    game_id,
                    generation,
                    url_hash,
                };

                // 检查是否已有相同 game_id + generation 的下载正在进行。
                // generation 不同表示缓存已被更新/切源操作失效，不能等待旧任务。
                let (tx, _) = watch::channel(false);
                let tx = Arc::new(tx);
                let existing_rx = {
                    let mut downloading =
                        state.downloading.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(existing_tx) = downloading.get(&download_key) {
                        Some(existing_tx.subscribe())
                    } else {
                        downloading.insert(download_key, tx.clone());
                        None
                    }
                };

                if let Some(mut rx) = existing_rx {
                    // 有同代下载在进行，等待其完成（watch channel 当前值已是 true 时立即返回）
                    log::debug!(
                        "等待已有下载任务完成 game_id={} generation={}",
                        game_id,
                        generation
                    );
                    let _ = rx.wait_for(|done| *done).await;

                    if !state.is_cache_generation_current(game_id, generation).await {
                        responder.respond(make_status_response(StatusCode::CONFLICT));
                        return;
                    }

                    // 下载结束后尝试读取磁盘缓存
                    if let Some((cache_path, bytes)) = read_cached_cloud_cover(
                        &state,
                        &game_cover_dir,
                        game_id,
                        Some(url.as_str()),
                        card_width,
                    )
                    .await
                    {
                        responder
                            .respond(make_ok_response(bytes, content_type_for_file(&cache_path)));
                        return;
                    }
                    if state.is_game_deleted_marked(game_id).await {
                        responder.respond(make_status_response(StatusCode::NOT_FOUND));
                        return;
                    }
                    // 前序下载失败（超时/网络错误），返回 502
                    responder.respond(make_status_response(StatusCode::BAD_GATEWAY));
                    return;
                }

                // ── 步骤 3：成为本次下载的执行者 ────────────────────────
                // RAII guard：超出作用域时自动通知等待者并清理 downloading 表
                let _cleanup = DownloadCleanupGuard {
                    downloading: state.downloading.clone(),
                    key: download_key,
                    sender: tx,
                };

                // 等待信号量许可（最多 MAX_CONCURRENT_COVER_DOWNLOADS 个并发下载）
                let _permit = match state.semaphore.clone().acquire_owned().await {
                    Ok(p) => p,
                    Err(e) => {
                        log::warn!("获取封面下载许可失败 game_id={}: {}", game_id, e);
                        responder.respond(make_status_response(StatusCode::INTERNAL_SERVER_ERROR));
                        return; // _cleanup drop 在此触发，通知等待者
                    }
                };

                // 执行下载（含指数退避重试）
                let fetch_result = fetch_and_cache_cover(
                    game_id,
                    generation,
                    &url,
                    &game_cover_dir,
                    db.inner(),
                    &state,
                    crate::utils::http::get_client,
                )
                .await;
                match fetch_result {
                    Ok(bytes) => {
                        if card_width.is_some() {
                            if let Some((path, thumbnail_bytes)) = read_cached_cloud_cover(
                                &state,
                                &game_cover_dir,
                                game_id,
                                Some(&url),
                                card_width,
                            )
                            .await
                            {
                                responder.respond(make_ok_response(
                                    thumbnail_bytes,
                                    content_type_for_file(&path),
                                ));
                                return;
                            }
                        }
                        let content_type = content_type_for_extension(&infer_cache_extension(&url));
                        responder.respond(make_ok_response(bytes, content_type));
                    }
                    Err(CoverDownloadError::GameDeleted(e)) => {
                        log::debug!("封面下载终止 game_id={}: {}", game_id, e);
                        responder.respond(make_status_response(StatusCode::NOT_FOUND));
                    }
                    Err(CoverDownloadError::Stale(_)) => {
                        responder.respond(make_status_response(StatusCode::CONFLICT));
                    }
                    Err(CoverDownloadError::NonRetryable(e)) => {
                        log::warn!("封面下载终止 game_id={}: {}", game_id, e);
                        responder.respond(make_status_response(StatusCode::INTERNAL_SERVER_ERROR));
                    }
                    Err(CoverDownloadError::NonRetryableRequest(e)) => {
                        log::warn!("封面请求失败 game_id={}: {}", game_id, e);
                        responder.respond(make_status_response(StatusCode::BAD_GATEWAY));
                    }
                    Err(CoverDownloadError::Retryable(e)) => {
                        log::warn!("封面下载最终失败 game_id={}: {}", game_id, e);
                        responder.respond(make_status_response(StatusCode::BAD_GATEWAY));
                    }
                }
                // _cleanup 在此 drop：通知所有等待步骤 3 的请求
            });
        })
}

#[cfg(test)]
mod tests {
    use super::{
        CachePublishError, CoverDownloadError, CoverGameIdError, CoverRetryProgress,
        CoverRetryTransition, DownloadState, build_cache_path, build_temp_cache_path,
        classify_cover_request_error, cloud_cover_cache_key, fetch_and_cache_cover,
        infer_cache_extension, invalidate_cloud_cover_cache, parse_game_id_from_uri,
        read_cached_cloud_cover,
    };
    use sea_orm::{ConnectOptions, ConnectionTrait, Database};
    use std::collections::{HashMap, HashSet};
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::sync::{RwLock, Semaphore};

    static NEXT_TEST_COVER_DIR_ID: AtomicUsize = AtomicUsize::new(0);

    fn download_state() -> DownloadState {
        DownloadState {
            semaphore: Arc::new(Semaphore::new(1)),
            cached_cover_paths: Arc::new(RwLock::new(HashMap::new())),
            cache_generations: Arc::new(RwLock::new(HashMap::new())),
            generation_changed: super::Notify::new(),
            tombstoned_ids: Arc::new(RwLock::new(HashSet::new())),
            downloading: Arc::new(Mutex::new(HashMap::new())),
            cache_mutation_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn test_cover_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should follow Unix epoch")
            .as_nanos();
        let test_dir_id = NEXT_TEST_COVER_DIR_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "skerry-cover-cache-{}-{nonce}-{test_dir_id}",
            std::process::id()
        ))
    }

    fn test_no_proxy_http_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("no-proxy HTTP client should build")
    }

    #[test]
    fn cover_retry_progress_follows_the_fixed_delay_schedule() {
        let mut progress = CoverRetryProgress::default();
        assert_eq!(progress.current_attempt(), 0);

        assert_eq!(
            progress.record_retryable_failure("first request failed".to_string()),
            CoverRetryTransition::Retry {
                attempt: 1,
                delay: std::time::Duration::from_millis(500),
            }
        );
        assert_eq!(progress.current_attempt(), 1);

        assert_eq!(
            progress.record_retryable_failure("second request failed".to_string()),
            CoverRetryTransition::Retry {
                attempt: 2,
                delay: std::time::Duration::from_millis(1000),
            }
        );
        assert_eq!(progress.current_attempt(), 2);

        assert_eq!(
            progress.record_retryable_failure("third request failed".to_string()),
            CoverRetryTransition::Exhausted {
                retry_count: 2,
                last_error: "third request failed".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn cache_generation_change_interrupts_cover_retry_wait() {
        let state = Arc::new(download_state());
        let waiting_state = Arc::clone(&state);
        let game_id = 7486;
        let wait = tokio::spawn(async move {
            waiting_state
                .wait_for_retry_or_generation_change(game_id, 0, std::time::Duration::from_secs(30))
                .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        assert!(!wait.is_finished(), "retry wait should still be pending");

        state.bump_cache_generation(game_id).await;
        let remained_current = tokio::time::timeout(std::time::Duration::from_secs(2), wait)
            .await
            .expect("generation change should wake the retry wait promptly")
            .expect("retry wait task should complete");

        assert!(!remained_current);
    }

    #[tokio::test]
    async fn another_games_generation_change_does_not_cancel_cover_retry_wait() {
        let state = Arc::new(download_state());
        let waiting_state = Arc::clone(&state);
        let game_id = 7486;
        let wait = tokio::spawn(async move {
            waiting_state
                .wait_for_retry_or_generation_change(game_id, 0, std::time::Duration::from_secs(30))
                .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        state.bump_cache_generation(game_id + 1).await;
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        assert!(
            !wait.is_finished(),
            "another game's change must not cancel this retry"
        );

        state.bump_cache_generation(game_id).await;
        let remained_current = tokio::time::timeout(std::time::Duration::from_secs(2), wait)
            .await
            .expect("the matching generation change should wake this retry")
            .expect("retry wait task should complete");

        assert!(!remained_current);
    }

    #[test]
    fn cloud_cache_extension_comes_from_url_path_and_preserves_existing_fallbacks() {
        assert_eq!(
            infer_cache_extension("https://cdn.example.test/covers/game.WEBP?rev=1#cover"),
            "webp"
        );
        assert_eq!(infer_cache_extension("https://avatar.webp"), "jpg");
        assert_eq!(
            infer_cache_extension("https://cdn.example.test/download.bin"),
            "bin"
        );
        assert_eq!(
            infer_cache_extension("https://cdn.example.test/download"),
            "jpg"
        );
    }

    #[tokio::test]
    async fn cold_discovery_indexes_rare_extensions_and_replaces_a_stale_path() {
        let state = download_state();
        let game_id = 7479;
        let cloud_url = "https://cdn.example.test/covers/game.tiff?revision=1";
        let game_cover_dir = test_cover_dir();
        tokio::fs::create_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be created");

        let rare_extension_path = build_cache_path(&game_cover_dir, game_id, cloud_url, "tiff");
        tokio::fs::write(&rare_extension_path, b"rare cached cover")
            .await
            .expect("rare-extension cache should be created");

        let (discovered_path, discovered_body) =
            read_cached_cloud_cover(&state, &game_cover_dir, game_id, Some(cloud_url), None)
                .await
                .expect("cold lookup should discover an uncommon cache extension");
        assert_eq!(discovered_path, rare_extension_path);
        assert_eq!(discovered_body, b"rare cached cover");
        assert_eq!(
            state
                .cached_cover_path(cloud_cover_cache_key(game_id, cloud_url))
                .await,
            Some(rare_extension_path.clone())
        );

        tokio::fs::remove_file(&rare_extension_path)
            .await
            .expect("stale indexed cache should be removed");
        let replacement_path = build_cache_path(&game_cover_dir, game_id, cloud_url, "png");
        tokio::fs::write(&replacement_path, b"replacement cached cover")
            .await
            .expect("replacement cache should be created");

        let (refreshed_path, refreshed_body) =
            read_cached_cloud_cover(&state, &game_cover_dir, game_id, Some(cloud_url), None)
                .await
                .expect("stale index should be rediscovered from the cache directory");
        assert_eq!(refreshed_path, replacement_path);
        assert_eq!(refreshed_body, b"replacement cached cover");
        assert_eq!(
            state
                .cached_cover_path(cloud_cover_cache_key(game_id, cloud_url))
                .await,
            Some(replacement_path)
        );

        tokio::fs::remove_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be removed");
    }

    #[tokio::test]
    async fn game_deletion_forgets_the_derived_cover_path_index() {
        let state = download_state();
        let game_id = 7480;
        let cloud_url = "https://cdn.example.test/covers/game.png";
        let cache_key = cloud_cover_cache_key(game_id, cloud_url);
        state
            .remember_cover_path(cache_key, PathBuf::from("covers/game_7480/cache.png"))
            .await;

        state.mark_game_deleted(game_id).await;
        let invalidated_generation = state.cache_generation(game_id).await;
        state.mark_game_deleted(game_id).await;

        assert_eq!(
            state.cache_generation(game_id).await,
            invalidated_generation
        );
        assert!(state.cached_cover_path(cache_key).await.is_none());
        assert!(state.is_game_deleted_marked(game_id).await);

        state.apply_game_presence(game_id, true).await;
        assert!(!state.is_game_deleted_marked(game_id).await);
        assert_eq!(
            state.cache_generation(game_id).await,
            invalidated_generation
        );
    }

    #[tokio::test]
    async fn cached_cover_lookup_keeps_source_urls_isolated() {
        let state = download_state();
        let game_id = 7481;
        let first_url = "https://cdn.example.test/covers/first.jpg";
        let second_url = "https://cdn.example.test/covers/second.png";
        let game_cover_dir = test_cover_dir();
        tokio::fs::create_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be created");

        let first_path = build_cache_path(&game_cover_dir, game_id, first_url, "jpg");
        let second_path = build_cache_path(&game_cover_dir, game_id, second_url, "png");
        tokio::fs::write(&first_path, b"first source")
            .await
            .expect("first source cache should be created");
        tokio::fs::write(&second_path, b"second source")
            .await
            .expect("second source cache should be created");

        let first =
            read_cached_cloud_cover(&state, &game_cover_dir, game_id, Some(first_url), None)
                .await
                .expect("first source should resolve its own cache");
        let second =
            read_cached_cloud_cover(&state, &game_cover_dir, game_id, Some(second_url), None)
                .await
                .expect("second source should resolve its own cache");
        assert_eq!(first, (first_path.clone(), b"first source".to_vec()));
        assert_eq!(second, (second_path.clone(), b"second source".to_vec()));
        assert!(
            state
                .cached_cover_path(cloud_cover_cache_key(game_id, first_url))
                .await
                .is_none(),
            "the per-game index should retain only the most recent source URL"
        );
        assert_eq!(
            state
                .cached_cover_path(cloud_cover_cache_key(game_id, second_url))
                .await,
            Some(second_path)
        );

        let first_again =
            read_cached_cloud_cover(&state, &game_cover_dir, game_id, Some(first_url), None)
                .await
                .expect("an earlier source should be rediscovered from its URL-specific file");
        assert_eq!(first_again, (first_path, b"first source".to_vec()));

        tokio::fs::remove_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be removed");
    }

    #[test]
    fn cover_protocol_distinguishes_malformed_and_unaddressable_database_ids() {
        let max_id = url::Url::parse("skerry-cover://localhost/2147483647")
            .expect("maximum database ID URI should parse");
        let min_id = url::Url::parse("skerry-cover://localhost/-2147483648")
            .expect("minimum database ID URI should parse");
        let first_out_of_range_id = url::Url::parse("skerry-cover://localhost/2147483648")
            .expect("out-of-range database ID URI should parse");
        let first_under_range_id = url::Url::parse("skerry-cover://localhost/-2147483649")
            .expect("under-range database ID URI should parse");
        let malformed_id = url::Url::parse("skerry-cover://localhost/not-an-id")
            .expect("malformed ID URI should parse");

        assert_eq!(parse_game_id_from_uri(&max_id), Ok(i64::from(i32::MAX)));
        assert_eq!(parse_game_id_from_uri(&min_id), Ok(i64::from(i32::MIN)));
        assert_eq!(
            parse_game_id_from_uri(&first_out_of_range_id),
            Err(CoverGameIdError::OutsideDatabaseRange)
        );
        assert_eq!(
            parse_game_id_from_uri(&first_under_range_id),
            Err(CoverGameIdError::OutsideDatabaseRange)
        );
        assert_eq!(
            parse_game_id_from_uri(&malformed_id),
            Err(CoverGameIdError::Malformed)
        );
        assert_eq!(
            CoverGameIdError::Malformed.response_status(),
            tauri::http::StatusCode::BAD_REQUEST
        );
        assert_eq!(
            CoverGameIdError::OutsideDatabaseRange.response_status(),
            tauri::http::StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn out_of_range_game_id_cannot_start_a_cover_download_or_create_cache() {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("in-memory database should connect");
        let state = download_state();
        let game_id = i64::from(i32::MAX) + 1;
        let game_cover_dir = test_cover_dir();

        let result = fetch_and_cache_cover(
            game_id,
            state.cache_generation(game_id).await,
            "http://127.0.0.1:1/cover.jpg",
            &game_cover_dir,
            &db,
            &state,
            test_no_proxy_http_client,
        )
        .await;

        assert!(matches!(result, Err(CoverDownloadError::GameDeleted(_))));
        assert!(state.is_game_deleted_marked(game_id).await);
        assert!(!game_cover_dir.exists());
        db.close().await.expect("in-memory database should close");
    }

    #[test]
    fn cache_mutation_lock_reuses_active_owner_and_prunes_idle_entries() {
        let state = download_state();
        let first = state.cache_mutation_lock(7481);
        let same_game = state.cache_mutation_lock(7481);
        assert!(Arc::ptr_eq(&first, &same_game));

        let retired_lock = Arc::downgrade(&first);
        drop(same_game);
        drop(first);

        let another_game = state.cache_mutation_lock(7482);
        assert!(retired_lock.upgrade().is_none());
        assert_eq!(
            state
                .cache_mutation_locks
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            1
        );

        let same_active_game = state.cache_mutation_lock(7482);
        assert!(Arc::ptr_eq(&another_game, &same_active_game));
    }

    #[tokio::test]
    async fn cloud_cover_fetch_uses_the_source_url_and_publishes_the_response() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .expect("test HTTP listener should bind to loopback");
        let address = listener
            .local_addr()
            .expect("test HTTP listener should expose its address");
        let response_body = b"skerry cloud cover".to_vec();
        let server_body = response_body.clone();
        let server = thread::spawn(move || {
            let (mut connection, _) = listener
                .accept()
                .expect("cloud cover request should reach loopback listener");
            let mut request = BufReader::new(
                connection
                    .try_clone()
                    .expect("loopback connection should be cloneable"),
            );
            let mut request_line = String::new();
            request
                .read_line(&mut request_line)
                .expect("HTTP request line should be readable");
            loop {
                let mut header = String::new();
                request
                    .read_line(&mut header)
                    .expect("HTTP request headers should be readable");
                if header == "\r\n" || header.is_empty() {
                    break;
                }
            }

            let response_headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: image/webp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                server_body.len()
            );
            connection
                .write_all(response_headers.as_bytes())
                .expect("loopback response headers should be writable");
            connection
                .write_all(&server_body)
                .expect("loopback response body should be writable");
            request_line.trim_end().to_string()
        });

        let mut options = ConnectOptions::new("sqlite::memory:");
        options.max_connections(1);
        let db = Database::connect(options)
            .await
            .expect("in-memory game database should connect");
        db.execute_unprepared(
            "CREATE TABLE games (\
                id INTEGER PRIMARY KEY, id_type TEXT NOT NULL, date TEXT, localpath TEXT, \
                executable TEXT, launch_type TEXT NOT NULL, steam_launch_id TEXT, savepath TEXT, \
                autosave INTEGER, maxbackups INTEGER, clear INTEGER, le_launch INTEGER, \
                magpie INTEGER, custom_data TEXT, user_rating REAL, created_at INTEGER, \
                updated_at INTEGER\
            )",
        )
        .await
        .expect("game table should be created");

        let game_id = 7484;
        db.execute_unprepared(&format!(
            "INSERT INTO games (id, id_type, launch_type) VALUES ({game_id}, 'local', 'local')"
        ))
        .await
        .expect("test game should be present in the database");

        let state = download_state();
        let generation = state.cache_generation(game_id).await;
        let game_cover_dir = test_cover_dir();
        let source_url = format!("http://{address}/cover.webp?revision=1");
        let fetched_body = fetch_and_cache_cover(
            game_id,
            generation,
            &source_url,
            &game_cover_dir,
            &db,
            &state,
            test_no_proxy_http_client,
        )
        .await
        .expect("cloud cover should download and publish");

        assert_eq!(fetched_body, response_body);
        assert_eq!(
            server.join().expect("loopback server should finish"),
            "GET /cover.webp?revision=1 HTTP/1.1"
        );
        let cache_path = build_cache_path(&game_cover_dir, game_id, &source_url, "webp");
        assert_eq!(
            tokio::fs::read(&cache_path)
                .await
                .expect("cloud cover should be present in its URL cache"),
            response_body
        );
        assert_eq!(
            state
                .cached_cover_path(cloud_cover_cache_key(game_id, &source_url))
                .await,
            Some(cache_path.clone())
        );
        let (indexed_path, indexed_body) =
            read_cached_cloud_cover(&state, &game_cover_dir, game_id, Some(&source_url), None)
                .await
                .expect("published cache index should serve a subsequent request");
        assert_eq!(indexed_path, cache_path);
        assert_eq!(indexed_body, response_body);

        db.close()
            .await
            .expect("in-memory game database should close");
        tokio::fs::remove_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be removed");
    }

    #[tokio::test]
    async fn cloud_cover_fetch_retries_connection_failures_before_publishing() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .expect("test HTTP listener should bind to loopback");
        let address = listener
            .local_addr()
            .expect("test HTTP listener should expose its address");
        let response_body = b"cover after retries".to_vec();
        let server_body = response_body.clone();
        let server = thread::spawn(move || {
            let mut request_lines = Vec::new();
            for attempt in 0..3 {
                let (mut connection, _) = listener
                    .accept()
                    .expect("each cover attempt should reach the loopback listener");
                let mut request = BufReader::new(
                    connection
                        .try_clone()
                        .expect("loopback connection should be cloneable"),
                );
                let mut request_line = String::new();
                request
                    .read_line(&mut request_line)
                    .expect("HTTP request line should be readable");
                loop {
                    let mut header = String::new();
                    request
                        .read_line(&mut header)
                        .expect("HTTP request headers should be readable");
                    if header == "\r\n" || header.is_empty() {
                        break;
                    }
                }
                request_lines.push(request_line.trim_end().to_string());

                if attempt < 2 {
                    drop(connection);
                    continue;
                }

                let response_headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/webp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    server_body.len()
                );
                connection
                    .write_all(response_headers.as_bytes())
                    .expect("successful response headers should be writable");
                connection
                    .write_all(&server_body)
                    .expect("successful response body should be writable");
            }
            request_lines
        });

        let mut options = ConnectOptions::new("sqlite::memory:");
        options.max_connections(1);
        let db = Database::connect(options)
            .await
            .expect("in-memory database should connect");
        db.execute_unprepared(
            "CREATE TABLE games (\
                id INTEGER PRIMARY KEY, id_type TEXT NOT NULL, date TEXT, localpath TEXT, \
                executable TEXT, launch_type TEXT NOT NULL, steam_launch_id TEXT, savepath TEXT, \
                autosave INTEGER, maxbackups INTEGER, clear INTEGER, le_launch INTEGER, \
                magpie INTEGER, custom_data TEXT, user_rating REAL, created_at INTEGER, \
                updated_at INTEGER\
            )",
        )
        .await
        .expect("game table should be created");

        let game_id = 7485;
        db.execute_unprepared(&format!(
            "INSERT INTO games (id, id_type, launch_type) VALUES ({game_id}, 'local', 'local')"
        ))
        .await
        .expect("test game should be present in the database");

        let state = download_state();
        let generation = state.cache_generation(game_id).await;
        let game_cover_dir = test_cover_dir();
        let source_url = format!("http://{address}/cover.webp?revision=retry");
        let fetched_body = fetch_and_cache_cover(
            game_id,
            generation,
            &source_url,
            &game_cover_dir,
            &db,
            &state,
            test_no_proxy_http_client,
        )
        .await
        .expect("cloud cover should succeed after two connection failures");

        assert_eq!(fetched_body, response_body);
        let request_lines = server.join().expect("retry loopback server should finish");
        assert_eq!(
            request_lines,
            [
                "GET /cover.webp?revision=retry HTTP/1.1",
                "GET /cover.webp?revision=retry HTTP/1.1",
                "GET /cover.webp?revision=retry HTTP/1.1",
            ],
        );
        let cache_path = build_cache_path(&game_cover_dir, game_id, &source_url, "webp");
        assert_eq!(
            tokio::fs::read(&cache_path)
                .await
                .expect("successful retry should publish the response body"),
            response_body
        );
        assert_eq!(
            state
                .cached_cover_path(cloud_cover_cache_key(game_id, &source_url))
                .await,
            Some(cache_path)
        );

        db.close()
            .await
            .expect("in-memory game database should close");
        tokio::fs::remove_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be removed");
    }

    #[tokio::test]
    async fn invalidation_during_retry_wait_prevents_the_next_http_request() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .expect("test HTTP listener should bind to loopback");
        let address = listener
            .local_addr()
            .expect("test HTTP listener should expose its address");
        let (second_request_tx, second_request_rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let mut request_lines = Vec::new();
            for attempt in 0..2 {
                let (connection, _) = listener
                    .accept()
                    .expect("each initial retry should reach the loopback listener");
                let mut request = BufReader::new(
                    connection
                        .try_clone()
                        .expect("loopback connection should be cloneable"),
                );
                let mut request_line = String::new();
                request
                    .read_line(&mut request_line)
                    .expect("HTTP request line should be readable");
                loop {
                    let mut header = String::new();
                    request
                        .read_line(&mut header)
                        .expect("HTTP request headers should be readable");
                    if header == "\r\n" || header.is_empty() {
                        break;
                    }
                }
                request_lines.push(request_line.trim_end().to_string());
                drop(connection);
                if attempt == 1 {
                    second_request_tx
                        .send(())
                        .expect("test should still wait for the second failed request");
                }
            }

            listener
                .set_nonblocking(true)
                .expect("listener should accept a bounded check for another retry");
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1250);
            while std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((connection, _)) => {
                        let mut request = BufReader::new(connection);
                        let mut request_line = String::new();
                        request
                            .read_line(&mut request_line)
                            .expect("additional HTTP request line should be readable");
                        request_lines.push(request_line.trim_end().to_string());
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
            request_lines
        });

        let mut options = ConnectOptions::new("sqlite::memory:");
        options.max_connections(1);
        let db = Database::connect(options)
            .await
            .expect("in-memory game database should connect");
        db.execute_unprepared(
            "CREATE TABLE games (\
                id INTEGER PRIMARY KEY, id_type TEXT NOT NULL, date TEXT, localpath TEXT, \
                executable TEXT, launch_type TEXT NOT NULL, steam_launch_id TEXT, savepath TEXT, \
                autosave INTEGER, maxbackups INTEGER, clear INTEGER, le_launch INTEGER, \
                magpie INTEGER, custom_data TEXT, user_rating REAL, created_at INTEGER, \
                updated_at INTEGER\
            )",
        )
        .await
        .expect("game table should be created");

        let game_id = 7487;
        db.execute_unprepared(&format!(
            "INSERT INTO games (id, id_type, launch_type) VALUES ({game_id}, 'local', 'local')"
        ))
        .await
        .expect("test game should be present in the database");

        let state = Arc::new(download_state());
        let generation = state.cache_generation(game_id).await;
        let game_cover_dir = test_cover_dir();
        let source_url = format!("http://{address}/cover.webp?revision=invalidated-retry");
        let fetch_state = Arc::clone(&state);
        let fetch_cover_dir = game_cover_dir.clone();
        let fetch_source_url = source_url.clone();
        let fetch_db = db.clone();
        let fetch = tokio::spawn(async move {
            fetch_and_cache_cover(
                game_id,
                generation,
                &fetch_source_url,
                &fetch_cover_dir,
                &fetch_db,
                &fetch_state,
                test_no_proxy_http_client,
            )
            .await
        });

        tokio::task::spawn_blocking(move || {
            second_request_rx
                .recv_timeout(std::time::Duration::from_secs(3))
                .expect("second retry should be observed before invalidation");
        })
        .await
        .expect("loopback request signal task should finish");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        invalidate_cloud_cover_cache(&state, game_id, &game_cover_dir)
            .await
            .expect("cache invalidation should advance the current generation");
        let result = tokio::time::timeout(std::time::Duration::from_millis(750), fetch)
            .await
            .expect("generation change should cancel the remaining backoff")
            .expect("fetch owner task should finish");
        assert!(matches!(result, Err(super::CoverDownloadError::Stale(_))));

        let request_lines = tokio::task::spawn_blocking(move || {
            server.join().expect("loopback server thread should finish")
        })
        .await
        .expect("loopback server join task should finish");
        assert_eq!(
            request_lines,
            [
                "GET /cover.webp?revision=invalidated-retry HTTP/1.1",
                "GET /cover.webp?revision=invalidated-retry HTTP/1.1",
            ]
        );
        assert_eq!(
            state
                .cached_cover_path(cloud_cover_cache_key(game_id, &source_url))
                .await,
            None
        );
        let mut entries = tokio::fs::read_dir(&game_cover_dir)
            .await
            .expect("the invalidated cache directory should remain readable");
        assert!(
            entries
                .next_entry()
                .await
                .expect("invalidated cache directory should be readable")
                .is_none()
        );

        db.close()
            .await
            .expect("in-memory game database should close");
        tokio::fs::remove_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be removed");
    }

    #[tokio::test]
    async fn cloud_cover_fetch_retries_truncated_response_bodies_before_publishing() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .expect("test HTTP listener should bind to loopback");
        listener
            .set_nonblocking(true)
            .expect("test HTTP listener should accept with a bounded wait");
        let address = listener
            .local_addr()
            .expect("test HTTP listener should expose its address");
        let response_body = b"complete cover after body retry".to_vec();
        let server_body = response_body.clone();
        let server = thread::spawn(move || {
            let mut request_lines = Vec::new();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while request_lines.len() < 3 && std::time::Instant::now() < deadline {
                let (mut connection, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                    Err(error) => panic!("loopback listener should accept requests: {error}"),
                };
                connection
                    .set_nonblocking(false)
                    .expect("accepted HTTP connection should use blocking reads");
                let mut request = BufReader::new(
                    connection
                        .try_clone()
                        .expect("loopback connection should be cloneable"),
                );
                let mut request_line = String::new();
                request
                    .read_line(&mut request_line)
                    .expect("HTTP request line should be readable");
                loop {
                    let mut header = String::new();
                    request
                        .read_line(&mut header)
                        .expect("HTTP request headers should be readable");
                    if header == "\r\n" || header.is_empty() {
                        break;
                    }
                }
                request_lines.push(request_line.trim_end().to_string());

                if request_lines.len() < 3 {
                    connection
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: image/webp\r\nContent-Length: 1000\r\nConnection: close\r\n\r\npartial",
                        )
                        .expect("truncated response should reach the client");
                    drop(connection);
                    continue;
                }

                let response_headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: image/webp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    server_body.len()
                );
                connection
                    .write_all(response_headers.as_bytes())
                    .expect("successful response headers should be writable");
                connection
                    .write_all(&server_body)
                    .expect("successful response body should be writable");
            }
            request_lines
        });

        let mut options = ConnectOptions::new("sqlite::memory:");
        options.max_connections(1);
        let db = Database::connect(options)
            .await
            .expect("in-memory database should connect");
        db.execute_unprepared(
            "CREATE TABLE games (\
                id INTEGER PRIMARY KEY, id_type TEXT NOT NULL, date TEXT, localpath TEXT, \
                executable TEXT, launch_type TEXT NOT NULL, steam_launch_id TEXT, savepath TEXT, \
                autosave INTEGER, maxbackups INTEGER, clear INTEGER, le_launch INTEGER, \
                magpie INTEGER, custom_data TEXT, user_rating REAL, created_at INTEGER, \
                updated_at INTEGER\
            )",
        )
        .await
        .expect("game table should be created");

        let game_id = 7486;
        db.execute_unprepared(&format!(
            "INSERT INTO games (id, id_type, launch_type) VALUES ({game_id}, 'local', 'local')"
        ))
        .await
        .expect("test game should be present in the database");

        let state = download_state();
        let generation = state.cache_generation(game_id).await;
        let game_cover_dir = test_cover_dir();
        let source_url = format!("http://{address}/cover.webp?revision=truncated-retry");
        let fetch_result = fetch_and_cache_cover(
            game_id,
            generation,
            &source_url,
            &game_cover_dir,
            &db,
            &state,
            test_no_proxy_http_client,
        )
        .await;
        let request_lines = server.join().expect("retry loopback server should finish");
        let fetched_body =
            fetch_result.expect("truncated response bodies should retry before succeeding");

        assert_eq!(fetched_body, response_body);
        assert_eq!(
            request_lines,
            [
                "GET /cover.webp?revision=truncated-retry HTTP/1.1",
                "GET /cover.webp?revision=truncated-retry HTTP/1.1",
                "GET /cover.webp?revision=truncated-retry HTTP/1.1",
            ],
        );
        let cache_path = build_cache_path(&game_cover_dir, game_id, &source_url, "webp");
        assert_eq!(
            tokio::fs::read(&cache_path)
                .await
                .expect("only the complete successful body should be cached"),
            response_body
        );
        assert_eq!(
            state
                .cached_cover_path(cloud_cover_cache_key(game_id, &source_url))
                .await,
            Some(cache_path)
        );

        db.close()
            .await
            .expect("in-memory game database should close");
        tokio::fs::remove_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be removed");
    }

    #[tokio::test]
    async fn transient_cover_request_error_keeps_stage_and_removes_signed_url() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .expect("test HTTP listener should bind to loopback");
        let address = listener
            .local_addr()
            .expect("test HTTP listener should expose its address");
        let server = thread::spawn(move || {
            let (connection, _) = listener
                .accept()
                .expect("test HTTP request should reach loopback listener");
            drop(connection);
        });
        let signed_url = format!("http://{address}/cover.webp?token=private-value");
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("test HTTP client should build");
        let error = client
            .get(&signed_url)
            .send()
            .await
            .expect_err("closing the loopback connection should fail the request");
        server
            .join()
            .expect("test HTTP listener thread should finish");

        let raw_error = error.to_string();
        assert!(raw_error.contains(&signed_url));

        let CoverDownloadError::Retryable(message) =
            classify_cover_request_error("发起请求失败", error)
        else {
            panic!("connection failures should remain retryable");
        };
        assert!(message.starts_with("发起请求失败:"));
        assert!(!message.contains("private-value"));
        assert!(!message.contains(&signed_url));
    }

    #[tokio::test]
    async fn invalid_cover_request_is_non_retryable_and_keeps_stage_without_url() {
        let error = reqwest::Client::new()
            .get("not a valid URL")
            .send()
            .await
            .expect_err("invalid URLs should fail before a network request");

        let CoverDownloadError::NonRetryableRequest(message) =
            classify_cover_request_error("发起请求失败", error)
        else {
            panic!("invalid request construction should fail without retry");
        };
        assert!(message.starts_with("发起请求失败:"));
        assert!(!message.contains("not a valid URL"));
    }

    #[tokio::test]
    async fn cache_invalidation_removes_cloud_files_and_rejects_an_old_download() {
        let state = download_state();
        let game_id = 7482;
        let cloud_url = "https://cdn.example.test/covers/game.jpg?rev=1";
        let game_cover_dir = test_cover_dir();
        tokio::fs::create_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be created");

        let cloud_cache = build_cache_path(&game_cover_dir, game_id, cloud_url, "jpg");
        let legacy_cache = game_cover_dir.join(format!("cloud_cover_{game_id}.jpg"));
        let custom_cover = game_cover_dir.join(format!("cover_{game_id}_custom.png"));
        tokio::fs::write(&cloud_cache, b"old cloud cover")
            .await
            .expect("cloud cache should be created");
        tokio::fs::write(&legacy_cache, b"legacy cloud cover")
            .await
            .expect("legacy cache should be created");
        tokio::fs::write(&custom_cover, b"custom cover")
            .await
            .expect("custom cover should be created");
        let cache_key = cloud_cover_cache_key(game_id, cloud_url);
        state
            .remember_cover_path(cache_key, cloud_cache.clone())
            .await;
        let old_generation = state.cache_generation(game_id).await;

        invalidate_cloud_cover_cache(&state, game_id, &game_cover_dir)
            .await
            .expect("cloud cache invalidation should succeed");

        assert_eq!(state.cache_generation(game_id).await, old_generation + 1);
        assert!(!cloud_cache.exists());
        assert!(!legacy_cache.exists());
        assert!(custom_cover.exists());
        assert!(state.cached_cover_path(cache_key).await.is_none());

        let temp_cache = build_temp_cache_path(&game_cover_dir, game_id, cloud_url, "jpg");
        let result = state
            .publish_cache_file_if_current(
                cache_key,
                old_generation,
                &temp_cache,
                &cloud_cache,
                b"late old response",
            )
            .await;

        assert!(matches!(result, Err(CachePublishError::Stale)));
        assert!(!cloud_cache.exists());
        assert!(!temp_cache.exists());

        tokio::fs::remove_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be removed");
    }

    #[tokio::test]
    async fn stale_download_waiting_on_cache_mutation_cannot_replace_new_generation_file() {
        let state = Arc::new(download_state());
        let game_id = 7483;
        let cloud_url = "https://cdn.example.test/covers/game.jpg";
        let game_cover_dir = test_cover_dir();
        tokio::fs::create_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be created");

        let old_generation = state.cache_generation(game_id).await;
        let cache_path = build_cache_path(&game_cover_dir, game_id, cloud_url, "jpg");
        let temp_path = build_temp_cache_path(&game_cover_dir, game_id, cloud_url, "jpg");
        tokio::fs::write(&cache_path, b"new generation")
            .await
            .expect("new generation cache should be created");

        let mutation_lock = state.cache_mutation_lock(game_id);
        let mutation_guard = mutation_lock.lock().await;
        let writer_state = Arc::clone(&state);
        let writer_cache_path = cache_path.clone();
        let writer_temp_path = temp_path.clone();
        let writer = tokio::spawn(async move {
            writer_state
                .publish_cache_file_if_current(
                    cloud_cover_cache_key(game_id, cloud_url),
                    old_generation,
                    &writer_temp_path,
                    &writer_cache_path,
                    b"stale generation",
                )
                .await
        });

        tokio::task::yield_now().await;
        assert!(!writer.is_finished());
        state.bump_cache_generation(game_id).await;
        drop(mutation_guard);

        let result = writer.await.expect("cache publisher task should complete");
        assert!(matches!(result, Err(CachePublishError::Stale)));
        assert_eq!(
            tokio::fs::read(&cache_path)
                .await
                .expect("new generation cache should remain readable"),
            b"new generation"
        );
        assert!(!temp_path.exists());

        tokio::fs::remove_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be removed");
    }

    #[tokio::test]
    async fn current_generation_download_is_published_to_its_url_cache() {
        let state = download_state();
        let game_id = 7484;
        let cloud_url = "https://cdn.example.test/covers/game.webp";
        let game_cover_dir = test_cover_dir();
        tokio::fs::create_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be created");

        let generation = state.cache_generation(game_id).await;
        let cache_path = build_cache_path(&game_cover_dir, game_id, cloud_url, "webp");
        let temp_path = build_temp_cache_path(&game_cover_dir, game_id, cloud_url, "webp");
        state
            .publish_cache_file_if_current(
                cloud_cover_cache_key(game_id, cloud_url),
                generation,
                &temp_path,
                &cache_path,
                b"current cover bytes",
            )
            .await
            .expect("current download should publish its cache");

        assert!(!temp_path.exists());
        assert_eq!(
            tokio::fs::read(&cache_path)
                .await
                .expect("published cache should be readable"),
            b"current cover bytes"
        );
        assert_eq!(
            state
                .cached_cover_path(cloud_cover_cache_key(game_id, cloud_url))
                .await,
            Some(cache_path)
        );

        tokio::fs::remove_dir_all(&game_cover_dir)
            .await
            .expect("test cover directory should be removed");
    }
}
