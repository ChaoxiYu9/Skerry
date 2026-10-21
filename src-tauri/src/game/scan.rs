use crate::database::repository::game_import_repository::GameImportRepository;
use crate::game::import_path_index::ImportPathIndex;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Instant;

mod candidate_rules;
use candidate_rules::{
    directory_exclusion_reason, executable_exclusion_reason, has_supported_executable_extension,
    sort_executables, trim_dirname_to_search_name,
};

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanResult {
    pub name: String,
    pub path: String,
    pub executables: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanMode {
    Executable,
    FirstLevelDirectory,
}

const MIN_SCAN_MAX_DEPTH: usize = 2;
const MAX_SCAN_MAX_DEPTH: usize = 5;

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn scan_directory_for_games(
    db: tauri::State<'_, DatabaseConnection>,
    path: String,
    max_depth: usize,
    scan_mode: ScanMode,
) -> Result<Vec<ScanResult>, String> {
    scan_directory_for_games_with_db(&db, path, max_depth, scan_mode).await
}

pub async fn scan_directory_for_games_with_db(
    db: &DatabaseConnection,
    path: String,
    max_depth: usize,
    scan_mode: ScanMode,
) -> Result<Vec<ScanResult>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("目录不存在或不是文件夹: {path}"));
    }
    let stored_paths = GameImportRepository::get_all_game_directories(db)
        .await
        .map_err(|error| format!("查询已有路径失败: {error}"))?;
    let bounded_depth = max_depth.clamp(MIN_SCAN_MAX_DEPTH, MAX_SCAN_MAX_DEPTH);
    let started_at = Instant::now();
    let task_path = path.clone();

    let results = tokio::task::spawn_blocking(move || {
        let imported_paths = ImportPathIndex::from_paths(stored_paths);
        log::debug!(
            "开始扫描游戏目录 path={} mode={:?} max_depth={} existing_paths={}",
            path,
            scan_mode,
            bounded_depth,
            imported_paths.len()
        );
        match scan_mode {
            ScanMode::Executable => {
                scan_executable_games_blocking(path, imported_paths, bounded_depth)
            }
            ScanMode::FirstLevelDirectory => {
                Ok(scan_direct_child_directories(path, imported_paths))
            }
        }
    })
    .await
    .map_err(|error| {
        log::error!(
            "扫描任务异常 path={} mode={:?} max_depth={}: {}",
            task_path,
            scan_mode,
            bounded_depth,
            error
        );
        format!("扫描任务异常: {error}")
    })??;

    log::info!(
        "游戏目录扫描完成 mode={:?} max_depth={} result_count={} elapsed_ms={}",
        scan_mode,
        bounded_depth,
        results.len(),
        started_at.elapsed().as_millis()
    );
    Ok(results)
}

fn scan_direct_child_directories(path: String, existing_paths: ImportPathIndex) -> Vec<ScanResult> {
    let mut results = Vec::new();
    let Ok(directories) = std::fs::read_dir(path) else {
        return results;
    };

    for entry in directories.flatten() {
        let child = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir()
            || directory_exclusion_reason(&entry.file_name().to_string_lossy()).is_some()
            || existing_paths.is_imported_or_descendant(&child)
        {
            continue;
        }
        let Some(name) = child.file_name().map(|name| name.to_string_lossy()) else {
            continue;
        };

        let mut executables = immediate_executables(&child);
        let name = trim_dirname_to_search_name(&name);
        sort_executables(&mut executables, &name);
        results.push(ScanResult {
            name,
            path: child.to_string_lossy().into_owned(),
            executables,
        });
    }
    sort_scan_results(&mut results);
    results
}

fn immediate_executables(directory: &Path) -> Vec<String> {
    let mut executables = std::fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let is_candidate = entry.file_type().ok()?.is_file()
                && executable_exclusion_reason(&path).is_none()
                && has_supported_executable_extension(&path);
            if !is_candidate {
                return None;
            }
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect::<Vec<_>>();
    executables.sort();
    executables
}

fn sort_scan_results(results: &mut [ScanResult]) {
    results.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn scan_executable_games_blocking(
    path: String,
    existing_paths: ImportPathIndex,
    max_depth: usize,
) -> Result<Vec<ScanResult>, String> {
    let mut pending = vec![(PathBuf::from(path), 0_usize)];
    let mut results = Vec::new();

    while let Some((directory, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        let mut children = Vec::new();
        let mut executables = Vec::new();

        for entry in entries.flatten() {
            let entry_path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                let child_depth = depth + 1;
                if child_depth < max_depth
                    && directory_exclusion_reason(&entry.file_name().to_string_lossy()).is_none()
                    && !existing_paths.is_imported_or_descendant(&entry_path)
                {
                    children.push(entry_path);
                }
                continue;
            }
            if depth == 0
                || !kind.is_file()
                || !has_supported_executable_extension(&entry_path)
                || executable_exclusion_reason(&entry_path).is_some()
            {
                continue;
            }
            if let Some(name) = entry_path.file_name() {
                executables.push(name.to_string_lossy().into_owned());
            }
        }

        if depth > 0 && !executables.is_empty() {
            if let Some(folder_name) = directory.file_name() {
                let name = trim_dirname_to_search_name(&folder_name.to_string_lossy());
                sort_executables(&mut executables, &name);
                results.push(ScanResult {
                    name,
                    path: directory.to_string_lossy().into_owned(),
                    executables,
                });
                continue;
            }
        }
        pending.extend(children.into_iter().map(|child| (child, depth + 1)));
    }

    sort_scan_results(&mut results);
    Ok(results)
}
#[cfg(test)]
mod tests {
    use super::{
        ImportPathIndex, scan_direct_child_directories, scan_executable_games_blocking,
        sort_executables, trim_dirname_to_search_name,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_path(parts: &[&str]) -> PathBuf {
        parts.iter().collect()
    }

    #[test]
    fn trim_dirname_removes_common_tags() {
        assert_eq!(
            trim_dirname_to_search_name("[社团名] 游戏名 (完整版)"),
            "游戏名"
        );
        assert_eq!(
            trim_dirname_to_search_name("【品牌】 游戏名 （初回版）"),
            "游戏名"
        );
    }

    #[test]
    fn trim_dirname_falls_back_when_everything_is_removed() {
        assert_eq!(trim_dirname_to_search_name("[社团名]"), "[社团名]");
    }

    #[test]
    fn executable_sort_prioritizes_han_names_without_kana() {
        let mut executables = vec![
            "Game.exe".to_string(),
            "死に逝く君.exe".to_string(),
            "Game_chs.exe".to_string(),
            "游戏.exe".to_string(),
        ];

        sort_executables(&mut executables, "Game");

        assert_eq!(
            executables,
            ["Game_chs.exe", "游戏.exe", "Game.exe", "死に逝く君.exe"]
        );
    }

    #[test]
    fn executable_sort_deprioritizes_startup() {
        let mut executables = vec![
            "Game_startup.exe".to_string(),
            "Game_chs.exe".to_string(),
            "Game.exe".to_string(),
        ];

        sort_executables(&mut executables, "Game");

        assert_eq!(
            executables,
            ["Game_chs.exe", "Game.exe", "Game_startup.exe"]
        );
    }

    #[test]
    fn executable_sort_orders_multiple_priority_signals_as_rank_bands() {
        let mut executables = vec![
            "Game_startup_chs.exe".to_string(),
            "Game.exe".to_string(),
            "A.exe".to_string(),
            "汉Game.exe".to_string(),
            "Other_cn.exe".to_string(),
        ];

        sort_executables(&mut executables, "Game");

        assert_eq!(
            executables,
            [
                "Other_cn.exe",
                "汉Game.exe",
                "Game.exe",
                "A.exe",
                "Game_startup_chs.exe"
            ]
        );
    }

    #[test]
    fn executable_sort_uses_exact_name_to_break_case_only_ties() {
        let mut executables = vec!["game.exe".to_string(), "Game.exe".to_string()];

        sort_executables(&mut executables, "Game");

        assert_eq!(executables, ["Game.exe", "game.exe"]);
    }

    #[test]
    fn executable_sort_prefers_language_marker_before_han_script() {
        let mut executables = vec!["游戏.exe".to_string(), "other_cn.exe".to_string()];

        sort_executables(&mut executables, "Game");

        assert_eq!(executables, ["other_cn.exe", "游戏.exe"]);
    }

    #[test]
    fn executable_sort_prefers_han_without_kana_before_game_name_match() {
        let mut executables = vec!["Game.exe".to_string(), "游戏.exe".to_string()];

        sort_executables(&mut executables, "Game");

        assert_eq!(executables, ["游戏.exe", "Game.exe"]);
    }

    #[test]
    fn executable_sort_prefers_game_name_match_before_shorter_filename() {
        let mut executables = vec!["x.exe".to_string(), "VeryLongGameName.exe".to_string()];

        sort_executables(&mut executables, "Game");

        assert_eq!(executables, ["VeryLongGameName.exe", "x.exe"]);
    }

    #[test]
    fn executable_sort_prefers_shorter_filename_before_alphabetical_order() {
        let mut executables = vec!["aa.exe".to_string(), "z.exe".to_string()];

        sort_executables(&mut executables, "Missing");

        assert_eq!(executables, ["z.exe", "aa.exe"]);
    }

    #[test]
    fn executable_sort_uses_case_insensitive_name_before_exact_spelling() {
        let mut executables = vec!["B.exe".to_string(), "a.exe".to_string()];

        sort_executables(&mut executables, "Missing");

        assert_eq!(executables, ["a.exe", "B.exe"]);
    }

    #[test]
    fn import_index_matches_game_directory_and_descendants() {
        let game_dir = test_path(&["scan-root", "Games", "A"]);
        let sibling = test_path(&["scan-root", "Games", "AB"]);
        let mut index = ImportPathIndex::default();
        index.insert(&game_dir);
        index.insert(&game_dir);

        assert_eq!(index.len(), 1);
        assert!(index.is_imported_or_descendant(&game_dir));
        assert!(index.is_imported_or_descendant(&game_dir.join("Sub")));
        assert!(!index.is_imported_or_descendant(game_dir.parent().unwrap()));
        assert!(!index.is_imported_or_descendant(&sibling));
    }

    #[test]
    fn steam_root_matches_exact_and_nested_imported_paths() {
        let exact_root = test_path(&["scan-root", "Steam", "Exact"]);
        let nested_root = test_path(&["scan-root", "Steam", "Nested"]);
        let sibling_root = test_path(&["scan-root", "Steam", "Game"]);
        let mut index = ImportPathIndex::default();
        index.insert(&exact_root);
        index.insert(&nested_root.join("Build").join("Game"));
        index.insert(&test_path(&["scan-root", "Steam", "GameABC"]));

        assert!(index.has_imported_path_within(&exact_root));
        assert!(index.has_imported_path_within(&nested_root));
        assert!(!index.has_imported_path_within(&sibling_root));
        assert!(!index.has_imported_path_within(&exact_root.join("Child")));
    }

    #[test]
    fn executable_scan_does_not_find_games_below_imported_scan_root() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let game_dir = std::env::temp_dir().join(format!(
            "skerry-imported-scan-root-{}-{unique}",
            std::process::id()
        ));
        let deep_dir = game_dir.join("Sub").join("Deep");
        fs::create_dir_all(&deep_dir).expect("应能创建深层测试目录");
        fs::write(deep_dir.join("nested.exe"), []).expect("应能创建深层启动程序");

        let mut existing_paths = ImportPathIndex::default();
        existing_paths.insert(&game_dir);
        let results = scan_executable_games_blocking(
            game_dir.to_string_lossy().into_owned(),
            existing_paths,
            5,
        )
        .expect("扫描应成功");

        assert!(results.is_empty());
        fs::remove_dir_all(game_dir).expect("应能清理测试目录");
    }

    #[test]
    fn executable_scan_selects_parent_before_nested_game_candidates() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "skerry-parent-first-scan-{}-{unique}",
            std::process::id()
        ));
        let parent_game = root.join("Parent Game");
        let nested_game = parent_game.join("Nested Game");
        let sibling_game = root.join("Sibling Game");
        fs::create_dir_all(&nested_game).expect("应能创建嵌套游戏目录");
        fs::create_dir_all(&sibling_game).expect("应能创建同级游戏目录");
        fs::write(parent_game.join("parent.exe"), []).expect("应能创建父目录启动程序");
        fs::write(nested_game.join("nested.exe"), []).expect("应能创建子目录启动程序");
        fs::write(sibling_game.join("sibling.exe"), []).expect("应能创建同级启动程序");

        let results = scan_executable_games_blocking(
            root.to_string_lossy().into_owned(),
            ImportPathIndex::default(),
            5,
        )
        .expect("扫描应成功");

        assert_eq!(results.len(), 2);
        assert!(
            results
                .iter()
                .any(|result| result.path == parent_game.to_string_lossy())
        );
        assert!(
            results
                .iter()
                .any(|result| result.path == sibling_game.to_string_lossy())
        );
        assert!(
            !results
                .iter()
                .any(|result| result.path == nested_game.to_string_lossy())
        );

        fs::remove_dir_all(root).expect("应能清理测试目录");
    }

    #[test]
    fn executable_scan_respects_max_depth_as_walkdir_entry_depth() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "skerry-depth-boundary-scan-{}-{unique}",
            std::process::id()
        ));
        let nested_game = root.join("Level One").join("Level Two");
        fs::create_dir_all(&nested_game).expect("应能创建深层游戏目录");
        fs::write(nested_game.join("game.exe"), []).expect("应能创建深层启动程序");

        let at_depth_two = scan_executable_games_blocking(
            root.to_string_lossy().into_owned(),
            ImportPathIndex::default(),
            2,
        )
        .expect("深度 2 扫描应成功");
        assert!(at_depth_two.is_empty());

        let at_depth_three = scan_executable_games_blocking(
            root.to_string_lossy().into_owned(),
            ImportPathIndex::default(),
            3,
        )
        .expect("深度 3 扫描应成功");
        assert_eq!(at_depth_three.len(), 1);
        assert_eq!(PathBuf::from(&at_depth_three[0].path), nested_game);

        fs::remove_dir_all(root).expect("应能清理测试目录");
    }

    #[test]
    fn executable_scan_orders_equal_names_by_path() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "skerry-equal-name-scan-{}-{unique}",
            std::process::id()
        ));
        let first_game = root.join("a").join("Game (first)");
        let second_game = root.join("z").join("Game [second]");
        fs::create_dir_all(&first_game).expect("应能创建首个游戏目录");
        fs::create_dir_all(&second_game).expect("应能创建第二个游戏目录");
        fs::write(first_game.join("first.exe"), []).expect("应能创建首个启动程序");
        fs::write(second_game.join("second.exe"), []).expect("应能创建第二个启动程序");

        let results = scan_executable_games_blocking(
            root.to_string_lossy().into_owned(),
            ImportPathIndex::default(),
            5,
        )
        .expect("扫描应成功");

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|result| result.name == "Game"));
        assert_eq!(results[0].path, first_game.to_string_lossy());
        assert_eq!(results[1].path, second_game.to_string_lossy());

        fs::remove_dir_all(root).expect("应能清理测试目录");
    }

    #[test]
    fn first_level_scan_imports_direct_children_and_executables() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "skerry-first-level-scan-{}-{unique}",
            std::process::id()
        ));
        let game_a = root.join("GameA");
        let game_b = root.join("GameB");
        let game_c = root.join("GameC");
        fs::create_dir_all(game_a.join("Deep")).expect("应能创建测试目录");
        fs::create_dir_all(&game_b).expect("应能创建测试目录");
        fs::create_dir_all(&game_c).expect("应能创建无启动程序的测试目录");
        fs::write(game_a.join("GameA.exe"), []).expect("应能创建直属启动程序");
        fs::write(game_a.join("Deep").join("ignored.exe"), []).expect("应能创建深层启动程序");

        let mut existing_paths = ImportPathIndex::default();
        existing_paths.insert(&game_b);
        let results =
            scan_direct_child_directories(root.to_string_lossy().into_owned(), existing_paths);

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].name, "GameA");
        assert_eq!(PathBuf::from(&results[0].path), game_a);
        assert_eq!(results[0].executables, ["GameA.exe"]);
        assert_eq!(results[1].name, "GameC");
        assert_eq!(PathBuf::from(&results[1].path), game_c);
        assert!(results[1].executables.is_empty());

        fs::remove_dir_all(root).expect("应能清理测试目录");
    }

    #[test]
    fn first_level_scan_filters_direct_files_and_sorts_equal_names_by_path() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "skerry-first-level-rules-{}-{unique}",
            std::process::id()
        ));
        let later_title = root.join("Title [Zulu]");
        let earlier_title = root.join("Title (Alpha)");
        let excluded_directory = root.join("node_modules");
        let similar_directory_name = root.join("Windows.old");
        fs::create_dir_all(&later_title).expect("应能创建带方括号的标题目录");
        fs::create_dir_all(&earlier_title).expect("应能创建带圆括号的标题目录");
        fs::create_dir_all(&excluded_directory).expect("应能创建需排除的目录");
        fs::create_dir_all(&similar_directory_name).expect("应能创建名称相似的保留目录");
        fs::write(later_title.join("runner.cmd"), []).expect("应能创建受支持启动程序");
        fs::write(later_title.join("unins000.exe"), []).expect("应能创建卸载程序");
        fs::write(later_title.join("readme.txt"), []).expect("应能创建非启动文件");
        fs::create_dir_all(later_title.join("Nested")).expect("应能创建深层目录");
        fs::write(later_title.join("Nested").join("nested.exe"), []).expect("应能创建深层启动程序");
        fs::write(earlier_title.join("setup.exe"), []).expect("应能创建安装程序");

        let results = scan_direct_child_directories(
            root.to_string_lossy().into_owned(),
            ImportPathIndex::default(),
        );

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].name, "Title");
        assert_eq!(PathBuf::from(&results[0].path), earlier_title);
        assert!(results[0].executables.is_empty());
        assert_eq!(results[1].name, "Title");
        assert_eq!(PathBuf::from(&results[1].path), later_title);
        assert_eq!(results[1].executables, ["runner.cmd"]);
        assert_eq!(results[2].name, "Windows.old");
        assert!(results[2].executables.is_empty());

        fs::remove_dir_all(root).expect("应能清理测试目录");
    }
}
