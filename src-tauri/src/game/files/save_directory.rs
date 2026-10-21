use crate::database::dto::FullGameData;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

const SAVE_FILE_EXTENSIONS: &[&str] = &[
    "sav", "dat", "save", "sfs", "rpgsave", "rvdata", "rvdata2", "json", "xml", "yaml", "yml",
    "cfg", "config", "backup",
];

const SAVE_FILE_KEYWORDS: &[&str] = &[
    "save",
    "sav",
    "slot",
    "data",
    "record",
    "progress",
    "file",
    "state",
    "status",
    "profile",
    "account",
    "user",
    "game",
    "session",
    "checkpoint",
    "quick",
    "auto",
];

const SAVE_DIRECTORY_PATTERNS: &[&str] = &[
    "save",
    "saves",
    "savedata",
    "save_data",
    "userdata",
    "user_data",
    "data",
    "game",
    "games",
    "appdata",
    "local",
    "roaming",
];

const SAVE_DIRECTORY_SUFFIXES: &[&str] = &[
    "data",
    "save",
    "saves",
    "games",
    "game",
    "user",
    "profile",
    "config",
    "settings",
    "storage",
    "backup",
    "cache",
    "temp",
    "local",
    "roaming",
    "存档",
    "保存",
    "数据",
    "配置",
    "设置",
    "档案",
    "记录",
    "进度",
    "system",
    "content",
    "resources",
    "assets",
    "files",
    "documents",
    "セーブ",
    "データ",
    "設定",
    "システム",
    "コンフィグ",
];

const CHINESE_LOCALIZATION_SUFFIXES: &[&str] = &[
    "chs",
    "cht",
    "cn",
    "zh",
    "zhcn",
    "zhtw",
    "sc",
    "tc",
    "chinese",
    "简体",
    "繁体",
    "中文",
    "汉化",
    "汉化版",
    "steam简中",
];

const EXCLUDE_PATH_KEYWORDS: &[&str] = &[
    "potatovn",
    ".potatovn",
    "potato vn",
    "potato-vn",
    "potato_vn",
    "skerry",
    "windows",
    "system32",
    "syswow64",
    "drivers",
    "driverstore",
    "servicing",
    "microsoft",
    "winsxs",
    "program files",
    "program files (x86)",
    "programdata",
    "steamapps",
    "epic games",
    "uplay",
    "ubisoft",
    "origin",
    "ea games",
    "gog",
    "battle.net",
    "blizzard",
    "riot games",
    "discord",
    "visual studio",
    "msbuild",
    "nuget",
    "dotnet",
    "sdk",
    "vscode",
    "android",
    "google",
    "chrome",
    "mozilla",
    "firefox",
    "edge",
    "opera",
    "wechat",
    "qq",
    "nvidia",
    "amd",
    "intel",
    "cache",
    "caches",
    "temporary",
    "logs",
    "log",
    "$recycle.bin",
    "system volume information",
];

const GAME_DIRECTORY_DEPTH: usize = 5;
const USER_DATA_DIRECTORY_DEPTH: usize = 3;
const MAX_ENTRIES_PER_ROOT: usize = 2_600;
const MAX_GAME_NAME_ROOTS_PER_USER_ROOT: usize = 24;

struct SearchRoot {
    path: PathBuf,
    depth: usize,
}

#[derive(Default)]
struct DirectoryEvidence {
    game_named: bool,
    save_directory_name: bool,
    localization_name: bool,
    under_game_directory: bool,
    save_files: usize,
    save_named_files: usize,
    save_extension_files: usize,
    plausible_size_files: usize,
    common_size_files: usize,
    recently_changed_files: usize,
    newest_change: Option<SystemTime>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct DirectoryRank {
    game_named_with_save_file: bool,
    has_save_file: bool,
    game_named: bool,
    save_directory_name: bool,
    localization_name: bool,
    under_game_directory: bool,
    save_files: usize,
    save_named_files: usize,
    save_extension_files: usize,
    plausible_size_files: usize,
    common_size_files: usize,
    recently_changed_files: usize,
    newest_change: Option<SystemTime>,
}

impl DirectoryEvidence {
    fn is_candidate(&self) -> bool {
        self.game_named || self.save_directory_name || self.save_files > 0
    }

    fn rank(&self) -> DirectoryRank {
        DirectoryRank {
            game_named_with_save_file: self.game_named && self.save_files > 0,
            has_save_file: self.save_files > 0,
            game_named: self.game_named,
            save_directory_name: self.save_directory_name,
            localization_name: self.localization_name,
            under_game_directory: self.under_game_directory,
            save_files: self.save_files,
            save_named_files: self.save_named_files,
            save_extension_files: self.save_extension_files,
            plausible_size_files: self.plausible_size_files,
            common_size_files: self.common_size_files,
            recently_changed_files: self.recently_changed_files,
            newest_change: self.newest_change,
        }
    }

    fn add_directory(
        &mut self,
        path: &Path,
        keywords: &BTreeSet<String>,
        game_root: Option<&Path>,
    ) {
        self.game_named |= path_matches_game(path, keywords);
        let path_text = path.to_string_lossy();
        self.save_directory_name |= contains_any(&path_text, SAVE_DIRECTORY_PATTERNS)
            || contains_any(&path_text, SAVE_DIRECTORY_SUFFIXES);
        self.localization_name |= contains_any(&path_text, CHINESE_LOCALIZATION_SUFFIXES);
        self.under_game_directory |= game_root.is_some_and(|root| path.starts_with(root));
    }

    fn add_save_file(
        &mut self,
        path: &Path,
        keywords: &BTreeSet<String>,
        game_root: Option<&Path>,
    ) {
        let name = lower_file_name(path);
        let extension = has_save_extension(path);
        let named = contains_any(&name, SAVE_FILE_KEYWORDS);
        if !extension && !named {
            return;
        }

        self.game_named |= path_matches_game(path, keywords);
        self.under_game_directory |= game_root.is_some_and(|root| path.starts_with(root));
        self.save_files = self.save_files.saturating_add(1);
        if named {
            self.save_named_files = self.save_named_files.saturating_add(1);
        }
        if extension {
            self.save_extension_files = self.save_extension_files.saturating_add(1);
        }

        if let Ok(metadata) = fs::metadata(path) {
            let size = metadata.len();
            if (100..100 * 1024 * 1024).contains(&size) {
                self.plausible_size_files = self.plausible_size_files.saturating_add(1);
            }
            if (1024..10 * 1024 * 1024).contains(&size) {
                self.common_size_files = self.common_size_files.saturating_add(1);
            }
            if let Ok(modified) = metadata.modified() {
                if modified
                    .elapsed()
                    .is_ok_and(|elapsed| elapsed.as_secs() < 24 * 60 * 60)
                {
                    self.recently_changed_files = self.recently_changed_files.saturating_add(1);
                }
                self.newest_change = self.newest_change.max(Some(modified));
            }
        }
    }
}

pub(super) fn discover(game: &FullGameData) -> Option<PathBuf> {
    discover_from_roots(game, standard_user_roots())
}

fn discover_from_roots(game: &FullGameData, user_roots: Vec<PathBuf>) -> Option<PathBuf> {
    if let Some(savepath) = game.savepath.as_deref() {
        let configured_path = PathBuf::from(savepath);
        if configured_path.is_dir() {
            return Some(configured_path);
        }
    }

    let keywords = game_keywords(game);
    let game_root = game.localpath.as_deref().map(PathBuf::from);
    let roots = search_roots(game_root.as_deref(), &user_roots, &keywords);
    let mut visited_paths = HashSet::new();
    let mut candidates = BTreeMap::<PathBuf, DirectoryEvidence>::new();

    for root in roots {
        if !root.path.exists() || should_exclude_path(&root.path, game_root.as_deref()) {
            continue;
        }

        for entry in WalkDir::new(&root.path)
            .max_depth(root.depth)
            .follow_links(false)
            .sort_by_file_name()
            .into_iter()
            .filter_map(Result::ok)
            .take(MAX_ENTRIES_PER_ROOT)
        {
            let path = entry.path();
            if !visited_paths.insert(path.to_path_buf())
                || should_exclude_path(path, game_root.as_deref())
            {
                continue;
            }

            if entry.file_type().is_dir() {
                candidates
                    .entry(path.to_path_buf())
                    .or_default()
                    .add_directory(path, &keywords, game_root.as_deref());
                continue;
            }

            if !entry.file_type().is_file() {
                continue;
            }
            let Some(directory) = path.parent() else {
                continue;
            };
            candidates
                .entry(directory.to_path_buf())
                .or_default()
                .add_save_file(path, &keywords, game_root.as_deref());
        }
    }

    candidates
        .into_iter()
        .filter(|(directory, evidence)| directory.is_dir() && evidence.is_candidate())
        .max_by(|(left_path, left), (right_path, right)| {
            compare_candidates(left_path, left, right_path, right)
        })
        .map(|(directory, _)| directory)
}

fn compare_candidates(
    left_path: &Path,
    left: &DirectoryEvidence,
    right_path: &Path,
    right: &DirectoryEvidence,
) -> std::cmp::Ordering {
    let left_key = left_path.to_string_lossy().to_lowercase();
    let right_key = right_path.to_string_lossy().to_lowercase();
    left.rank()
        .cmp(&right.rank())
        .then_with(|| right_key.cmp(&left_key))
        .then_with(|| right_path.cmp(left_path))
}

fn search_roots(
    game_root: Option<&Path>,
    user_roots: &[PathBuf],
    keywords: &BTreeSet<String>,
) -> Vec<SearchRoot> {
    let mut roots = Vec::new();
    if let Some(game_root) = game_root {
        push_search_root(&mut roots, game_root.to_path_buf(), GAME_DIRECTORY_DEPTH);
    }

    for user_root in user_roots {
        push_search_root(&mut roots, user_root.clone(), USER_DATA_DIRECTORY_DEPTH);
        for keyword in keywords.iter().take(MAX_GAME_NAME_ROOTS_PER_USER_ROOT) {
            push_search_root(
                &mut roots,
                user_root.join(keyword),
                USER_DATA_DIRECTORY_DEPTH,
            );
        }
    }
    roots
}

fn push_search_root(roots: &mut Vec<SearchRoot>, path: PathBuf, depth: usize) {
    if roots.iter().any(|root| root.path == path) {
        return;
    }
    roots.push(SearchRoot { path, depth });
}

fn standard_user_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(profile) = env::var_os("USERPROFILE") {
        let user = PathBuf::from(profile);
        push_unique_path(&mut roots, user.clone());
        push_unique_path(&mut roots, user.join("Documents"));
        push_unique_path(&mut roots, user.join("Documents").join("My Games"));
        push_unique_path(&mut roots, user.join("Saved Games"));
    }
    for key in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(path) = env::var_os(key) {
            push_unique_path(&mut roots, PathBuf::from(path));
        }
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local_app_data);
        if let Some(parent) = local.parent() {
            push_unique_path(&mut roots, parent.join("LocalLow"));
        }
    }
    roots
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !path.as_os_str().is_empty() && !paths.contains(&path) {
        paths.push(path);
    }
}

fn game_keywords(game: &FullGameData) -> BTreeSet<String> {
    let mut keywords = BTreeSet::new();
    if let Some(custom) = &game.custom_data {
        for value in [
            custom.name.as_deref(),
            custom.name_cn.as_deref(),
            custom.developer.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            push_clean_keyword(&mut keywords, value);
        }
        if let Some(aliases) = &custom.aliases {
            for alias in aliases {
                push_clean_keyword(&mut keywords, alias);
            }
        }
    }

    for source in &game.sources {
        if let Some(data) = &source.data {
            collect_value_strings(
                data,
                &[
                    "name",
                    "name_cn",
                    "developer",
                    "aliases",
                    "all_titles",
                    "title",
                ],
                &mut keywords,
            );
        }
    }
    keywords.retain(|keyword| keyword.chars().count() >= 2);
    keywords
}

fn collect_value_strings(value: &Value, keys: &[&str], keywords: &mut BTreeSet<String>) {
    let Some(object) = value.as_object() else {
        return;
    };
    for key in keys {
        match object.get(*key) {
            Some(Value::String(value)) => push_clean_keyword(keywords, value),
            Some(Value::Array(values)) => {
                for value in values.iter().filter_map(Value::as_str) {
                    push_clean_keyword(keywords, value);
                }
            }
            _ => {}
        }
    }
}

fn push_clean_keyword(keywords: &mut BTreeSet<String>, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    let lower = value.to_lowercase();
    keywords.insert(lower.clone());
    let compact = compact_name(&lower);
    if compact.len() >= 3 {
        keywords.insert(compact);
    }
}

fn compact_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            !character.is_whitespace()
                && !matches!(character, '_' | '-' | '.' | ':' | '!' | '！' | '・' | '·')
        })
        .collect()
}

fn path_matches_game(path: &Path, keywords: &BTreeSet<String>) -> bool {
    let path = path.to_string_lossy().to_lowercase();
    keywords
        .iter()
        .any(|keyword| keyword.len() >= 3 && path.contains(keyword))
}

fn should_exclude_path(path: &Path, game_root: Option<&Path>) -> bool {
    if game_root.is_some_and(|root| path.starts_with(root)) {
        return false;
    }
    let lower = path.to_string_lossy().to_lowercase();
    EXCLUDE_PATH_KEYWORDS
        .iter()
        .any(|keyword| lower.contains(keyword))
}

fn contains_any(value: &str, patterns: &[&str]) -> bool {
    let lower = value.to_lowercase();
    patterns
        .iter()
        .any(|pattern| lower.contains(&pattern.to_lowercase()))
}

fn lower_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

fn has_save_extension(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        SAVE_FILE_EXTENSIONS
            .iter()
            .any(|expected| extension.eq_ignore_ascii_case(expected))
    })
}

#[cfg(test)]
mod tests {
    use super::{DirectoryEvidence, FullGameData, compare_candidates, discover_from_roots};
    use crate::entity::custom_data::CustomData;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            loop {
                let sequence = ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let root = std::env::temp_dir().join(format!(
                    "backend-save-directory-{label}-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&root) {
                    Ok(()) => return Self(root),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("create test root: {error}"),
                }
            }
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn game(name: &str) -> FullGameData {
        FullGameData {
            id: 1,
            id_type: "local".to_string(),
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
            custom_data: Some(CustomData {
                name: Some(name.to_string()),
                ..CustomData::default()
            }),
            sources: Vec::new(),
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn a_valid_saved_path_remains_the_first_choice() {
        let root = TestRoot::new("configured-path");
        let configured = root.path().join("my-saves");
        fs::create_dir(&configured).unwrap();
        let mut game = game("Game Seren");
        game.savepath = Some(configured.to_string_lossy().into_owned());

        assert_eq!(
            discover_from_roots(&game, vec![root.path().to_path_buf()]),
            Some(configured)
        );
    }

    #[test]
    fn title_matched_save_files_outweigh_unrelated_directories_with_more_files() {
        let root = TestRoot::new("title-match");
        let title_save = root.path().join("Game Seren").join("SaveData");
        let unrelated_save = root.path().join("Shared").join("savedata");
        fs::create_dir_all(&title_save).unwrap();
        fs::create_dir_all(&unrelated_save).unwrap();
        fs::write(title_save.join("slot.sav"), b"save").unwrap();
        for index in 0..8 {
            fs::write(unrelated_save.join(format!("slot-{index}.sav")), b"save").unwrap();
        }

        let detected = discover_from_roots(&game("Game Seren"), vec![root.path().to_path_buf()]);

        assert_eq!(detected, Some(title_save));
    }

    #[test]
    fn existing_save_files_outweigh_a_title_named_but_empty_directory() {
        let root = TestRoot::new("existing-files");
        let title_directory = root.path().join("Game Seren");
        let save_directory = root.path().join("SharedSave");
        fs::create_dir_all(&title_directory).unwrap();
        fs::create_dir_all(&save_directory).unwrap();
        fs::write(save_directory.join("slot1.rpgsave"), b"save").unwrap();

        let detected = discover_from_roots(&game("Game Seren"), vec![root.path().to_path_buf()]);

        assert_eq!(detected, Some(save_directory));
    }

    #[test]
    fn equal_evidence_uses_a_stable_case_insensitive_path_order() {
        let mut left = DirectoryEvidence::default();
        left.save_directory_name = true;
        let right = DirectoryEvidence {
            save_directory_name: true,
            ..DirectoryEvidence::default()
        };
        let left_path = PathBuf::from(r"C:\Users\User\AppData\Roaming\Alpha\save");
        let right_path = PathBuf::from(r"C:\Users\User\AppData\Roaming\Beta\save");
        assert_eq!(left.rank(), right.rank());
        assert!(compare_candidates(&left_path, &left, &right_path, &right).is_gt());
    }
}
