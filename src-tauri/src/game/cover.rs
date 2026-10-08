#[cfg(feature = "tauri-app")]
pub mod cloud;

#[cfg(feature = "tauri-app")]
pub mod custom;

#[cfg(feature = "tauri-app")]
pub use cloud::{DownloadState, delete_cloud_cache, register_game_cover_protocol};

/// 删除指定游戏的封面目录（包含云端缓存和自定义封面）。
pub async fn delete_game_cover_dir(game_id: i32) -> Result<(), String> {
    let game_cover_dir = reina_path::get_base_data_dir()?
        .join("covers")
        .join(format!("game_{}", game_id));

    if !game_cover_dir.exists() {
        return Ok(());
    }

    std::fs::remove_dir_all(&game_cover_dir)
        .map_err(|e| format!("无法删除游戏封面目录 {}: {}", game_cover_dir.display(), e))?;

    Ok(())
}
