use arboard::Clipboard;
use image::{ColorType, ImageEncoder, codecs::png::PngEncoder};
use std::fs::{self, File, OpenOptions};
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
    let (file, target_path) = reserve_clipboard_temp_file(&temp_dir, game_id, timestamp_nanos)?;
    write_clipboard_png(
        file,
        &target_path,
        clipboard_image.bytes.as_ref(),
        width,
        height,
    )?;

    Ok(target_path.to_string_lossy().to_string())
}

fn reserve_clipboard_temp_file(
    temp_dir: &Path,
    game_id: u32,
    timestamp_nanos: u128,
) -> Result<(File, PathBuf), String> {
    let mut collision_index = 0_u128;
    loop {
        let collision_suffix = if collision_index == 0 {
            String::new()
        } else {
            format!("_{collision_index}")
        };
        let target_path = temp_dir.join(format!(
            "clipboard_cover_{game_id}_{timestamp_nanos}{collision_suffix}.png"
        ));

        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target_path)
        {
            Ok(file) => return Ok((file, target_path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                collision_index = collision_index.checked_add(1).ok_or_else(|| {
                    "CLIPBOARD_IMAGE_WRITE_FAILED: 临时图片文件名冲突次数超出支持范围".to_string()
                })?;
            }
            Err(error) => {
                return Err(format!("CLIPBOARD_IMAGE_WRITE_FAILED: {error}"));
            }
        }
    }
}

fn write_clipboard_png(
    file: File,
    target_path: &Path,
    bytes: &[u8],
    width: u32,
    height: u32,
) -> Result<(), String> {
    let expected_bytes = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|pixels| pixels.checked_mul(u64::from(ColorType::Rgba8.bytes_per_pixel())))
        .ok_or_else(|| "CLIPBOARD_IMAGE_WRITE_FAILED: 图片尺寸超出支持范围".to_string());
    let actual_bytes = u64::try_from(bytes.len())
        .map_err(|_| "CLIPBOARD_IMAGE_WRITE_FAILED: 图片数据长度超出支持范围".to_string());
    let valid_buffer = match (expected_bytes, actual_bytes) {
        (Ok(expected), Ok(actual)) => expected == actual,
        _ => false,
    };
    if !valid_buffer {
        let _ = fs::remove_file(target_path);
        return Err("CLIPBOARD_IMAGE_WRITE_FAILED: 图片数据长度无效".to_string());
    }

    if let Err(error) =
        PngEncoder::new(file).write_image(bytes, width, height, ColorType::Rgba8.into())
    {
        let _ = fs::remove_file(target_path);
        return Err(format!("CLIPBOARD_IMAGE_WRITE_FAILED: {error}"));
    }

    Ok(())
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
    let files_to_remove = fs::read_dir(dir_path)
        .map_err(|e| format!("无法读取封面目录: {}", e))?
        .try_fold(Vec::new(), |mut files_to_remove, entry| {
            let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
            let path = entry.path();
            let is_custom_cover = path.is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(&expected_file_prefix);
            if is_custom_cover {
                files_to_remove.push(path);
            }
            Ok::<_, String>(files_to_remove)
        })?;

    for path in files_to_remove {
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
            return skerry_path::get_base_data_dir();
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

#[cfg(test)]
mod tests {
    use super::{delete_game_covers, reserve_clipboard_temp_file, write_clipboard_png};
    use image::ImageFormat;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_cover_directory(game_id: u32) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after UNIX epoch")
            .as_nanos();
        std::env::temp_dir()
            .join("skerry-custom-cover-tests")
            .join(format!("{}-{unique}", std::process::id()))
            .join(format!("game_{game_id}"))
    }

    fn temporary_clipboard_directory() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after UNIX epoch")
            .as_nanos();
        std::env::temp_dir()
            .join("skerry-clipboard-cover-tests")
            .join(format!("{}-{unique}", std::process::id()))
    }

    #[test]
    fn writes_clipboard_rgba_as_a_decodable_png() {
        let temp_dir = temporary_clipboard_directory();
        fs::create_dir_all(&temp_dir).expect("test directory should be created");
        let (file, target_path) = reserve_clipboard_temp_file(&temp_dir, 42, 123)
            .expect("a unique temporary file should be reserved");

        write_clipboard_png(file, &target_path, &[255, 0, 0, 255], 1, 1)
            .expect("valid RGBA pixels should encode");

        assert_eq!(
            target_path.file_name().and_then(|name| name.to_str()),
            Some("clipboard_cover_42_123.png")
        );
        let decoded = image::load_from_memory_with_format(
            &fs::read(&target_path).expect("PNG should be written"),
            ImageFormat::Png,
        )
        .expect("written image should be a valid PNG");
        assert_eq!((decoded.width(), decoded.height()), (1, 1));

        fs::remove_dir_all(&temp_dir).expect("test files should be cleaned");
    }

    #[test]
    fn reserves_a_new_name_without_overwriting_a_timestamp_collision() {
        let temp_dir = temporary_clipboard_directory();
        fs::create_dir_all(&temp_dir).expect("test directory should be created");
        let existing_path = temp_dir.join("clipboard_cover_42_123.png");
        fs::write(&existing_path, b"existing preview").expect("existing preview should be written");

        let (file, target_path) = reserve_clipboard_temp_file(&temp_dir, 42, 123)
            .expect("a collision should reserve a distinct file");
        write_clipboard_png(file, &target_path, &[0, 255, 0, 255], 1, 1)
            .expect("new preview should encode");

        assert_eq!(
            target_path.file_name().and_then(|name| name.to_str()),
            Some("clipboard_cover_42_123_1.png")
        );
        assert_eq!(
            fs::read(&existing_path).expect("existing preview should remain"),
            b"existing preview"
        );
        assert!(
            image::load_from_memory(&fs::read(&target_path).expect("new PNG should exist")).is_ok()
        );

        fs::remove_dir_all(&temp_dir).expect("test files should be cleaned");
    }

    #[test]
    fn removes_reserved_file_when_clipboard_pixel_buffer_is_invalid() {
        let temp_dir = temporary_clipboard_directory();
        fs::create_dir_all(&temp_dir).expect("test directory should be created");
        let (file, target_path) = reserve_clipboard_temp_file(&temp_dir, 42, 123)
            .expect("a unique temporary file should be reserved");

        let error = write_clipboard_png(file, &target_path, &[255, 0, 0], 1, 1)
            .expect_err("incomplete RGBA pixels should fail");

        assert!(error.starts_with("CLIPBOARD_IMAGE_WRITE_FAILED:"));
        assert!(!target_path.exists(), "partial file should be removed");
        fs::remove_dir_all(&temp_dir).expect("test files should be cleaned");
    }

    #[tokio::test]
    async fn deletes_only_this_games_custom_cover_files_and_keeps_folder() {
        let covers = temporary_cover_directory(42);
        fs::create_dir_all(&covers).expect("cover folder should be created");
        let own_cover = covers.join("cover_42_20261020.png");
        let other_game_cover = covers.join("cover_420_20261020.png");
        let detail_image = covers.join("detail_42_scene.png");
        let nested_cover_name = covers.join("cover_42_nested");
        fs::write(&own_cover, b"own cover").expect("own cover should be written");
        fs::write(&other_game_cover, b"other game cover")
            .expect("other game's cover should be written");
        fs::write(&detail_image, b"detail image").expect("detail image should be written");
        fs::create_dir(&nested_cover_name).expect("nested directory should be created");
        fs::write(
            nested_cover_name.join("cover_42_nested.png"),
            b"nested file",
        )
        .expect("nested file should be written");

        delete_game_covers(42, covers.to_string_lossy().into_owned())
            .await
            .expect("matching custom covers should be deleted");

        assert!(!own_cover.exists());
        assert!(other_game_cover.exists());
        assert!(detail_image.exists());
        assert!(nested_cover_name.join("cover_42_nested.png").exists());
        assert!(covers.is_dir());

        fs::remove_dir_all(covers.parent().expect("test root should exist"))
            .expect("test files should be cleaned");
    }

    #[tokio::test]
    async fn rejects_a_folder_owned_by_another_game_without_deleting_files() {
        let covers = temporary_cover_directory(7);
        fs::create_dir_all(&covers).expect("cover folder should be created");
        let cover = covers.join("cover_42_20261020.png");
        fs::write(&cover, b"cover").expect("cover should be written");

        let result = delete_game_covers(42, covers.to_string_lossy().into_owned()).await;

        assert!(result.is_err());
        assert!(cover.exists());
        fs::remove_dir_all(covers.parent().expect("test root should exist"))
            .expect("test files should be cleaned");
    }

    #[tokio::test]
    async fn treats_a_missing_cover_folder_as_already_cleared() {
        let covers = temporary_cover_directory(9);

        delete_game_covers(9, covers.to_string_lossy().into_owned())
            .await
            .expect("missing cover folder should be a successful no-op");
    }
}
