//! Derived card images. Originals remain authoritative; only this cache is evictable.
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageReader, Limits};
use tokio::sync::Semaphore;

// At most two full-size decodes can occupy memory/CPU at once. Browser requests
// are already limited to the mounted viewport and its neighbouring rows.
static DECODERS: Semaphore = Semaphore::const_new(2);
static NEEDS_INITIAL_PRUNE: AtomicBool = AtomicBool::new(true);
static BYTES_SINCE_PRUNE: AtomicU64 = AtomicU64::new(0);
static PRUNING: AtomicBool = AtomicBool::new(false);
const CACHE_BUDGET_BYTES: u64 = 512 * 1024 * 1024;
const PRUNE_INTERVAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;
pub const CARD_WIDTHS: &[u32] = &[256, 384, 512, 768];

pub fn parse_card_width(value: &str) -> Option<u32> {
    let width = value.parse().ok()?;
    CARD_WIDTHS.contains(&width).then_some(width)
}

/// A local cover token is a filename suffix, never an arbitrary filesystem path.
pub fn local_cover_path(directory: &Path, game_id: i64, token: &str) -> Option<PathBuf> {
    if token.is_empty()
        || token.len() > 200
        || token.contains(['/', '\\', ':', '\0'])
        || token == "."
        || token == ".."
    {
        return None;
    }
    Some(directory.join(format!("cover_{game_id}_{token}")))
}

fn cache_path(root: &Path, source: &Path, metadata: &fs::Metadata, width: u32) -> PathBuf {
    let mut key = blake3::Hasher::new();
    key.update(source.as_os_str().as_encoded_bytes());
    key.update(&metadata.len().to_le_bytes());
    key.update(
        &metadata
            .modified()
            .unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    root.join(format!("{}-{width}.webp", key.finalize().to_hex()))
}

fn create_thumbnail(source: &Path, destination: &Path, width: u32) -> Result<Vec<u8>, String> {
    let mut reader = ImageReader::open(source)
        .map_err(|error| format!("open card cover: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("detect card cover format: {error}"))?;
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("prepare card cover decoder: {error}"))?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("decode card cover: {error}"))?;
    image.apply_orientation(orientation);
    // Crop identically to the card's 2:3 object-fit:cover, without upscaling.
    let target_width = width.min(image.width()).min(image.height() * 2 / 3).max(2);
    let cover = image
        .resize_to_fill(
            target_width,
            target_width * 3 / 2,
            image::imageops::FilterType::Triangle,
        )
        .to_rgba8();
    let mut bytes = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
        .write_image(
            cover.as_raw(),
            cover.width(),
            cover.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| format!("encode card thumbnail: {error}"))?;
    let root = destination
        .parent()
        .ok_or("missing card thumbnail directory")?;
    fs::create_dir_all(root).map_err(|error| format!("create card thumbnail cache: {error}"))?;
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = destination.with_extension(format!("part-{suffix}"));
    fs::write(&temporary, &bytes).map_err(|error| format!("write card thumbnail: {error}"))?;
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        // A second request may have finished the same derived image first.
        if !destination.is_file() {
            return Err(format!("publish card thumbnail: {error}"));
        }
    }
    Ok(bytes)
}

fn prune_cache(root: &Path, budget: u64) -> Result<(), String> {
    let mut entries = Vec::new();
    let mut total = 0_u64;
    for entry in fs::read_dir(root).map_err(|error| format!("read card cache: {error}"))? {
        let entry = entry.map_err(|error| format!("read card cache entry: {error}"))?;
        let path = entry.path();
        // Maintenance is confined to generated WebP files in this one directory.
        if path.extension().is_none_or(|extension| extension != "webp") {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("stat card cache: {error}"))?;
        if !metadata.is_file() {
            continue;
        }
        total = total.saturating_add(metadata.len());
        entries.push((
            metadata.modified().unwrap_or(UNIX_EPOCH),
            metadata.len(),
            path,
        ));
    }
    entries.sort_unstable_by_key(|(modified, _, _)| *modified);
    for (_, length, path) in entries {
        if total <= budget {
            break;
        }
        match fs::remove_file(&path) {
            Ok(()) => total = total.saturating_sub(length),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                total = total.saturating_sub(length)
            }
            Err(error) => return Err(format!("evict card thumbnail: {error}")),
        }
    }
    Ok(())
}

fn schedule_prune(root: PathBuf, added_bytes: u64) {
    let accumulated = BYTES_SINCE_PRUNE.fetch_add(added_bytes, Ordering::Relaxed) + added_bytes;
    if !NEEDS_INITIAL_PRUNE.load(Ordering::Relaxed) && accumulated < PRUNE_INTERVAL_BYTES {
        return;
    }
    if PRUNING.swap(true, Ordering::AcqRel) {
        return;
    }
    NEEDS_INITIAL_PRUNE.store(false, Ordering::Relaxed);
    BYTES_SINCE_PRUNE.store(0, Ordering::Relaxed);
    tokio::task::spawn_blocking(move || {
        if let Err(error) = prune_cache(&root, CACHE_BUDGET_BYTES) {
            log::warn!("card thumbnail maintenance: {error}");
        }
        PRUNING.store(false, Ordering::Release);
    });
}

pub async fn read_cover_file(
    source: &Path,
    width: Option<u32>,
) -> Result<(PathBuf, Vec<u8>), String> {
    if let Some(width) = width {
        let root = skerry_path::get_base_data_dir()?
            .join("cache")
            .join("card-thumbnails-v1");
        let metadata = tokio::fs::metadata(source)
            .await
            .map_err(|error| format!("stat cover: {error}"))?;
        let destination = cache_path(&root, source, &metadata, width);
        if let Ok(bytes) = tokio::fs::read(&destination).await {
            schedule_prune(root, 0);
            return Ok((destination, bytes));
        }
        let _permit = DECODERS
            .acquire()
            .await
            .map_err(|error| format!("queue card thumbnail: {error}"))?;
        if let Ok(bytes) = tokio::fs::read(&destination).await {
            return Ok((destination, bytes));
        }
        let source_path = source.to_owned();
        let output_path = destination.clone();
        match tokio::task::spawn_blocking(move || {
            create_thumbnail(&source_path, &output_path, width)
        })
        .await
        {
            Ok(Ok(bytes)) => {
                schedule_prune(root, u64::try_from(bytes.len()).unwrap_or(u64::MAX));
                return Ok((destination, bytes));
            }
            Ok(Err(error)) => log::warn!("card thumbnail fallback: {error}"),
            Err(error) => log::warn!("card thumbnail worker failed: {error}"),
        }
    }
    let bytes = tokio::fs::read(source)
        .await
        .map_err(|error| format!("read cover: {error}"))?;
    Ok((source.to_owned(), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_derivative_is_bounded_reusable_and_never_changes_the_original() {
        let root = std::env::temp_dir().join(format!("skerry-card-{}", getrandom::u64().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("original.png");
        image::RgbaImage::from_pixel(1200, 800, image::Rgba([210, 120, 80, 128]))
            .save(&source)
            .unwrap();
        let original = fs::read(&source).unwrap();
        let destination = cache_path(&root, &source, &fs::metadata(&source).unwrap(), 256);
        let bytes = create_thumbnail(&source, &destination, 256).unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (256, 384));
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(decoded.to_rgba8().get_pixel(128, 192)[3], 128);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_replacement_changes_the_cache_key_and_eviction_only_removes_derivatives() {
        let root = std::env::temp_dir().join(format!("skerry-card-{}", getrandom::u64().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("original.png");
        fs::write(&source, b"first").unwrap();
        let first = cache_path(&root, &source, &fs::metadata(&source).unwrap(), 256);
        fs::write(&source, b"replacement bytes").unwrap();
        let second = cache_path(&root, &source, &fs::metadata(&source).unwrap(), 256);
        assert_ne!(first, second);
        assert_ne!(
            second,
            cache_path(&root, &source, &fs::metadata(&source).unwrap(), 512)
        );
        fs::write(&first, b"cached thumbnail").unwrap();
        fs::write(&second, b"cached thumbnail").unwrap();
        prune_cache(&root, 16).unwrap();
        assert!(source.exists());
        assert!(!(first.exists() && second.exists()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn card_request_accepts_only_supported_sizes_and_local_filename_tokens() {
        assert_eq!(parse_card_width("512"), Some(512));
        assert_eq!(parse_card_width("100000"), None);
        for token in ["../outside.jpg", "..\\outside.jpg", "C:outside", ""] {
            assert!(local_cover_path(Path::new("covers/game_7"), 7, token).is_none());
        }
        assert_eq!(
            local_cover_path(Path::new("covers/game_7"), 7, "timestamp.jpg").unwrap(),
            Path::new("covers/game_7/cover_7_timestamp.jpg")
        );
    }
}
