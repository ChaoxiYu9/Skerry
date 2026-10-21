//! 7z 压缩/解压工具模块
//!
//! 提供基于 Zstd 的 7z 压缩与解压功能，供存档备份、自定义封面备份等多处复用。

use sevenz_rust2::{
    ArchiveEntry, ArchiveReader, ArchiveWriter, Password, encoder_options::ZstandardOptions,
};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 速度与压缩率折中：使用 Zstd 低压缩等级。
const ZSTD_COMPRESSION_LEVEL: u32 = 3;
const MAX_SAFE_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_SAFE_ARCHIVE_SIZE: u64 = 128 * 1024 * 1024 * 1024;
const MAX_SAFE_ARCHIVE_DEPTH: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SavedataArchiveEntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RootedSavedataArchiveInfo {
    pub root_name: String,
    pub root_kind: SavedataArchiveEntryKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LegacySavedataArchiveInfo {
    pub entry_count: usize,
    pub total_size: u64,
}

/// 创建 7z 压缩包（递归压缩整个目录）
///
/// # Arguments
/// * `source_dir` - 源目录路径
/// * `archive_path` - 目标压缩包路径
///
/// # Returns
/// * `Result<u64, Box<dyn std::error::Error>>` - 压缩包文件大小或错误
pub fn create_7z_archive(
    source_dir: &Path,
    archive_path: &Path,
) -> Result<u64, Box<dyn std::error::Error>> {
    let mut writer = ArchiveWriter::create(archive_path)?;

    let zstd_options = ZstandardOptions::from_level(ZSTD_COMPRESSION_LEVEL);
    log::debug!("7z 压缩参数: codec=ZSTD, level={}", ZSTD_COMPRESSION_LEVEL);
    writer.set_content_methods(vec![zstd_options.into()]);

    // 递归添加源目录中的所有文件，过滤器返回 true 表示包含
    writer.push_source_path(source_dir, |_| true)?;

    writer.finish()?;

    let metadata = fs::metadata(archive_path)?;
    Ok(metadata.len())
}

/// Open a rooted save-data archive after validating its complete entry tree.
pub(super) fn open_rooted_savedata_archive(
    archive_path: &Path,
) -> Result<(ArchiveReader<fs::File>, RootedSavedataArchiveInfo), Box<dyn std::error::Error>> {
    let reader = ArchiveReader::open(archive_path, Password::empty())?;
    let info = inspect_rooted_savedata_entries(&reader.archive().files)?;
    Ok((reader, info))
}

/// Open a 7z archive only after validating its complete filesystem tree.
pub(super) fn open_validated_archive(
    archive_path: &Path,
) -> Result<ArchiveReader<fs::File>, Box<dyn std::error::Error>> {
    let reader = ArchiveReader::open(archive_path, Password::empty())?;
    validate_safe_archive_entries(&reader.archive().files)?;
    Ok(reader)
}

/// Extract a prevalidated archive using the same checked tree rules.
pub(super) fn extract_validated_archive<R: Read + Seek>(
    reader: &mut ArchiveReader<R>,
    stage_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    reader.for_each_entries(|entry, input| {
        let components = parse_safe_archive_entry_path(&entry.name)?;
        let output_path = components
            .iter()
            .fold(stage_dir.to_path_buf(), |path, component| {
                path.join(component)
            });

        if entry.is_directory {
            fs::create_dir_all(&output_path).map_err(sevenz_rust2::Error::from)?;
            return Ok(true);
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(sevenz_rust2::Error::from)?;
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output_path)
            .map_err(sevenz_rust2::Error::from)?;
        let mut bounded_input = input.take(entry.size.saturating_add(1));
        let copied = io::copy(&mut bounded_input, &mut file).map_err(sevenz_rust2::Error::from)?;
        if copied != entry.size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("解压文件大小与归档声明不符: {}", entry.name),
            )
            .into());
        }
        file.flush().map_err(sevenz_rust2::Error::from)?;
        file.sync_all().map_err(sevenz_rust2::Error::from)?;
        Ok(true)
    })?;

    Ok(())
}

/// Open and validate a rootless legacy save archive before the restore owner
/// creates any staged output.
pub(super) fn open_legacy_savedata_archive(
    archive_path: &Path,
) -> Result<(ArchiveReader<fs::File>, LegacySavedataArchiveInfo), Box<dyn std::error::Error>> {
    let reader = ArchiveReader::open(archive_path, Password::empty())?;
    let (entries, total_size) = validate_safe_archive_entries(&reader.archive().files)?;
    Ok((
        reader,
        LegacySavedataArchiveInfo {
            entry_count: entries.len(),
            total_size,
        },
    ))
}

fn inspect_rooted_savedata_entries(
    entries: &[ArchiveEntry],
) -> io::Result<RootedSavedataArchiveInfo> {
    if entries.is_empty() {
        return Err(invalid_archive_tree("归档没有存档内容"));
    }
    let mut root_name: Option<String> = None;
    let mut root_kind: Option<SavedataArchiveEntryKind> = None;
    let (parsed, _) = validate_safe_archive_entries(entries)?;
    for (components, is_directory) in &parsed {
        let current_root = &components[0];
        if root_name
            .as_ref()
            .is_some_and(|previous| previous != current_root)
        {
            return Err(invalid_archive_tree("归档必须只包含一个顶层存档对象"));
        }
        root_name.get_or_insert_with(|| current_root.clone());

        if components.len() == 1 {
            if root_kind.is_some() {
                return Err(invalid_archive_tree("归档顶层存档对象重复"));
            }
            root_kind = Some(if *is_directory {
                SavedataArchiveEntryKind::Directory
            } else {
                SavedataArchiveEntryKind::File
            });
        }
    }

    let root_kind = root_kind.ok_or_else(|| invalid_archive_tree("归档缺少顶层存档对象"))?;
    if root_kind == SavedataArchiveEntryKind::File && entries.len() != 1 {
        return Err(invalid_archive_tree("文件型存档不能包含子条目"));
    }
    if root_kind == SavedataArchiveEntryKind::File
        && parsed.iter().any(|(components, _)| components.len() > 1)
    {
        return Err(invalid_archive_tree("文件型存档不能包含子条目"));
    }

    Ok(RootedSavedataArchiveInfo {
        root_name: root_name.ok_or_else(|| invalid_archive_tree("归档缺少顶层存档对象"))?,
        root_kind,
    })
}

fn validate_safe_archive_entries(
    entries: &[ArchiveEntry],
) -> io::Result<(Vec<(Vec<String>, bool)>, u64)> {
    if entries.len() > MAX_SAFE_ARCHIVE_ENTRIES {
        return Err(invalid_archive_tree("归档条目数量超出支持范围"));
    }

    let mut path_tree = ArchivePathNode::default();
    let mut total_size = 0_u64;
    let mut parsed = Vec::with_capacity(entries.len());
    for entry in entries {
        let components = parse_safe_archive_entry_path(&entry.name)?;
        validate_safe_archive_entry_kind(entry)?;
        total_size = total_size
            .checked_add(entry.size)
            .ok_or_else(|| invalid_archive_tree("归档解压大小溢出"))?;
        if total_size > MAX_SAFE_ARCHIVE_SIZE {
            return Err(invalid_archive_tree("归档解压大小超出支持范围"));
        }
        path_tree.insert(&components, entry.is_directory)?;
        parsed.push((components, entry.is_directory));
    }

    Ok((parsed, total_size))
}

#[derive(Default)]
struct ArchivePathNode {
    spelling: Option<String>,
    kind: Option<ArchivePathKind>,
    children: BTreeMap<String, ArchivePathNode>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArchivePathKind {
    File,
    Directory,
}

impl ArchivePathNode {
    fn insert(&mut self, components: &[String], is_directory: bool) -> io::Result<()> {
        let mut parent = self;
        for component in components {
            if parent.kind == Some(ArchivePathKind::File) {
                return Err(invalid_archive_tree("归档文件不能作为其他条目的父目录"));
            }

            let folded = component.to_lowercase();
            let child = parent.children.entry(folded).or_insert_with(|| Self {
                spelling: Some(component.clone()),
                ..Self::default()
            });
            if child.spelling.as_deref() != Some(component) {
                return Err(invalid_archive_tree("归档包含大小写冲突的路径"));
            }
            parent = child;
        }

        if parent.kind.is_some() {
            return Err(invalid_archive_tree("归档包含重复或大小写别名路径"));
        }
        if !is_directory && !parent.children.is_empty() {
            return Err(invalid_archive_tree("归档文件不能作为其他条目的父目录"));
        }
        parent.kind = Some(if is_directory {
            ArchivePathKind::Directory
        } else {
            ArchivePathKind::File
        });
        Ok(())
    }
}

fn parse_safe_archive_entry_path(name: &str) -> io::Result<Vec<String>> {
    let normalized = name.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.ends_with('/') {
        return Err(invalid_archive_tree("归档路径必须是普通相对路径"));
    }

    let components = normalized.split('/').collect::<Vec<_>>();
    if components.len() > MAX_SAFE_ARCHIVE_DEPTH {
        return Err(invalid_archive_tree("归档目录层级超出支持范围"));
    }
    if components.iter().any(|component| {
        component.is_empty()
            || *component == "."
            || *component == ".."
            || component.contains(':')
            || component.trim_end_matches([' ', '.']) != *component
            || component
                .chars()
                .any(|character| character.is_control() || "<>\"|?*".contains(character))
            || is_savedata_device_name(component)
    }) {
        return Err(invalid_archive_tree("归档路径包含不安全的名称"));
    }

    Ok(components.into_iter().map(str::to_owned).collect())
}

fn validate_safe_archive_entry_kind(entry: &ArchiveEntry) -> io::Result<()> {
    const DEVICE_ATTRIBUTE: u32 = 0x40;
    const REPARSE_POINT_ATTRIBUTE: u32 = 0x400;

    if entry.is_anti_item {
        return Err(invalid_archive_tree("归档包含删除标记"));
    }
    if entry.has_windows_attributes
        && entry.windows_attributes & (DEVICE_ATTRIBUTE | REPARSE_POINT_ATTRIBUTE) != 0
    {
        return Err(invalid_archive_tree("归档包含特殊文件或路径重定向对象"));
    }
    if entry.has_windows_attributes {
        let unix_kind = (entry.windows_attributes >> 16) & 0xf000;
        let expected = if entry.is_directory { 0x4000 } else { 0x8000 };
        if unix_kind != 0 && unix_kind != expected {
            return Err(invalid_archive_tree("归档包含非普通文件系统对象"));
        }
    }
    if (entry.is_directory && entry.has_stream)
        || (!entry.is_directory && !entry.has_stream && entry.size != 0)
    {
        return Err(invalid_archive_tree("归档条目类型与数据流不匹配"));
    }
    Ok(())
}

fn is_savedata_device_name(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CONIN$"
            | "CONOUT$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    )
}

fn invalid_archive_tree(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

pub(super) fn resolve_restore_target(target_dir: &Path) -> io::Result<PathBuf> {
    let file_name = target_dir.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "恢复目标必须是一个具体目录，不能是文件系统根目录",
        )
    })?;

    if target_dir.exists() {
        if !target_dir.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "恢复目标路径不是目录",
            ));
        }
        return fs::canonicalize(target_dir);
    }

    let parent = target_dir
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    Ok(fs::canonicalize(parent)?.join(file_name))
}

pub(super) fn unique_sibling_path(target_dir: &Path, purpose: &str) -> io::Result<PathBuf> {
    let parent = target_dir
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = target_dir
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "恢复目标必须是一个具体目录"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();

    for attempt in 0..100_u8 {
        let candidate = parent.join(format!(
            ".{}.skerry-{purpose}-{timestamp}-{attempt}",
            name.to_string_lossy()
        ));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "无法为恢复操作分配唯一暂存路径",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn legacy_save_archives_allow_rootless_and_empty_content() {
        let entries = [
            ArchiveEntry::new_file("slot.dat"),
            ArchiveEntry::new_directory("settings"),
            ArchiveEntry::new_file("settings/config.ini"),
        ];

        let (parsed, total_size) = validate_safe_archive_entries(&entries).unwrap();

        assert_eq!(parsed.len(), entries.len());
        assert_eq!(total_size, 0);
        assert!(validate_safe_archive_entries(&[]).is_ok());
        assert!(inspect_rooted_savedata_entries(&[]).is_err());
    }

    #[test]
    fn legacy_save_archive_validation_rejects_unsafe_and_ambiguous_trees() {
        for name in ["../escape.dat", "NUL.dat", "folder/file."] {
            assert!(
                validate_safe_archive_entries(&[ArchiveEntry::new_file(name)]).is_err(),
                "unsafe archive path should be rejected: {name}"
            );
        }

        let case_alias = [
            ArchiveEntry::new_directory("SaveData"),
            ArchiveEntry::new_file("savedata/slot.dat"),
        ];
        assert!(validate_safe_archive_entries(&case_alias).is_err());

        let file_parent = [
            ArchiveEntry::new_file("save"),
            ArchiveEntry::new_file("save/slot.dat"),
        ];
        assert!(validate_safe_archive_entries(&file_parent).is_err());
    }

    #[test]
    fn legacy_save_archive_validation_enforces_entry_size_and_depth_limits() {
        let excessive_entries = (0..=MAX_SAFE_ARCHIVE_ENTRIES)
            .map(|index| ArchiveEntry::new_file(&format!("save-{index}.dat")))
            .collect::<Vec<_>>();
        assert!(validate_safe_archive_entries(&excessive_entries).is_err());

        let mut excessive_size = ArchiveEntry::new_file("large-save.dat");
        excessive_size.has_stream = true;
        excessive_size.size = MAX_SAFE_ARCHIVE_SIZE + 1;
        assert!(validate_safe_archive_entries(&[excessive_size]).is_err());

        let excessive_depth = format!(
            "{}{}/save.dat",
            "folder/".repeat(MAX_SAFE_ARCHIVE_DEPTH),
            "nested"
        );
        assert!(
            validate_safe_archive_entries(&[ArchiveEntry::new_file(&excessive_depth)]).is_err()
        );
    }

    #[test]
    fn zstd_archive_round_trip() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skerry_archive_test_{unique}"));
        let source = root.join("source");
        let archive = root.join("backup.7z");
        let target = root.join("target");
        let content = b"Skerry Zstd archive test";

        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("savedata.bin"), content).unwrap();
        fs::create_dir_all(&target).unwrap();

        create_7z_archive(&source, &archive).unwrap();
        let mut reader = open_validated_archive(&archive).unwrap();
        extract_validated_archive(&mut reader, &target).unwrap();

        assert_eq!(fs::read(target.join("savedata.bin")).unwrap(), content);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_archive_preserves_existing_restore_target() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("skerry_invalid_restore_test_{unique}"));
        let archive = root.join("invalid.7z");
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        fs::write(&archive, b"not a 7z archive").unwrap();
        fs::write(target.join("existing.sav"), b"keep this save").unwrap();

        assert!(open_validated_archive(&archive).is_err());
        assert_eq!(
            fs::read(target.join("existing.sav")).unwrap(),
            b"keep this save"
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rooted_savedata_inspection_requires_one_safe_file_or_directory_root() {
        let directory = [
            ArchiveEntry::new_directory("SaveData"),
            ArchiveEntry::new_file("SaveData/slot.dat"),
        ];
        let info = inspect_rooted_savedata_entries(&directory).unwrap();
        assert_eq!(info.root_name, "SaveData");
        assert_eq!(info.root_kind, SavedataArchiveEntryKind::Directory);

        let file = [ArchiveEntry::new_file("save.dat")];
        let info = inspect_rooted_savedata_entries(&file).unwrap();
        assert_eq!(info.root_name, "save.dat");
        assert_eq!(info.root_kind, SavedataArchiveEntryKind::File);
    }

    #[test]
    fn rooted_savedata_inspection_rejects_unsafe_or_ambiguous_entries() {
        for entries in [
            vec![ArchiveEntry::new_file("../escape")],
            vec![ArchiveEntry::new_file("C:/save.dat")],
            vec![ArchiveEntry::new_file("NUL.dat")],
            vec![
                ArchiveEntry::new_directory("SaveData"),
                ArchiveEntry::new_file("Other/slot.dat"),
            ],
            vec![
                ArchiveEntry::new_directory("SaveData"),
                ArchiveEntry::new_file("SaveData/slot.dat"),
                ArchiveEntry::new_file("savedata/SLOT.DAT"),
            ],
            vec![
                ArchiveEntry::new_file("SaveData"),
                ArchiveEntry::new_file("SaveData/slot.dat"),
            ],
        ] {
            assert!(inspect_rooted_savedata_entries(&entries).is_err());
        }

        let mut reparse_point = ArchiveEntry::new_file("SaveData/save.dat");
        reparse_point.has_windows_attributes = true;
        reparse_point.windows_attributes = 0x400;
        assert!(
            inspect_rooted_savedata_entries(&[
                ArchiveEntry::new_directory("SaveData"),
                reparse_point,
            ])
            .is_err()
        );
    }
}
