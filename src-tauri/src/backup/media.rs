use crate::entity::custom_data::CustomData;
use crate::entity::games::{ActiveModel as GameActiveModel, Column as GameColumn, Entity as Games};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
    TransactionTrait,
};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct PruneMissingMediaResult {
    pub cover_refs: u32,
    pub banner_refs: u32,
    pub backdrop_refs: u32,
    pub cg_refs: u32,
    pub imported_screenshot_refs: u32,
}

#[derive(Clone, Debug)]
enum MediaRoot {
    NotConfigured,
    Available(PathBuf),
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MediaPresence {
    Present,
    Missing,
    Unknown,
}

fn resolve_media_root(path: PathBuf) -> MediaRoot {
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_dir() => MediaRoot::Available(path),
        Ok(_) | Err(_) => MediaRoot::Unavailable,
    }
}

fn resolve_custom_media_root(configured_path: Option<&str>) -> MediaRoot {
    let Some(path) = configured_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return MediaRoot::NotConfigured;
    };

    resolve_media_root(PathBuf::from(path).join("covers"))
}

fn resource_file(covers_dir: &Path, game_id: i32, prefix: &str, identifier: &str) -> PathBuf {
    covers_dir
        .join(format!("game_{game_id}"))
        .join(format!("{prefix}_{game_id}_{identifier}"))
}

fn media_presence(root: &MediaRoot, game_id: i32, prefix: &str, identifier: &str) -> MediaPresence {
    let covers_dir = match root {
        MediaRoot::NotConfigured => return MediaPresence::Missing,
        MediaRoot::Unavailable => return MediaPresence::Unknown,
        MediaRoot::Available(covers_dir) => covers_dir,
    };

    match fs::metadata(resource_file(covers_dir, game_id, prefix, identifier)) {
        Ok(metadata) if metadata.is_file() => MediaPresence::Present,
        Ok(_) => MediaPresence::Missing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => MediaPresence::Missing,
        Err(_) => MediaPresence::Unknown,
    }
}

fn media_is_confirmed_missing(
    roots: &[&MediaRoot],
    game_id: i32,
    prefix: &str,
    identifier: &str,
) -> bool {
    roots
        .iter()
        .all(|root| media_presence(root, game_id, prefix, identifier) == MediaPresence::Missing)
}

fn add_pruned_reference_count(count: &mut u32, removed: usize) -> Result<(), String> {
    let removed =
        u32::try_from(removed).map_err(|_| "清理媒体引用数量超出结果支持范围".to_string())?;
    *count = count
        .checked_add(removed)
        .ok_or_else(|| "清理媒体引用数量超出结果支持范围".to_string())?;
    Ok(())
}

fn prune_single_reference(
    reference: &mut Option<String>,
    game_id: i32,
    prefix: &str,
    roots: &[&MediaRoot],
    count: &mut u32,
) -> Result<bool, String> {
    let Some(identifier) = reference.as_deref() else {
        return Ok(false);
    };
    if media_is_confirmed_missing(roots, game_id, prefix, identifier) {
        add_pruned_reference_count(count, 1)?;
        *reference = None;
        return Ok(true);
    }
    Ok(false)
}

fn prune_game_references(
    custom_data: &mut CustomData,
    game_id: i32,
    base_covers: &MediaRoot,
    custom_covers: &MediaRoot,
    result: &mut PruneMissingMediaResult,
) -> Result<(), String> {
    let base_only = [base_covers];
    let base_and_custom = [base_covers, custom_covers];
    prune_single_reference(
        &mut custom_data.image,
        game_id,
        "cover",
        &base_only,
        &mut result.cover_refs,
    )?;
    if prune_single_reference(
        &mut custom_data.banner,
        game_id,
        "banner",
        &base_only,
        &mut result.banner_refs,
    )? {
        custom_data.banner_focus = None;
    }
    prune_single_reference(
        &mut custom_data.detail_backdrop,
        game_id,
        "detail",
        &base_and_custom,
        &mut result.backdrop_refs,
    )?;

    if let Some(cgs) = custom_data.cgs.as_ref() {
        let mut retained = Vec::with_capacity(cgs.len());
        let mut removed = 0;
        for identifier in cgs {
            if identifier.contains("://")
                || !media_is_confirmed_missing(&base_and_custom, game_id, "cg", identifier)
            {
                retained.push(identifier.clone());
            } else {
                removed += 1;
            }
        }
        if removed > 0 {
            add_pruned_reference_count(&mut result.cg_refs, removed)?;
            custom_data.cgs = (!retained.is_empty()).then_some(retained);
        }
    }

    if let Some(map) = custom_data.imported_screenshot_map.as_ref() {
        let mut retained = std::collections::BTreeMap::new();
        let mut removed = 0;
        for (url, identifier) in map {
            if media_is_confirmed_missing(&base_and_custom, game_id, "cg", identifier) {
                removed += 1;
            } else {
                retained.insert(url.clone(), identifier.clone());
            }
        }
        if removed > 0 {
            add_pruned_reference_count(&mut result.imported_screenshot_refs, removed)?;
            custom_data.imported_screenshot_map =
                (!retained.is_empty()).then_some(retained.clone());
            if let Some(urls) = custom_data.imported_screenshot_urls.as_mut() {
                urls.retain(|url| retained.contains_key(url));
            }
        }
    }
    Ok(())
}

pub async fn prune_missing_media_refs(
    db: &DatabaseConnection,
) -> Result<PruneMissingMediaResult, String> {
    let settings =
        crate::database::repository::settings_repository::SettingsRepository::get_all_settings(db)
            .await
            .map_err(|error| format!("读取设置失败: {error}"))?;
    let custom_covers = resolve_custom_media_root(settings.detail_backdrop_path.as_deref());
    let base_covers = resolve_media_root(skerry_path::get_base_data_dir()?.join("covers"));

    prune_media_references_in_directories(db, &base_covers, &custom_covers).await
}

async fn prune_media_references_in_directories(
    db: &DatabaseConnection,
    base_covers: &MediaRoot,
    custom_covers: &MediaRoot,
) -> Result<PruneMissingMediaResult, String> {
    let transaction = db
        .begin()
        .await
        .map_err(|error| format!("开启媒体引用清理事务失败: {error}"))?;
    let decision = async {
        let games = Games::find()
            .filter(GameColumn::CustomData.is_not_null())
            .order_by_asc(GameColumn::Id)
            .all(&transaction)
            .await
            .map_err(|error| format!("读取游戏失败: {error}"))?;
        let mut result = PruneMissingMediaResult::default();

        for game in games {
            let game_id = game.id;
            let Some(original) = game.custom_data else {
                continue;
            };
            let mut custom_data = original.clone();
            prune_game_references(
                &mut custom_data,
                game_id,
                base_covers,
                custom_covers,
                &mut result,
            )?;

            if custom_data != original {
                let active = GameActiveModel {
                    id: Set(game_id),
                    custom_data: Set(Some(custom_data)),
                    ..Default::default()
                };
                active
                    .update(&transaction)
                    .await
                    .map_err(|error| format!("清理游戏 {game_id} 的媒体引用失败: {error}"))?;
            }
        }

        Ok::<PruneMissingMediaResult, String>(result)
    }
    .await;

    let result = match decision {
        Ok(result) => {
            transaction
                .commit()
                .await
                .map_err(|error| format!("提交媒体引用清理失败: {error}"))?;
            result
        }
        Err(failure) => {
            return match transaction.rollback().await {
                Ok(()) => Err(failure),
                Err(error) => Err(format!("{failure}；回滚媒体引用清理失败: {error}")),
            };
        }
    };

    if result.banner_refs > 0
        || result.backdrop_refs > 0
        || result.cover_refs > 0
        || result.cg_refs > 0
        || result.imported_screenshot_refs > 0
    {
        log::info!(
            "启动清理悬空媒体引用: covers={}, banners={}, backdrops={}, cgs={}, imported_screenshots={}",
            result.cover_refs,
            result.banner_refs,
            result.backdrop_refs,
            result.cg_refs,
            result.imported_screenshot_refs
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn prune_missing_media_refs_command(
    db: tauri::State<'_, DatabaseConnection>,
) -> Result<PruneMissingMediaResult, String> {
    prune_missing_media_refs(db.inner()).await
}

#[cfg(test)]
mod tests {
    use super::{
        add_pruned_reference_count, prune_media_references_in_directories,
        resolve_custom_media_root, resolve_media_root, resource_file,
    };
    use crate::entity::custom_data::{BannerFocus, CustomData};
    use crate::entity::games::Entity as Games;
    use sea_orm::{
        ConnectOptions, ConnectionTrait, Database, DatabaseBackend, EntityTrait, Statement,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_root() -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应不早于 Unix epoch")
            .as_nanos();
        let sequence = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "skerry_media_prune_{}_{}_{}",
            std::process::id(),
            timestamp,
            sequence,
        ));

        fs::create_dir(&root).expect("每个并行媒体测试应取得独立临时目录");
        root
    }

    async fn test_database() -> sea_orm::DatabaseConnection {
        let mut options = ConnectOptions::new("sqlite::memory:");
        options.max_connections(1);
        let database = Database::connect(options).await.unwrap();
        database
            .execute_unprepared(
                "CREATE TABLE games (
                    id INTEGER PRIMARY KEY,
                    id_type TEXT NOT NULL,
                    date TEXT,
                    localpath TEXT,
                    executable TEXT,
                    launch_type TEXT NOT NULL DEFAULT 'local',
                    steam_launch_id TEXT,
                    savepath TEXT,
                    autosave INTEGER,
                    maxbackups INTEGER,
                    clear INTEGER,
                    le_launch INTEGER,
                    magpie INTEGER,
                    custom_data TEXT,
                    user_rating REAL,
                    created_at INTEGER,
                    updated_at INTEGER
                )",
            )
            .await
            .unwrap();
        database
    }

    async fn insert_game(database: &sea_orm::DatabaseConnection, id: i32, data: &CustomData) {
        let encoded = serde_json::to_string(data).unwrap();
        database
            .execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO games (id, id_type, custom_data) VALUES (?, ?, ?)",
                [id.into(), "test".into(), encoded.into()],
            ))
            .await
            .unwrap();
    }

    fn create_media(covers: &Path, game_id: i32, prefix: &str, identifier: &str) {
        let path = resource_file(covers, game_id, prefix, identifier);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"test media").unwrap();
    }

    #[tokio::test]
    async fn startup_pruning_updates_only_missing_media_references() {
        let root = test_root();
        let base_covers = root.join("base-covers");
        let custom_covers = root.join("custom-covers");
        fs::create_dir_all(&base_covers).unwrap();
        fs::create_dir_all(&custom_covers).unwrap();
        let database = test_database().await;

        let kept_url = "https://source.test/kept.png".to_string();
        let removed_url = "https://source.test/removed.png".to_string();
        let mut imported_screenshot_map = BTreeMap::new();
        imported_screenshot_map.insert(kept_url.clone(), "imported.png".to_string());
        imported_screenshot_map.insert(removed_url.clone(), "missing.png".to_string());
        insert_game(
            &database,
            501,
            &CustomData {
                image: Some("missing.png".to_string()),
                banner: Some("missing.jpg".to_string()),
                banner_focus: Some(BannerFocus { x: 0.25, y: 0.75 }),
                detail_backdrop: Some("detail.webp".to_string()),
                cgs: Some(vec![
                    "https://source.test/remote.png".to_string(),
                    "base.png".to_string(),
                    "custom.png".to_string(),
                    "missing.png".to_string(),
                ]),
                imported_screenshot_urls: Some(vec![
                    kept_url.clone(),
                    removed_url.clone(),
                    "https://source.test/unmapped.png".to_string(),
                ]),
                imported_screenshot_map: Some(imported_screenshot_map),
                name: Some("Keep this user value".to_string()),
                ..CustomData::default()
            },
        )
        .await;
        insert_game(
            &database,
            502,
            &CustomData {
                image: Some("base.png".to_string()),
                banner: Some("base.png".to_string()),
                detail_backdrop: Some("missing.webp".to_string()),
                ..CustomData::default()
            },
        )
        .await;

        create_media(&base_covers, 501, "cg", "base.png");
        create_media(&custom_covers, 501, "detail", "detail.webp");
        create_media(&custom_covers, 501, "cg", "custom.png");
        create_media(&custom_covers, 501, "cg", "imported.png");
        create_media(&base_covers, 502, "cover", "base.png");
        create_media(&base_covers, 502, "banner", "base.png");

        let result = prune_media_references_in_directories(
            &database,
            &resolve_media_root(base_covers.clone()),
            &resolve_media_root(custom_covers.clone()),
        )
        .await
        .unwrap();

        assert_eq!(result.cover_refs, 1);
        assert_eq!(result.banner_refs, 1);
        assert_eq!(result.backdrop_refs, 1);
        assert_eq!(result.cg_refs, 1);
        assert_eq!(result.imported_screenshot_refs, 1);

        let pruned = Games::find_by_id(501)
            .one(&database)
            .await
            .unwrap()
            .unwrap()
            .custom_data
            .unwrap();
        assert_eq!(pruned.image, None);
        assert_eq!(pruned.banner, None);
        assert_eq!(pruned.banner_focus, None);
        assert_eq!(pruned.detail_backdrop.as_deref(), Some("detail.webp"));
        assert_eq!(
            pruned.cgs,
            Some(vec![
                "https://source.test/remote.png".to_string(),
                "base.png".to_string(),
                "custom.png".to_string(),
            ])
        );
        assert_eq!(
            pruned.imported_screenshot_map,
            Some(BTreeMap::from([(
                kept_url.clone(),
                "imported.png".to_string()
            )]))
        );
        assert_eq!(pruned.imported_screenshot_urls, Some(vec![kept_url]));
        assert_eq!(pruned.name.as_deref(), Some("Keep this user value"));

        let kept = Games::find_by_id(502)
            .one(&database)
            .await
            .unwrap()
            .unwrap()
            .custom_data
            .unwrap();
        assert_eq!(kept.image.as_deref(), Some("base.png"));
        assert_eq!(kept.banner.as_deref(), Some("base.png"));
        assert_eq!(kept.detail_backdrop, None);

        database.close().await.unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn unavailable_configured_media_root_preserves_unverifiable_references() {
        let root = test_root();
        let base_covers = root.join("base-covers");
        let missing_custom_parent = root.join("offline-drive");
        fs::create_dir_all(&base_covers).unwrap();
        let database = test_database().await;
        let url = "https://source.test/screenshot.png".to_string();
        let custom_data = CustomData {
            detail_backdrop: Some("detail.webp".to_string()),
            cgs: Some(vec!["local.png".to_string()]),
            imported_screenshot_urls: Some(vec![url.clone()]),
            imported_screenshot_map: Some(BTreeMap::from([(url.clone(), "local.png".to_string())])),
            ..CustomData::default()
        };
        insert_game(&database, 503, &custom_data).await;

        let result = prune_media_references_in_directories(
            &database,
            &resolve_media_root(base_covers.clone()),
            &resolve_custom_media_root(Some(missing_custom_parent.to_str().unwrap())),
        )
        .await
        .unwrap();

        assert_eq!(result.backdrop_refs, 0);
        assert_eq!(result.cg_refs, 0);
        assert_eq!(result.imported_screenshot_refs, 0);
        let stored = Games::find_by_id(503)
            .one(&database)
            .await
            .unwrap()
            .unwrap()
            .custom_data
            .unwrap();
        assert_eq!(stored.detail_backdrop, custom_data.detail_backdrop);
        assert_eq!(stored.cgs, custom_data.cgs);
        assert_eq!(
            stored.imported_screenshot_map,
            custom_data.imported_screenshot_map
        );
        assert_eq!(
            stored.imported_screenshot_urls,
            custom_data.imported_screenshot_urls
        );

        database.close().await.unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn no_configured_custom_root_keeps_base_directory_pruning_behavior() {
        let root = test_root();
        let base_covers = root.join("base-covers");
        fs::create_dir_all(&base_covers).unwrap();
        let database = test_database().await;
        insert_game(
            &database,
            504,
            &CustomData {
                detail_backdrop: Some("missing.webp".to_string()),
                ..CustomData::default()
            },
        )
        .await;

        let result = prune_media_references_in_directories(
            &database,
            &resolve_media_root(base_covers),
            &resolve_custom_media_root(None),
        )
        .await
        .unwrap();

        assert_eq!(result.backdrop_refs, 1);
        let stored = Games::find_by_id(504)
            .one(&database)
            .await
            .unwrap()
            .unwrap()
            .custom_data
            .unwrap();
        assert_eq!(stored.detail_backdrop, None);

        database.close().await.unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn failed_game_update_rolls_back_all_media_reference_changes() {
        let root = test_root();
        let base_covers = root.join("base-covers");
        fs::create_dir_all(&base_covers).unwrap();
        let database = test_database().await;
        for game_id in [505, 506] {
            insert_game(
                &database,
                game_id,
                &CustomData {
                    image: Some("missing.png".to_string()),
                    ..CustomData::default()
                },
            )
            .await;
        }
        database
            .execute_unprepared(
                "CREATE TRIGGER reject_second_media_update BEFORE UPDATE ON games \
                 WHEN NEW.id = 506 BEGIN SELECT RAISE(ABORT, 'injected update failure'); END",
            )
            .await
            .unwrap();

        let result = prune_media_references_in_directories(
            &database,
            &resolve_media_root(base_covers),
            &resolve_custom_media_root(None),
        )
        .await;

        assert!(result.is_err());
        for game_id in [505, 506] {
            let stored = Games::find_by_id(game_id)
                .one(&database)
                .await
                .unwrap()
                .unwrap()
                .custom_data
                .unwrap();
            assert_eq!(stored.image.as_deref(), Some("missing.png"));
        }
        database.close().await.unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pruned_reference_counts_accept_representable_values() {
        let mut count = 0;
        add_pruned_reference_count(&mut count, 1).unwrap();
        assert_eq!(count, 1);

        let maximum = usize::try_from(u32::MAX).unwrap();
        let mut count = 0;
        add_pruned_reference_count(&mut count, maximum).unwrap();
        assert_eq!(count, u32::MAX);
    }

    #[test]
    fn pruned_reference_counts_reject_conversion_and_accumulation_overflow() {
        let mut count = u32::MAX;
        assert!(add_pruned_reference_count(&mut count, 1).is_err());
        assert_eq!(count, u32::MAX);

        if let Ok(too_many) = usize::try_from(u64::from(u32::MAX) + 1) {
            let mut count = 0;
            assert!(add_pruned_reference_count(&mut count, too_many).is_err());
            assert_eq!(count, 0);
        }
    }
}
