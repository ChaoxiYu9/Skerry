//! Skerry-owned persistence rules for the game library.

use super::current_database_timestamp;
use super::game_import_repository::{GAME_IDENTITY_SOURCES, GameImportRepository};
use super::game_query_repository::GameQueryRepository;
use super::game_sources_repository::GameSourcesRepository;
use crate::database::dto::{
    BatchOperationError, BatchOperationResult, FullGameData, InsertGameData, UpdateGameData,
    UpsertGameSourceData,
};
use crate::entity::games;
use crate::entity::prelude::*;
use crate::entity::user;
use sea_orm::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

/// Game list filters and order are part of the Tauri command contract.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortOption {
    Addtime,
    Datetime,
    LastPlayed,
    BGMRank,
    VNDBRank,
    UserRatingRank,
    Namesort,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortOrder {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameType {
    All,
    Local,
    Online,
    IsCustom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ToolLaunchDefaults {
    pub le_launch: bool,
    pub magpie: bool,
}

pub struct GamesRepository;

// Persisted compatibility values: play status 1 means WISH, and enabled tool flags are stored as 1.
const DEFAULT_PLAY_STATUS_WISH: i32 = 1;
const ENABLED_TOOL_SETTING: i32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ImportIdentity {
    Provider(String, String),
    Steam(String),
}

struct ExistingImportIdentities(BTreeSet<ImportIdentity>);

impl ExistingImportIdentities {
    async fn load<C: ConnectionTrait>(db: &C) -> Result<Self, DbErr> {
        let mut identities = BTreeSet::new();
        for (source, external_id) in GameImportRepository::get_all_source_identities(db).await? {
            identities.insert(ImportIdentity::Provider(source, external_id));
        }
        for steam_id in GameImportRepository::get_all_steam_launch_ids(db).await? {
            if let Ok(normalized) = normalize_steam_launch_id(&steam_id) {
                identities.insert(ImportIdentity::Steam(normalized));
            }
        }
        Ok(Self(identities))
    }

    fn overlaps(&self, game: &InsertGameData) -> bool {
        import_identities(game)
            .iter()
            .any(|identity| self.0.contains(identity))
    }

    fn include(&mut self, game: &InsertGameData) {
        self.0.extend(import_identities(game));
    }
}

fn import_identities(game: &InsertGameData) -> BTreeSet<ImportIdentity> {
    let mut identities = game
        .sources
        .iter()
        .filter(|source| GAME_IDENTITY_SOURCES.contains(&source.source.as_str()))
        .filter_map(|source| {
            source
                .external_id
                .as_ref()
                .filter(|id| !id.is_empty())
                .map(|id| ImportIdentity::Provider(source.source.clone(), id.clone()))
        })
        .collect::<BTreeSet<_>>();
    if let Some(steam_id) = game.steam_launch_id.as_deref()
        && let Ok(normalized) = normalize_steam_launch_id(steam_id)
    {
        identities.insert(ImportIdentity::Steam(normalized));
    }
    identities
}

fn normalize_steam_launch_id(value: &str) -> Result<String, DbErr> {
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(DbErr::Custom(
            "steam_launch_id 必须是 u64 范围内的十进制字符串".to_string(),
        ));
    }
    let id = value.parse::<u64>().map_err(|_| {
        DbErr::Custom("steam_launch_id 必须是 u64 范围内的十进制字符串".to_string())
    })?;
    if id == 0 {
        return Err(DbErr::Custom("steam_launch_id 必须大于 0".to_string()));
    }
    Ok(id.to_string())
}

fn validate_path(path: Option<&str>, executable: Option<&str>) -> Result<(), DbErr> {
    if path.is_none() && executable.is_some() {
        return Err(DbErr::Custom(
            "executable 不能在 localpath 为空时单独存在".to_string(),
        ));
    }
    if let Some(executable) = executable {
        let is_file_name = Path::new(executable)
            .file_name()
            .is_some_and(|name| name.to_str() == Some(executable))
            && !executable.contains(['/', '\\']);
        if !is_file_name {
            return Err(DbErr::Custom(
                "executable 必须是单个文件名，不能包含路径".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_launch(launch_type: &str, steam_id: Option<&str>) -> Result<(), DbErr> {
    match (launch_type, steam_id.is_some()) {
        ("local", false) | ("steam", true) => Ok(()),
        ("local", true) => Err(DbErr::Custom(
            "本地启动不能保留 steam_launch_id".to_string(),
        )),
        ("steam", false) => Err(DbErr::Custom(
            "Steam 启动必须提供 steam_launch_id".to_string(),
        )),
        _ => Err(DbErr::Custom(
            "launch_type 只能是 local 或 steam".to_string(),
        )),
    }
}

fn launch_defaults(settings: Option<user::Model>) -> ToolLaunchDefaults {
    settings.map_or_else(ToolLaunchDefaults::default, |settings| ToolLaunchDefaults {
        le_launch: settings.default_le_launch,
        magpie: settings.default_magpie,
    })
}

fn new_game_model(
    game: InsertGameData,
    now: i32,
    defaults: ToolLaunchDefaults,
) -> games::ActiveModel {
    games::ActiveModel {
        id: NotSet,
        id_type: Set(game.id_type),
        date: Set(game.date),
        localpath: Set(game.localpath),
        executable: Set(game.executable),
        launch_type: Set(game.launch_type),
        steam_launch_id: Set(game.steam_launch_id),
        savepath: Set(game.savepath),
        autosave: game.autosave.map_or(NotSet, |value| Set(Some(value))),
        maxbackups: game.maxbackups.map_or(NotSet, |value| Set(Some(value))),
        clear: Set(Some(game.clear.unwrap_or(DEFAULT_PLAY_STATUS_WISH))),
        le_launch: game.le_launch.map_or_else(
            || {
                defaults
                    .le_launch
                    .then_some(ENABLED_TOOL_SETTING)
                    .map_or(NotSet, |value| Set(Some(value)))
            },
            |value| Set(Some(value)),
        ),
        magpie: game.magpie.map_or_else(
            || {
                defaults
                    .magpie
                    .then_some(ENABLED_TOOL_SETTING)
                    .map_or(NotSet, |value| Set(Some(value)))
            },
            |value| Set(Some(value)),
        ),
        custom_data: Set(game.custom_data),
        user_rating: NotSet,
        created_at: Set(Some(now)),
        updated_at: Set(Some(now)),
    }
}

async fn insert_game_in<C: ConnectionTrait>(
    db: &C,
    mut game: InsertGameData,
    now: i32,
    defaults: ToolLaunchDefaults,
) -> Result<FullGameData, DbErr> {
    game = game.cleaned();
    GameSourcesRepository::validate_source_changes(&game.sources, &[])?;
    validate_path(game.localpath.as_deref(), game.executable.as_deref())?;

    let steam_id = game
        .steam_launch_id
        .as_deref()
        .map(normalize_steam_launch_id)
        .transpose()?;
    validate_launch(&game.launch_type, steam_id.as_deref())?;
    game.steam_launch_id = steam_id;
    GameSourcesRepository::normalize_insert_date(&mut game);

    let inserted = new_game_model(game.clone(), now, defaults)
        .insert(db)
        .await?;
    GameSourcesRepository::upsert_sources(db, inserted.id, &game.sources).await?;
    GameQueryRepository::find_full_by_id(db, inserted.id)
        .await?
        .ok_or_else(|| {
            DbErr::RecordNotFound(format!("game {} not found after insert", inserted.id))
        })
}

fn updated_game_model(
    game_id: i32,
    updates: UpdateGameData,
    now: i32,
) -> (
    games::ActiveModel,
    Option<Vec<UpsertGameSourceData>>,
    Option<Vec<String>>,
) {
    let UpdateGameData {
        id_type,
        date,
        localpath,
        executable,
        launch_type,
        steam_launch_id,
        savepath,
        autosave,
        maxbackups,
        clear,
        le_launch,
        magpie,
        custom_data,
        upsert_sources,
        remove_sources,
    } = updates;
    (
        games::ActiveModel {
            id: Set(game_id),
            id_type: id_type.map_or(NotSet, Set),
            date: date.map_or(NotSet, Set),
            localpath: localpath.map_or(NotSet, Set),
            executable: executable.map_or(NotSet, Set),
            launch_type: launch_type.map_or(NotSet, Set),
            steam_launch_id: steam_launch_id.map_or(NotSet, Set),
            savepath: savepath.map_or(NotSet, Set),
            autosave: autosave.map_or(NotSet, Set),
            maxbackups: maxbackups.map_or(NotSet, Set),
            clear: clear.map_or(NotSet, Set),
            le_launch: le_launch.map_or(NotSet, Set),
            magpie: magpie.map_or(NotSet, Set),
            custom_data: custom_data.map_or(NotSet, Set),
            user_rating: NotSet,
            updated_at: Set(Some(now)),
            ..Default::default()
        },
        upsert_sources,
        remove_sources,
    )
}

async fn update_game_in<C: ConnectionTrait>(
    db: &C,
    game_id: i32,
    updates: UpdateGameData,
    now: i32,
) -> Result<FullGameData, DbErr> {
    let updates = updates.cleaned();
    GameSourcesRepository::validate_source_changes(
        updates.upsert_sources.as_deref().unwrap_or_default(),
        updates.remove_sources.as_deref().unwrap_or_default(),
    )?;
    let updates = GameSourcesRepository::normalize_update_sources(db, game_id, updates).await?;

    let validates_path = updates.localpath.is_some() || updates.executable.is_some();
    let validates_launch = updates.launch_type.is_some() || updates.steam_launch_id.is_some();
    let current = if validates_path || validates_launch {
        Some(
            Games::find_by_id(game_id)
                .one(db)
                .await?
                .ok_or_else(|| DbErr::RecordNotFound(format!("game {game_id} not found")))?,
        )
    } else {
        None
    };

    let mut updates = updates;
    if matches!(updates.localpath, Some(None)) {
        updates.executable = Some(None);
    }
    if updates.launch_type.as_deref() == Some("local") {
        updates.steam_launch_id = Some(None);
    } else if let Some(Some(steam_id)) = updates.steam_launch_id.as_mut() {
        *steam_id = normalize_steam_launch_id(steam_id)?;
    }

    if validates_path {
        let current = current.as_ref().expect("path state loaded");
        let final_localpath = updates
            .localpath
            .as_ref()
            .map_or(current.localpath.as_deref(), Option::as_deref);
        let final_executable = updates
            .executable
            .as_ref()
            .map_or(current.executable.as_deref(), Option::as_deref);
        validate_path(final_localpath, final_executable)?;
    }
    if validates_launch {
        let current = current.as_ref().expect("launch state loaded");
        let final_launch_type = updates
            .launch_type
            .as_deref()
            .unwrap_or(&current.launch_type);
        let final_steam_id = updates
            .steam_launch_id
            .as_ref()
            .map_or(current.steam_launch_id.as_deref(), Option::as_deref);
        validate_launch(final_launch_type, final_steam_id)?;
    }

    let (game_patch, upsert_sources, remove_sources) = updated_game_model(game_id, updates, now);
    game_patch.update(db).await?;
    GameSourcesRepository::remove_sources(
        db,
        game_id,
        remove_sources.as_deref().unwrap_or_default(),
    )
    .await?;
    GameSourcesRepository::upsert_sources(
        db,
        game_id,
        upsert_sources.as_deref().unwrap_or_default(),
    )
    .await?;
    GameQueryRepository::find_full_by_id(db, game_id)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("game {game_id} not found after update")))
}

fn failed_batch(total: usize, message: String) -> BatchOperationResult {
    BatchOperationResult {
        total,
        success: 0,
        failed: total,
        ids: Vec::new(),
        games: Vec::new(),
        duplicate_indices: Vec::new(),
        errors: (0..total)
            .map(|index| BatchOperationError {
                index,
                message: message.clone(),
            })
            .collect(),
    }
}

fn batch_result(
    total: usize,
    ids: Vec<i32>,
    games: Vec<FullGameData>,
    duplicate_indices: Vec<usize>,
    errors: Vec<BatchOperationError>,
) -> BatchOperationResult {
    BatchOperationResult {
        total,
        success: ids.len(),
        failed: errors.len(),
        ids,
        games,
        duplicate_indices,
        errors,
    }
}

impl GamesRepository {
    pub async fn insert(
        db: &DatabaseConnection,
        game: InsertGameData,
    ) -> Result<FullGameData, DbErr> {
        let transaction = db.begin().await?;
        let defaults = launch_defaults(User::find_by_id(1).one(&transaction).await?);
        let inserted =
            insert_game_in(&transaction, game, current_database_timestamp()?, defaults).await?;
        transaction.commit().await?;
        Ok(inserted)
    }

    pub async fn insert_batch(
        db: &DatabaseConnection,
        games: Vec<InsertGameData>,
    ) -> BatchOperationResult {
        let total = games.len();
        let transaction = match db.begin().await {
            Ok(transaction) => transaction,
            Err(error) => return failed_batch(total, error.to_string()),
        };
        let defaults = match User::find_by_id(1).one(&transaction).await {
            Ok(settings) => launch_defaults(settings),
            Err(error) => return failed_batch(total, error.to_string()),
        };
        let mut identities = match ExistingImportIdentities::load(&transaction).await {
            Ok(identities) => identities,
            Err(error) => return failed_batch(total, error.to_string()),
        };
        let now = match current_database_timestamp() {
            Ok(now) => now,
            Err(error) => return failed_batch(total, error.to_string()),
        };
        let mut ids = Vec::with_capacity(total);
        let mut inserted_games = Vec::with_capacity(total);
        let mut duplicate_indices = Vec::new();
        let mut errors = Vec::new();

        for (index, game) in games.into_iter().enumerate() {
            let game = game.cleaned();
            if identities.overlaps(&game) {
                duplicate_indices.push(index);
                continue;
            }
            let item = match transaction.begin().await {
                Ok(item) => item,
                Err(error) => {
                    errors.push(BatchOperationError {
                        index,
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            match insert_game_in(&item, game.clone(), now, defaults).await {
                Ok(inserted) => match item.commit().await {
                    Ok(()) => {
                        identities.include(&game);
                        ids.push(inserted.id);
                        inserted_games.push(inserted);
                    }
                    Err(error) => errors.push(BatchOperationError {
                        index,
                        message: error.to_string(),
                    }),
                },
                Err(error) => {
                    let message = error.to_string();
                    if let Err(rollback_error) = item.rollback().await {
                        errors.push(BatchOperationError {
                            index,
                            message: format!("{message}; 单项回滚失败: {rollback_error}"),
                        });
                    } else {
                        errors.push(BatchOperationError { index, message });
                    }
                }
            }
        }

        if let Err(error) = transaction.commit().await {
            let mut result = failed_batch(total, error.to_string());
            result.duplicate_indices = duplicate_indices;
            result.failed = total - result.duplicate_indices.len();
            result
                .errors
                .retain(|item| !result.duplicate_indices.contains(&item.index));
            return result;
        }
        batch_result(total, ids, inserted_games, duplicate_indices, errors)
    }

    pub async fn update(
        db: &DatabaseConnection,
        game_id: i32,
        updates: UpdateGameData,
    ) -> Result<FullGameData, DbErr> {
        let transaction = db.begin().await?;
        let updated = update_game_in(
            &transaction,
            game_id,
            updates,
            current_database_timestamp()?,
        )
        .await?;
        transaction.commit().await?;
        Ok(updated)
    }

    pub async fn update_batch(
        db: &DatabaseConnection,
        updates: Vec<(i32, UpdateGameData)>,
    ) -> Result<Vec<FullGameData>, DbErr> {
        if updates.is_empty() {
            return Ok(Vec::new());
        }
        let transaction = db.begin().await?;
        let now = current_database_timestamp()?;
        let mut games = Vec::with_capacity(updates.len());
        for (game_id, patch) in updates {
            games.push(update_game_in(&transaction, game_id, patch, now).await?);
        }
        transaction.commit().await?;
        Ok(games)
    }

    pub async fn delete(db: &DatabaseConnection, id: i32) -> Result<DeleteResult, DbErr> {
        Games::delete_by_id(id).exec(db).await
    }

    pub async fn delete_many(
        db: &DatabaseConnection,
        ids: Vec<i32>,
    ) -> Result<DeleteResult, DbErr> {
        Games::delete_many()
            .filter(games::Column::Id.is_in(ids))
            .exec(db)
            .await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::dto::UpsertGameSourceData;
    use crate::database::repository::game_query_repository::GameQueryRepository;
    use crate::entity::custom_data::CustomData;
    use crate::entity::game_statistics;
    use sea_orm::Database;
    use serde_json::json;

    async fn setup_database() -> DatabaseConnection {
        let database = Database::connect("sqlite::memory:").await.unwrap();
        database
            .execute_unprepared(
                r#"
                PRAGMA foreign_keys = ON;
                CREATE TABLE user (
                    id INTEGER PRIMARY KEY,
                    bgm_auth TEXT,
                    hikarinagi_auth TEXT,
                    kungal_auth TEXT,
                    vndb_token TEXT,
                    save_root_path TEXT,
                    db_backup_path TEXT,
                    le_path TEXT,
                    magpie_path TEXT,
                    detail_backdrop_path TEXT,
                    default_le_launch INTEGER NOT NULL DEFAULT 0,
                    default_magpie INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE games (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    id_type TEXT NOT NULL,
                    date TEXT,
                    localpath TEXT,
                    executable TEXT,
                    launch_type TEXT NOT NULL DEFAULT 'local'
                        CHECK (launch_type IN ('local', 'steam')),
                    steam_launch_id TEXT
                        CHECK (
                            (launch_type = 'local' AND steam_launch_id IS NULL)
                            OR (launch_type = 'steam' AND steam_launch_id IS NOT NULL)
                        ),
                    savepath TEXT,
                    autosave INTEGER DEFAULT 0,
                    maxbackups INTEGER DEFAULT 20,
                    clear INTEGER,
                    le_launch INTEGER DEFAULT 0,
                    magpie INTEGER DEFAULT 0,
                    custom_data TEXT,
                    user_rating REAL GENERATED ALWAYS AS (
                        CAST(json_extract(custom_data, '$.user_rating') AS REAL)
                    ) VIRTUAL,
                    created_at INTEGER,
                    updated_at INTEGER
                );
                CREATE TABLE game_sources (
                    game_id INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    external_id TEXT,
                    data TEXT,
                    score REAL GENERATED ALWAYS AS (
                        CAST(json_extract(data, '$.score') AS REAL)
                    ) VIRTUAL,
                    rank INTEGER GENERATED ALWAYS AS (
                        CAST(json_extract(data, '$.rank') AS INTEGER)
                    ) VIRTUAL,
                    PRIMARY KEY (game_id, source),
                    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
                    CHECK (external_id IS NOT NULL OR data IS NOT NULL),
                    CHECK (data IS NULL OR json_valid(data))
                );
                CREATE TABLE game_statistics (
                    game_id INTEGER PRIMARY KEY,
                    total_time INTEGER NOT NULL DEFAULT 0,
                    session_count INTEGER NOT NULL DEFAULT 0,
                    last_played INTEGER,
                    daily_stats TEXT,
                    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
                );
                CREATE TABLE savedata (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_id INTEGER NOT NULL,
                    file TEXT NOT NULL,
                    backup_time INTEGER NOT NULL,
                    file_size INTEGER NOT NULL,
                    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
                );
                "#,
            )
            .await
            .unwrap();
        database
    }

    fn insert_data(
        id_type: &str,
        custom_data: Option<CustomData>,
        sources: Vec<UpsertGameSourceData>,
    ) -> InsertGameData {
        InsertGameData {
            id_type: id_type.to_string(),
            date: None,
            localpath: None,
            executable: None,
            launch_type: "local".to_string(),
            steam_launch_id: None,
            savepath: None,
            autosave: None,
            maxbackups: None,
            clear: None,
            le_launch: None,
            magpie: None,
            custom_data,
            sources,
        }
    }

    fn source(source: &str, id: &str, data: serde_json::Value) -> UpsertGameSourceData {
        UpsertGameSourceData {
            source: source.to_string(),
            external_id: Some(id.to_string()),
            data: Some(data),
        }
    }

    #[tokio::test]
    async fn insert_and_batch_use_database_defaults() {
        let database = setup_database().await;

        let defaulted = GamesRepository::insert(&database, insert_data("custom", None, Vec::new()))
            .await
            .unwrap();
        assert_eq!(defaulted.autosave, Some(0));
        assert_eq!(defaulted.maxbackups, Some(20));
        assert_eq!(defaulted.le_launch, Some(0));
        assert_eq!(defaulted.magpie, Some(0));
        assert_eq!(defaulted.launch_type, "local");
        assert_eq!(defaulted.steam_launch_id, None);

        let batch =
            GamesRepository::insert_batch(&database, vec![insert_data("custom", None, Vec::new())])
                .await;
        assert_eq!(batch.success, 1);
        assert_eq!(batch.failed, 0);
        assert_eq!(batch.games[0].autosave, Some(0));
        assert_eq!(batch.games[0].maxbackups, Some(20));
        assert_eq!(batch.games[0].le_launch, Some(0));
        assert_eq!(batch.games[0].magpie, Some(0));
        assert_eq!(batch.games[0].launch_type, "local");
    }

    #[tokio::test]
    async fn batch_marks_existing_and_first_seen_identities_as_duplicates() {
        let database = setup_database().await;
        GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                None,
                vec![source("bgm", "shared-id", serde_json::json!({}))],
            ),
        )
        .await
        .unwrap();
        let mut existing_steam = insert_data("custom", None, Vec::new());
        existing_steam.launch_type = "steam".to_string();
        existing_steam.steam_launch_id = Some("730".to_string());
        GamesRepository::insert(&database, existing_steam)
            .await
            .unwrap();

        let mut duplicate_steam = insert_data("custom", None, Vec::new());
        duplicate_steam.launch_type = "steam".to_string();
        duplicate_steam.steam_launch_id = Some("000730".to_string());

        let result = GamesRepository::insert_batch(
            &database,
            vec![
                insert_data(
                    "bgm",
                    None,
                    vec![source("bgm", "shared-id", serde_json::json!({}))],
                ),
                insert_data(
                    "mixed",
                    None,
                    vec![
                        source("bgm", "shared-id", serde_json::json!({})),
                        source("vndb", "shared-id", serde_json::json!({})),
                    ],
                ),
                insert_data(
                    "vndb",
                    None,
                    vec![source("vndb", "shared-id", serde_json::json!({}))],
                ),
                duplicate_steam,
                insert_data(
                    "vndb",
                    None,
                    vec![source("vndb", "shared-id", serde_json::json!({}))],
                ),
                insert_data("custom", None, Vec::new()),
            ],
        )
        .await;

        assert_eq!(result.total, 6);
        assert_eq!(result.success, 2);
        assert_eq!(result.failed, 0);
        assert_eq!(result.duplicate_indices, vec![0, 1, 3, 4]);
        assert!(result.errors.is_empty());
        assert_eq!(result.games.len(), 2);
    }

    #[tokio::test]
    async fn failed_batch_item_does_not_claim_identity_from_later_valid_item() {
        let database = setup_database().await;
        let source_id = "retry-after-invalid";
        let mut invalid = insert_data(
            "bgm",
            None,
            vec![source("bgm", source_id, serde_json::json!({}))],
        );
        invalid.launch_type = "unsupported".to_string();
        let valid = insert_data(
            "bgm",
            None,
            vec![source("bgm", source_id, serde_json::json!({}))],
        );

        let result = GamesRepository::insert_batch(&database, vec![invalid, valid]).await;

        assert_eq!(result.total, 2);
        assert_eq!(result.success, 1);
        assert_eq!(result.failed, 1);
        assert_eq!(result.duplicate_indices, Vec::<usize>::new());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].index, 0);
        assert_eq!(result.games.len(), 1);
        assert_eq!(
            result.games[0].sources[0].external_id.as_deref(),
            Some(source_id)
        );
    }

    #[tokio::test]
    async fn overlapping_batches_recheck_identity_after_the_first_commit() {
        let database = setup_database().await;
        let candidate = insert_data(
            "bgm",
            None,
            vec![source("bgm", "concurrent-id", serde_json::json!({}))],
        );

        let (first, second) = tokio::join!(
            GamesRepository::insert_batch(&database, vec![candidate.clone()]),
            GamesRepository::insert_batch(&database, vec![candidate]),
        );

        assert_eq!(first.success + second.success, 1);
        assert_eq!(
            first.duplicate_indices.len() + second.duplicate_indices.len(),
            1
        );
        assert_eq!(first.failed + second.failed, 0);
    }

    #[tokio::test]
    async fn validates_normalizes_allows_shared_and_clears_steam_launch_state() {
        let database = setup_database().await;
        let mut steam = insert_data("custom", None, Vec::new());
        steam.launch_type = "steam".to_string();
        steam.steam_launch_id = Some(" 000730 ".to_string());

        let inserted = GamesRepository::insert(&database, steam).await.unwrap();
        assert_eq!(inserted.launch_type, "steam");
        assert_eq!(inserted.steam_launch_id.as_deref(), Some("730"));
        let mut duplicate = insert_data("custom", None, Vec::new());
        duplicate.launch_type = "steam".to_string();
        duplicate.steam_launch_id = Some("730".to_string());
        let duplicate = GamesRepository::insert(&database, duplicate).await.unwrap();
        assert_eq!(duplicate.steam_launch_id.as_deref(), Some("730"));

        let switched = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                launch_type: Some("local".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(switched.launch_type, "local");
        assert_eq!(switched.steam_launch_id, None);
    }

    #[tokio::test]
    async fn rejects_invalid_or_incomplete_steam_launch_state() {
        let database = setup_database().await;

        for invalid_id in ["0", "+42", "not-a-number", "18446744073709551616"] {
            let mut game = insert_data("custom", None, Vec::new());
            game.launch_type = "steam".to_string();
            game.steam_launch_id = Some(invalid_id.to_string());
            assert!(
                GamesRepository::insert(&database, game).await.is_err(),
                "{invalid_id}"
            );
        }

        let mut missing_id = insert_data("custom", None, Vec::new());
        missing_id.launch_type = "steam".to_string();
        assert!(
            GamesRepository::insert(&database, missing_id)
                .await
                .is_err()
        );

        let mut stale_id = insert_data("custom", None, Vec::new());
        stale_id.steam_launch_id = Some("730".to_string());
        assert!(GamesRepository::insert(&database, stale_id).await.is_err());

        let local = GamesRepository::insert(&database, insert_data("custom", None, Vec::new()))
            .await
            .unwrap();
        assert!(
            GamesRepository::update(
                &database,
                local.id,
                UpdateGameData {
                    launch_type: Some("steam".to_string()),
                    ..Default::default()
                },
            )
            .await
            .is_err()
        );
        assert!(
            GamesRepository::update(
                &database,
                local.id,
                UpdateGameData {
                    steam_launch_id: Some(Some("730".to_string())),
                    ..Default::default()
                },
            )
            .await
            .is_err()
        );
        assert!(
            GamesRepository::update(
                &database,
                local.id,
                UpdateGameData {
                    launch_type: Some("remote".to_string()),
                    ..Default::default()
                },
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn cleans_empty_source_metadata_before_insert_and_update() {
        let database = setup_database().await;
        let inserted = GamesRepository::insert(
            &database,
            insert_data(
                "vndb",
                None,
                vec![source(
                    "vndb",
                    "v1",
                    json!({
                        "name": "标题",
                        "tags": [],
                        "aliases": null,
                        "developer": "",
                        "nested": { "empty": [] },
                        "score": 0,
                        "nsfw": false
                    }),
                )],
            ),
        )
        .await
        .unwrap();

        assert_eq!(
            inserted.sources[0].data,
            Some(json!({
                "name": "标题",
                "score": 0,
                "nsfw": false
            }))
        );

        let updated = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                upsert_sources: Some(vec![source(
                    "vndb",
                    "v1",
                    json!({
                        "name": "新标题",
                        "all_titles": [],
                        "average_hours": null
                    }),
                )]),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(
            updated.sources[0].data,
            Some(json!({
                "name": "新标题"
            }))
        );
    }

    #[tokio::test]
    async fn writes_and_updates_game_aggregate_transactionally() {
        let database = setup_database().await;
        let inserted = GamesRepository::insert(
            &database,
            insert_data(
                "mixed",
                None,
                vec![
                    source("bgm", "1", json!({"name": "标题", "date": "2024-01-02"})),
                    source("vndb", "v1", json!({"name": "Title"})),
                ],
            ),
        )
        .await
        .unwrap();

        assert_eq!(inserted.date.as_deref(), Some("2024-01-02"));
        assert_eq!(inserted.sources.len(), 2);

        let updated = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                upsert_sources: Some(vec![source(
                    "bgm",
                    "1",
                    json!({"name": "新标题", "date": "2025-01-01"}),
                )]),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(updated.date.as_deref(), Some("2025-01-01"));
        assert_eq!(updated.sources.len(), 2);
        assert_eq!(
            updated
                .sources
                .iter()
                .find(|source| source.source == "bgm")
                .unwrap()
                .data
                .as_ref()
                .and_then(|data| data.get("name"))
                .and_then(|name| name.as_str()),
            Some("新标题")
        );

        let normalized = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                date: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(normalized.date.as_deref(), Some("2025-01-01"));

        let switched = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                id_type: Some("vndb".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(switched.id_type, "vndb");
        assert_eq!(switched.sources.len(), 2);

        let removed = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                remove_sources: Some(vec!["bgm".to_string()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(removed.date, None);
        assert_eq!(removed.sources.len(), 1);
    }

    #[tokio::test]
    async fn id_only_update_preserves_existing_source_identity_data_and_date() {
        let database = setup_database().await;
        let inserted = GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                None,
                vec![source(
                    "bgm",
                    "original-id",
                    json!({"name": "Original", "date": "2024-01-02"}),
                )],
            ),
        )
        .await
        .unwrap();

        let updated = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                upsert_sources: Some(vec![UpsertGameSourceData {
                    source: "bgm".to_string(),
                    external_id: Some("replacement-id".to_string()),
                    data: None,
                }]),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(updated.date.as_deref(), Some("2024-01-02"));
        let bgm = updated
            .sources
            .iter()
            .find(|source| source.source == "bgm")
            .unwrap();
        assert_eq!(bgm.external_id.as_deref(), Some("original-id"));
        assert_eq!(
            bgm.data,
            Some(json!({"name": "Original", "date": "2024-01-02"}))
        );
    }

    #[tokio::test]
    async fn batch_id_only_update_adds_a_missing_source_binding() {
        let database = setup_database().await;
        let inserted = GamesRepository::insert(&database, insert_data("custom", None, Vec::new()))
            .await
            .unwrap();

        let updated_games = GamesRepository::update_batch(
            &database,
            vec![(
                inserted.id,
                UpdateGameData {
                    upsert_sources: Some(vec![UpsertGameSourceData {
                        source: "bgm".to_string(),
                        external_id: Some("new-id".to_string()),
                        data: None,
                    }]),
                    ..Default::default()
                },
            )],
        )
        .await
        .unwrap();

        assert_eq!(updated_games.len(), 1);
        let updated = &updated_games[0];
        assert_eq!(updated.sources.len(), 1);
        assert_eq!(updated.sources[0].source, "bgm");
        assert_eq!(updated.sources[0].external_id.as_deref(), Some("new-id"));
        assert_eq!(updated.sources[0].data, None);
    }

    #[tokio::test]
    async fn preserves_split_path_fields_and_cascades_directory_clear() {
        let database = setup_database().await;
        let first_directory = Path::new("games")
            .join("first")
            .to_string_lossy()
            .to_string();
        let second_directory = Path::new("games")
            .join("second")
            .to_string_lossy()
            .to_string();
        let mut game = insert_data("custom", None, Vec::new());
        game.localpath = Some(first_directory);
        game.executable = Some("  game.exe  ".to_string());

        let inserted = GamesRepository::insert(&database, game).await.unwrap();
        assert_eq!(inserted.executable.as_deref(), Some("game.exe"));

        assert!(
            GamesRepository::update(
                &database,
                inserted.id,
                UpdateGameData {
                    executable: Some(Some("bin/game.exe".to_string())),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("单个文件名")
        );

        let moved = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                localpath: Some(Some(second_directory.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(moved.localpath.as_deref(), Some(second_directory.as_str()));
        assert_eq!(moved.executable.as_deref(), Some("game.exe"));

        let cleared = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                localpath: Some(None),
                executable: Some(Some("ignored.exe".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(cleared.localpath, None);
        assert_eq!(cleared.executable, None);
    }

    #[tokio::test]
    async fn updates_path_and_launch_fields_from_the_same_persisted_state() {
        let database = setup_database().await;
        let first_directory = Path::new("games")
            .join("first")
            .to_string_lossy()
            .to_string();
        let second_directory = Path::new("games")
            .join("second")
            .to_string_lossy()
            .to_string();
        let mut game = insert_data("custom", None, Vec::new());
        game.localpath = Some(first_directory);
        game.executable = Some("game.exe".to_string());
        let inserted = GamesRepository::insert(&database, game).await.unwrap();

        let updated = GamesRepository::update(
            &database,
            inserted.id,
            UpdateGameData {
                localpath: Some(Some(second_directory.clone())),
                launch_type: Some("steam".to_string()),
                steam_launch_id: Some(Some(" 000730 ".to_string())),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        assert_eq!(
            updated.localpath.as_deref(),
            Some(second_directory.as_str())
        );
        assert_eq!(updated.executable.as_deref(), Some("game.exe"));
        assert_eq!(updated.launch_type, "steam");
        assert_eq!(updated.steam_launch_id.as_deref(), Some("730"));
    }

    #[tokio::test]
    async fn rejects_orphan_and_non_basename_executables() {
        let database = setup_database().await;
        let mut orphan = insert_data("custom", None, Vec::new());
        orphan.executable = Some("game.exe".to_string());
        assert!(
            GamesRepository::insert(&database, orphan)
                .await
                .unwrap_err()
                .to_string()
                .contains("localpath")
        );

        for invalid in [".", "..", "bin/game.exe", r"bin\game.exe"] {
            let mut game = insert_data("custom", None, Vec::new());
            game.localpath = Some("games".to_string());
            game.executable = Some(invalid.to_string());
            assert!(
                GamesRepository::insert(&database, game)
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("单个文件名"),
                "{invalid}"
            );
        }
    }

    #[tokio::test]
    async fn directory_only_game_is_local_and_empty_executable_becomes_null() {
        let database = setup_database().await;
        let mut local = insert_data("custom", None, Vec::new());
        local.localpath = Some("games".to_string());
        local.executable = Some("   ".to_string());
        let inserted = GamesRepository::insert(&database, local).await.unwrap();
        assert_eq!(inserted.executable, None);

        let local_ids = GameQueryRepository::find_ids(
            &database,
            GameType::Local,
            SortOption::Addtime,
            SortOrder::Asc,
            None,
        )
        .await
        .unwrap();
        let online_ids = GameQueryRepository::find_ids(
            &database,
            GameType::Online,
            SortOption::Addtime,
            SortOrder::Asc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(local_ids, vec![inserted.id]);
        assert!(online_ids.is_empty());
    }

    #[tokio::test]
    async fn sorts_names_with_custom_override_and_stable_id_tie_breaker() {
        let database = setup_database().await;
        let first = GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                None,
                vec![source("bgm", "1", json!({"name": "Beta", "name_cn": "乙"}))],
            ),
        )
        .await
        .unwrap();
        let second = GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                Some(CustomData {
                    name: Some("Alpha".to_string()),
                    ..Default::default()
                }),
                vec![source("bgm", "2", json!({"name": "Zulu", "name_cn": "甲"}))],
            ),
        )
        .await
        .unwrap();

        let ids = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::Namesort,
            SortOrder::Asc,
            Some("en-US".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(ids, vec![second.id, first.id]);
    }

    #[tokio::test]
    async fn full_game_lists_match_the_shared_filter_and_sort_contract() {
        let database = setup_database().await;

        let mut local = insert_data(
            "custom",
            Some(CustomData {
                name: Some("Local".to_string()),
                user_rating: Some(6.0),
                ..Default::default()
            }),
            vec![source(
                "bgm",
                "list-query-local",
                json!({"name": "Local Source", "score": 8.5, "rank": 40}),
            )],
        );
        local.localpath = Some("games/local".to_string());
        local.date = Some("2020-01-01".to_string());
        let local = GamesRepository::insert(&database, local).await.unwrap();

        let online = GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                Some(CustomData {
                    name: Some("Online".to_string()),
                    user_rating: Some(9.0),
                    ..Default::default()
                }),
                vec![
                    source(
                        "bgm",
                        "list-query-online",
                        json!({"name": "Online Source", "score": 9.5, "rank": 10}),
                    ),
                    source(
                        "vndb",
                        "list-query-vndb",
                        json!({"name": "Online VNDB", "score": 8.0}),
                    ),
                ],
            ),
        )
        .await
        .unwrap();

        let mut whitecloud = insert_data(
            "Whitecloud",
            Some(CustomData {
                name: Some("Whitecloud".to_string()),
                user_rating: Some(0.0),
                ..Default::default()
            }),
            vec![source(
                "vndb",
                "list-query-whitecloud",
                json!({"name": "Whitecloud VNDB", "score": 7.5}),
            )],
        );
        whitecloud.localpath = Some("games/whitecloud".to_string());
        whitecloud.date = Some("2024-01-01".to_string());
        let whitecloud = GamesRepository::insert(&database, whitecloud)
            .await
            .unwrap();

        let playnite = GamesRepository::insert(
            &database,
            insert_data(
                "Playnite",
                Some(CustomData {
                    name: Some("Playnite".to_string()),
                    ..Default::default()
                }),
                Vec::new(),
            ),
        )
        .await
        .unwrap();

        for (game_id, last_played) in [(local.id, 100), (online.id, 300)] {
            game_statistics::ActiveModel {
                game_id: Set(game_id),
                total_time: Set(Some(20)),
                session_count: Set(Some(1)),
                last_played: Set(Some(last_played)),
                daily_stats: Set(None),
            }
            .insert(&database)
            .await
            .unwrap();
        }

        let scopes = [
            GameType::All,
            GameType::Local,
            GameType::Online,
            GameType::IsCustom,
        ];
        let sorts = [
            SortOption::Addtime,
            SortOption::Datetime,
            SortOption::LastPlayed,
            SortOption::BGMRank,
            SortOption::VNDBRank,
            SortOption::UserRatingRank,
            SortOption::Namesort,
        ];
        let orders = [SortOrder::Asc, SortOrder::Desc];

        for scope in scopes {
            for sort in sorts {
                for order in orders {
                    let expected_ids = GameQueryRepository::find_ids(
                        &database,
                        scope,
                        sort,
                        order,
                        Some("zh-CN".to_string()),
                    )
                    .await
                    .unwrap();
                    let games = GameQueryRepository::find_all(
                        &database,
                        scope,
                        sort,
                        order,
                        Some("zh-CN".to_string()),
                    )
                    .await
                    .unwrap();
                    let actual_ids = games.iter().map(|game| game.id).collect::<Vec<_>>();

                    assert_eq!(actual_ids, expected_ids, "scope/sort/order combination");
                }
            }
        }

        let all_games = GameQueryRepository::find_all(
            &database,
            GameType::All,
            SortOption::Addtime,
            SortOrder::Asc,
            None,
        )
        .await
        .unwrap();
        let online_data = all_games.iter().find(|game| game.id == online.id).unwrap();
        assert_eq!(online_data.sources.len(), 2);
        assert_eq!(online_data.sources[0].source, "bgm");
        assert_eq!(online_data.sources[1].source, "vndb");
        assert!(all_games.iter().any(|game| game.id == playnite.id));
        assert!(all_games.iter().any(|game| game.id == whitecloud.id));
    }

    #[tokio::test]
    async fn sorts_release_dates_with_missing_values_last_and_id_ties_stable() {
        let database = setup_database().await;
        let mut older_data = insert_data("custom", None, Vec::new());
        older_data.date = Some("2020-01-01".to_string());
        let older = GamesRepository::insert(&database, older_data)
            .await
            .unwrap();

        let mut first_latest_data = insert_data("custom", None, Vec::new());
        first_latest_data.date = Some("2024-06-01".to_string());
        let first_latest = GamesRepository::insert(&database, first_latest_data)
            .await
            .unwrap();

        let mut second_latest_data = insert_data("custom", None, Vec::new());
        second_latest_data.date = Some("2024-06-01".to_string());
        let second_latest = GamesRepository::insert(&database, second_latest_data)
            .await
            .unwrap();

        let undated = GamesRepository::insert(&database, insert_data("custom", None, Vec::new()))
            .await
            .unwrap();

        let ascending = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::Datetime,
            SortOrder::Asc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            ascending,
            vec![older.id, first_latest.id, second_latest.id, undated.id]
        );

        let descending = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::Datetime,
            SortOrder::Desc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            descending,
            vec![first_latest.id, second_latest.id, older.id, undated.id]
        );
    }

    #[tokio::test]
    async fn sorts_bgm_score_then_rank_with_both_missing_values_last() {
        let database = setup_database().await;
        let best_rank = GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                None,
                vec![source("bgm", "1", json!({"score": 9.0, "rank": 1}))],
            ),
        )
        .await
        .unwrap();
        let same_score_lower_rank = GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                None,
                vec![source("bgm", "2", json!({"score": 9.0, "rank": 25}))],
            ),
        )
        .await
        .unwrap();
        let lower_score = GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                None,
                vec![source("bgm", "3", json!({"score": 7.0, "rank": 10}))],
            ),
        )
        .await
        .unwrap();
        let missing_rank = GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                None,
                vec![source("bgm", "4", json!({"score": 7.0, "rank": 0}))],
            ),
        )
        .await
        .unwrap();
        let missing_score = GamesRepository::insert(
            &database,
            insert_data(
                "bgm",
                None,
                vec![source("bgm", "5", json!({"score": 0, "rank": 3}))],
            ),
        )
        .await
        .unwrap();

        let ascending = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::BGMRank,
            SortOrder::Asc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            ascending,
            vec![
                best_rank.id,
                same_score_lower_rank.id,
                lower_score.id,
                missing_rank.id,
                missing_score.id,
            ]
        );

        let descending = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::BGMRank,
            SortOrder::Desc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            descending,
            vec![
                lower_score.id,
                missing_rank.id,
                same_score_lower_rank.id,
                best_rank.id,
                missing_score.id,
            ]
        );
    }

    #[tokio::test]
    async fn sorts_vndb_score_with_zero_and_missing_values_last() {
        let database = setup_database().await;
        let low = GamesRepository::insert(
            &database,
            insert_data(
                "vndb",
                None,
                vec![source("vndb", "low", json!({"score": 6.5}))],
            ),
        )
        .await
        .unwrap();
        let high = GamesRepository::insert(
            &database,
            insert_data(
                "vndb",
                None,
                vec![source("vndb", "high", json!({"score": 9.0}))],
            ),
        )
        .await
        .unwrap();
        let high_tie = GamesRepository::insert(
            &database,
            insert_data(
                "vndb",
                None,
                vec![source("vndb", "high-tie", json!({"score": 9.0}))],
            ),
        )
        .await
        .unwrap();
        let zero = GamesRepository::insert(
            &database,
            insert_data(
                "vndb",
                None,
                vec![source("vndb", "zero", json!({"score": 0}))],
            ),
        )
        .await
        .unwrap();
        let missing = GamesRepository::insert(
            &database,
            insert_data(
                "vndb",
                None,
                vec![source("vndb", "missing", json!({"name": "No score"}))],
            ),
        )
        .await
        .unwrap();

        let ascending = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::VNDBRank,
            SortOrder::Asc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            ascending,
            vec![high.id, high_tie.id, low.id, zero.id, missing.id]
        );

        let descending = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::VNDBRank,
            SortOrder::Desc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            descending,
            vec![low.id, high.id, high_tie.id, zero.id, missing.id]
        );
    }

    #[tokio::test]
    async fn sorts_user_rating_from_generated_column() {
        let database = setup_database().await;
        let low = GamesRepository::insert(
            &database,
            insert_data(
                "custom",
                Some(CustomData {
                    name: Some("Low".to_string()),
                    user_rating: Some(4.0),
                    ..Default::default()
                }),
                Vec::new(),
            ),
        )
        .await
        .unwrap();
        let high = GamesRepository::insert(
            &database,
            insert_data(
                "custom",
                Some(CustomData {
                    name: Some("High".to_string()),
                    user_rating: Some(9.0),
                    ..Default::default()
                }),
                Vec::new(),
            ),
        )
        .await
        .unwrap();
        let zero = GamesRepository::insert(
            &database,
            insert_data(
                "custom",
                Some(CustomData {
                    name: Some("Zero".to_string()),
                    user_rating: Some(0.0),
                    ..Default::default()
                }),
                Vec::new(),
            ),
        )
        .await
        .unwrap();
        let negative = GamesRepository::insert(
            &database,
            insert_data(
                "custom",
                Some(CustomData {
                    name: Some("Negative".to_string()),
                    user_rating: Some(-1.0),
                    ..Default::default()
                }),
                Vec::new(),
            ),
        )
        .await
        .unwrap();
        let unrated = GamesRepository::insert(
            &database,
            insert_data(
                "custom",
                Some(CustomData {
                    name: Some("Unrated".to_string()),
                    ..Default::default()
                }),
                Vec::new(),
            ),
        )
        .await
        .unwrap();

        let ids = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::UserRatingRank,
            SortOrder::Asc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ids, vec![high.id, low.id, zero.id, negative.id, unrated.id]);
    }

    #[tokio::test]
    async fn sorts_last_played_chronologically_with_unplayed_last() {
        let database = setup_database().await;
        let oldest = GamesRepository::insert(&database, insert_data("custom", None, Vec::new()))
            .await
            .unwrap();
        let newest = GamesRepository::insert(&database, insert_data("custom", None, Vec::new()))
            .await
            .unwrap();
        let unplayed = GamesRepository::insert(&database, insert_data("custom", None, Vec::new()))
            .await
            .unwrap();

        for (game_id, last_played) in [(oldest.id, 100), (newest.id, 200)] {
            game_statistics::ActiveModel {
                game_id: Set(game_id),
                total_time: Set(Some(0)),
                session_count: Set(Some(1)),
                last_played: Set(Some(last_played)),
                daily_stats: Set(None),
            }
            .insert(&database)
            .await
            .unwrap();
        }

        let ascending = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::LastPlayed,
            SortOrder::Asc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(ascending, vec![oldest.id, newest.id, unplayed.id]);

        let descending = GameQueryRepository::find_ids(
            &database,
            GameType::All,
            SortOption::LastPlayed,
            SortOrder::Desc,
            None,
        )
        .await
        .unwrap();
        assert_eq!(descending, vec![newest.id, oldest.id, unplayed.id]);
    }
}
