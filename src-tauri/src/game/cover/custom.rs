use arboard::Clipboard;
use image::{ColorType, ImageFormat};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::command;

fn map_clipboard_error(error: arboard::Error) -> String {
    let message = error.to_string();
    let lower_message = message.to_lowercase();
    if lower_message.contains("not available")
        || lower_message.contains("unavailable")
        || lower_message.contains("requested format")
    {
        "CLIPBOARD_IMAGE_NOT_FOUND".to_string()
    } else {
        format!("CLIPBOARD_IMAGE_READ_FAILED: {}", message)
    }
}

/// 从剪贴板读取图片并写入临时 PNG 文件。
///
/// 该文件只用于前端保存前预览，保存成功后仍由现有上传逻辑复制到正式封面目录。
#[command]
pub async fn import_clipboard_image_to_temp(game_id: u32) -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(map_clipboard_error)?;
    let clipboard_image = clipboard.get_image().map_err(map_clipboard_error)?;
    let width = u32::try_from(clipboard_image.width)
        .map_err(|_| "CLIPBOARD_IMAGE_READ_FAILED: 图片宽度超出支持范围".to_string())?;
    let height = u32::try_from(clipboard_image.height)
        .map_err(|_| "CLIPBOARD_IMAGE_READ_FAILED: 图片高度超出支持范围".to_string())?;

    let temp_dir = std::env::temp_dir().join("Skerry").join("clipboard-cover");
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建剪贴板图片临时目录失败: {}", e))?;

    let timestamp_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("获取系统时间失败: {}", e))?
        .as_nanos();
    let target_path = temp_dir.join(format!(
        "clipboard_cover_{}_{}.png",
        game_id, timestamp_nanos
    ));

    image::save_buffer_with_format(
        &target_path,
        clipboard_image.bytes.as_ref(),
        width,
        height,
        ColorType::Rgba8,
        ImageFormat::Png,
    )
    .map_err(|e| format!("CLIPBOARD_IMAGE_WRITE_FAILED: {}", e))?;

    Ok(target_path.to_string_lossy().to_string())
}

/// 删除指定游戏的所有自定义封面文件，但保留封面目录
#[command]
pub async fn delete_game_covers(game_id: u32, covers_dir: String) -> Result<(), String> {
    let dir_path = Path::new(&covers_dir);

    if !dir_path.exists() {
        return Ok(());
    }

    let expected_folder_name = format!("game_{}", game_id);
    let dir_name = dir_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    if dir_name != expected_folder_name {
        return Err(format!(
            "封面目录与游戏ID不匹配: game_id={}, covers_dir={}",
            game_id, covers_dir
        ));
    }

    let expected_file_prefix = format!("cover_{}_", game_id);
    let entries = fs::read_dir(dir_path).map_err(|e| format!("无法读取封面目录: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();

        if !path.is_file() {
            continue;
        }

        let file_name = entry.file_name();
        let file_name_str = file_name.to_string_lossy();
        if !file_name_str.starts_with(&expected_file_prefix) {
            continue;
        }

        fs::remove_file(&path).map_err(|e| format!("无法删除自定义封面文件: {}", e))?;
    }

    Ok(())
}

/// 将底图与 CG 资源从旧保存根目录迁移到新根目录。
///
/// 仅移动 `detail_*` 与 `cg_*` 前缀文件，云端封面缓存与自定义封面保持原位。
#[command]
pub async fn relocate_detail_resources(old_root: String, new_root: String) -> Result<u32, String> {
    let resolve_root = |root: &str| -> Result<PathBuf, String> {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            return reina_path::get_base_data_dir();
        }
        Ok(PathBuf::from(trimmed))
    };

    let old_root = resolve_root(&old_root)?;
    let new_root = resolve_root(&new_root)?;
    if old_root == new_root {
        return Ok(0);
    }

    let old_covers = old_root.join("covers");
    let new_covers = new_root.join("covers");
    if !old_covers.exists() {
        return Ok(0);
    }

    let entries = fs::read_dir(&old_covers).map_err(|e| format!("无法读取封面目录: {}", e))?;
    let mut moved = 0u32;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let game_dir = entry.path();
        if !game_dir.is_dir() {
            continue;
        }
        let dir_name = game_dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if !dir_name.starts_with("game_") {
            continue;
        }
        let file_entries = match fs::read_dir(&game_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for file in file_entries.flatten() {
            let file_path = file.path();
            if !file_path.is_file() {
                continue;
            }
            let file_name = file_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default();
            if !(file_name.starts_with("detail_") || file_name.starts_with("cg_")) {
                continue;
            }
            let dest_dir = new_covers.join(&dir_name);
            fs::create_dir_all(&dest_dir)
                .map_err(|e| format!("无法创建目标目录 {}: {}", dest_dir.display(), e))?;
            let dest = dest_dir.join(&file_name);
            crate::utils::fs::move_file(&file_path, &dest)?;
            moved += 1;
        }
    }
    Ok(moved)
}
