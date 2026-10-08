use crate::entity::custom_data::CustomData;
use crate::entity::games::{ActiveModel as GameActiveModel, Column as GameColumn, Entity as Games};
use sea_orm::{ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set};
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct PruneMissingMediaResult {
    pub cover_refs: u32,
    pub banner_refs: u32,
    pub backdrop_refs: u32,
    pub cg_refs: u32,
    pub imported_screenshot_refs: u32,
}

fn resource_file(covers_dir: &Path, game_id: i32, prefix: &str, identifier: &str) -> PathBuf {
    covers_dir
        .join(format!("game_{game_id}"))
        .join(format!("{prefix}_{game_id}_{identifier}"))
}

fn prune_cover_ref(
    custom_data: &mut CustomData,
    game_id: i32,
    base_covers: &Path,
    result: &mut PruneMissingMediaResult,
) {
    let Some(identifier) = custom_data.image.as_ref() else {
        return;
    };
    if !resource_file(base_covers, game_id, "cover", identifier).is_file() {
        custom_data.image = None;
        result.cover_refs += 1;
    }
}

fn prune_banner_ref(
    custom_data: &mut CustomData,
    game_id: i32,
    base_covers: &Path,
    result: &mut PruneMissingMediaResult,
) {
    let Some(identifier) = custom_data.banner.as_ref() else {
        return;
    };
    if !resource_file(base_covers, game_id, "banner", identifier).is_file() {
        custom_data.banner = None;
        custom_data.banner_focus = None;
        result.banner_refs += 1;
    }
}

fn prune_backdrop_ref(
    custom_data: &mut CustomData,
    game_id: i32,
    base_covers: &Path,
    custom_covers: Option<&Path>,
    result: &mut PruneMissingMediaResult,
) {
    let Some(identifier) = custom_data.detail_backdrop.as_ref() else {
        return;
    };
    let exists = custom_covers
        .map(|covers| resource_file(covers, game_id, "detail", identifier).is_file())
        .unwrap_or(false)
        || resource_file(base_covers, game_id, "detail", identifier).is_file();
    if !exists {
        custom_data.detail_backdrop = None;
        result.backdrop_refs += 1;
    }
}

fn prune_cg_refs(
    custom_data: &mut CustomData,
    game_id: i32,
    base_covers: &Path,
    custom_covers: Option<&Path>,
    result: &mut PruneMissingMediaResult,
) {
    let Some(cgs) = custom_data.cgs.as_ref() else {
        return;
    };
    let kept = cgs
        .iter()
        .filter(|identifier| {
            identifier.contains("://")
                || custom_covers
                    .map(|covers| resource_file(covers, game_id, "cg", identifier).is_file())
                    .unwrap_or(false)
                || resource_file(base_covers, game_id, "cg", identifier).is_file()
        })
        .cloned()
        .collect::<Vec<_>>();

    let removed = cgs.len().saturating_sub(kept.len());
    if removed > 0 {
        result.cg_refs += removed as u32;
        custom_data.cgs = if kept.is_empty() { None } else { Some(kept) };
    }
}

fn prune_imported_screenshots(
    custom_data: &mut CustomData,
    game_id: i32,
    base_covers: &Path,
    custom_covers: Option<&Path>,
    result: &mut PruneMissingMediaResult,
) {
    let Some(map) = custom_data.imported_screenshot_map.as_ref() else {
        return;
    };
    let kept = map
        .iter()
        .filter(|(_, identifier)| {
            custom_covers
                .map(|covers| resource_file(covers, game_id, "cg", identifier).is_file())
                .unwrap_or(false)
                || resource_file(base_covers, game_id, "cg", identifier).is_file()
        })
        .map(|(url, identifier)| (url.clone(), identifier.clone()))
        .collect::<std::collections::BTreeMap<_, _>>();

    let removed = map.len().saturating_sub(kept.len());
    if removed > 0 {
        result.imported_screenshot_refs += removed as u32;
        custom_data.imported_screenshot_map = if kept.is_empty() {
            None
        } else {
            Some(kept.clone())
        };
        if let Some(urls) = custom_data.imported_screenshot_urls.as_mut() {
            urls.retain(|url| kept.contains_key(url));
        }
    }
}

pub async fn prune_missing_media_refs(
    db: &DatabaseConnection,
) -> Result<PruneMissingMediaResult, String> {
    let settings =
        crate::database::repository::settings_repository::SettingsRepository::get_all_settings(db)
            .await
            .map_err(|error| format!("读取设置失败: {error}"))?;
    let custom_root = settings
        .detail_backdrop_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .map(|root| root.join("covers"));
    let base_covers = reina_path::get_base_data_dir()?.join("covers");

    let games = Games::find()
        .filter(GameColumn::CustomData.is_not_null())
        .all(db)
        .await
        .map_err(|error| format!("读取游戏失败: {error}"))?;
    let mut result = PruneMissingMediaResult::default();

    for game in games {
        let game_id = game.id;
        let Some(original) = game.custom_data else {
            continue;
        };
        let mut custom_data = original.clone();
        prune_cover_ref(&mut custom_data, game_id, &base_covers, &mut result);
        prune_banner_ref(&mut custom_data, game_id, &base_covers, &mut result);
        prune_backdrop_ref(
            &mut custom_data,
            game_id,
            &base_covers,
            custom_root.as_deref(),
            &mut result,
        );
        prune_cg_refs(
            &mut custom_data,
            game_id,
            &base_covers,
            custom_root.as_deref(),
            &mut result,
        );
        prune_imported_screenshots(
            &mut custom_data,
            game_id,
            &base_covers,
            custom_root.as_deref(),
            &mut result,
        );

        if custom_data != original {
            let active = GameActiveModel {
                id: Set(game_id),
                custom_data: Set(Some(custom_data)),
                ..Default::default()
            };
            active
                .update(db)
                .await
                .map_err(|error| format!("清理游戏 {game_id} 的媒体引用失败: {error}"))?;
        }
    }

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
