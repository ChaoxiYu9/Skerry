use crate::database::dto::FullGameData;
use crate::database::repository::game_query_repository::GameQueryRepository;
use crate::database::repository::to_database_game_id;
use sea_orm::DatabaseConnection;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;
use tauri_plugin_opener::open_path;

mod save_directory;

#[derive(Debug, Clone, serde::Serialize)]
pub struct GameTextFileCandidate {
    pub path: String,
    pub name: String,
}

async fn load_game(db: &DatabaseConnection, game_id: u32) -> Result<FullGameData, String> {
    let database_game_id =
        to_database_game_id(i64::from(game_id)).ok_or_else(|| format!("游戏不存在: {game_id}"))?;
    GameQueryRepository::find_by_id(db, database_game_id)
        .await
        .map_err(|error| format!("查询游戏失败: {error}"))?
        .ok_or_else(|| format!("游戏不存在: {game_id}"))
}

fn text_priority(path: &Path) -> u8 {
    let name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if [
        "readme", "read me", "manual", "说明", "安装", "须知", "攻略",
    ]
    .iter()
    .any(|token| name.contains(token))
    {
        0
    } else {
        1
    }
}

fn find_text_file(root: &Path) -> Option<PathBuf> {
    let candidates = collect_text_files(root);
    candidates.into_iter().next()
}

fn collect_text_files(root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let Ok(canonical_root) = fs::canonicalize(root) else {
        return candidates;
    };
    let Ok(entries) = fs::read_dir(root) else {
        return candidates;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("txt"))
        {
            if fs::canonicalize(&path)
                .is_ok_and(|canonical_path| canonical_path.starts_with(&canonical_root))
            {
                candidates.push(path);
            }
        }
    }
    candidates.sort_by(compare_text_candidates);
    candidates
}

fn compare_text_candidates(left: &PathBuf, right: &PathBuf) -> Ordering {
    let left_path = left.to_string_lossy();
    let right_path = right.to_string_lossy();
    text_priority(left)
        .cmp(&text_priority(right))
        .then_with(|| left_path.len().cmp(&right_path.len()))
        .then_with(|| left_path.to_lowercase().cmp(&right_path.to_lowercase()))
        .then_with(|| left_path.cmp(&right_path))
}

fn validate_readme_file(root: &Path, file: &Path) -> Result<PathBuf, String> {
    let canonical_root = fs::canonicalize(root).map_err(|_| "说明文本路径无效".to_string())?;
    let canonical_file = fs::canonicalize(file).map_err(|_| "说明文本路径无效".to_string())?;
    if !canonical_root.is_dir()
        || !canonical_file.is_file()
        || !canonical_file.starts_with(&canonical_root)
    {
        return Err("说明文本路径无效".to_string());
    }
    if !canonical_file
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
    {
        return Err("请选择 TXT 文本文件".to_string());
    }
    Ok(canonical_file)
}

#[command]
pub async fn open_game_readme_text(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
) -> Result<String, String> {
    open_game_readme_text_for_game(db.inner(), game_id).await
}

pub async fn open_game_readme_text_for_game(
    db: &DatabaseConnection,
    game_id: u32,
) -> Result<String, String> {
    let game = load_game(db, game_id).await?;
    let root = PathBuf::from(game.localpath.ok_or_else(|| "游戏目录未设置".to_string())?);
    if !root.is_dir() {
        return Err("游戏目录不存在".to_string());
    }
    let file =
        find_text_file(&root).ok_or_else(|| "游戏目录中没有找到 TXT 说明文件".to_string())?;
    open_path(&file, None::<&str>).map_err(|error| format!("打开说明文本失败: {error}"))?;
    Ok(file.to_string_lossy().to_string())
}

#[command]
pub async fn list_game_readme_texts(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
) -> Result<Vec<GameTextFileCandidate>, String> {
    list_game_readme_texts_for_game(db.inner(), game_id).await
}

pub async fn list_game_readme_texts_for_game(
    db: &DatabaseConnection,
    game_id: u32,
) -> Result<Vec<GameTextFileCandidate>, String> {
    let game = load_game(db, game_id).await?;
    let root = PathBuf::from(game.localpath.ok_or_else(|| "游戏目录未设置".to_string())?);
    if !root.is_dir() {
        return Err("游戏目录不存在".to_string());
    }
    Ok(collect_text_files(&root)
        .into_iter()
        .map(|path| GameTextFileCandidate {
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string(),
            path: path.to_string_lossy().to_string(),
        })
        .collect())
}

#[command]
pub async fn open_game_readme_text_path(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
    path: String,
) -> Result<String, String> {
    open_game_readme_text_path_for_game(db.inner(), game_id, path).await
}

pub async fn open_game_readme_text_path_for_game(
    db: &DatabaseConnection,
    game_id: u32,
    path: String,
) -> Result<String, String> {
    let game = load_game(db, game_id).await?;
    let root = PathBuf::from(game.localpath.ok_or_else(|| "游戏目录未设置".to_string())?);
    let file = PathBuf::from(path);
    let validated_file = validate_readme_file(&root, &file)?;
    open_path(&validated_file, None::<&str>)
        .map_err(|error| format!("打开说明文本失败: {error}"))?;
    Ok(file.to_string_lossy().to_string())
}

#[command]
pub async fn detect_game_save_directory(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
) -> Result<Option<String>, String> {
    detect_game_save_directory_for_game(db.inner(), game_id).await
}

pub async fn detect_game_save_directory_for_game(
    db: &DatabaseConnection,
    game_id: u32,
) -> Result<Option<String>, String> {
    let game = load_game(db, game_id).await?;
    Ok(tokio::task::spawn_blocking(move || {
        save_directory::discover(&game).map(|path| path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("检测存档目录失败: {error}"))?)
}

#[command]
pub async fn open_game_save_directory(
    db: tauri::State<'_, DatabaseConnection>,
    game_id: u32,
) -> Result<String, String> {
    open_game_save_directory_for_game(db.inner(), game_id).await
}

pub async fn open_game_save_directory_for_game(
    db: &DatabaseConnection,
    game_id: u32,
) -> Result<String, String> {
    let game = load_game(db, game_id).await?;
    let savepath = game
        .savepath
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "请先手动指定存档目录".to_string())?;
    let directory = PathBuf::from(savepath);
    if !directory.is_dir() {
        return Err(format!(
            "存档目录不存在或不是文件夹: {}",
            directory.display()
        ));
    }
    open_path(&directory, None::<&str>).map_err(|error| format!("打开存档目录失败: {error}"))?;
    Ok(directory.to_string_lossy().to_string())
}

#[cfg(test)]
mod readme_contract_tests {
    use super::{collect_text_files, validate_readme_file};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            loop {
                let sequence = ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                let root = std::env::temp_dir().join(format!(
                    "skerry-readme-contract-{}-{sequence}",
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

    #[test]
    fn readme_list_keeps_direct_text_files_and_prefers_named_guides() {
        let root = TestRoot::new();
        fs::write(root.path().join("story.txt"), b"story").unwrap();
        fs::write(root.path().join("manual.txt"), b"manual").unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        fs::write(root.path().join("nested/readme.txt"), b"nested").unwrap();

        let files = collect_text_files(root.path());

        assert_eq!(
            files
                .iter()
                .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            ["manual.txt", "story.txt"]
        );
    }

    #[test]
    fn selected_readme_must_resolve_inside_the_game_directory_and_be_txt() {
        let root = TestRoot::new();
        let game_directory = root.path().join("game");
        fs::create_dir(&game_directory).unwrap();
        let readme = game_directory.join("readme.txt");
        let other = game_directory.join("notes.md");
        let outside = root.path().join("outside.txt");
        fs::write(&readme, b"readme").unwrap();
        fs::write(&other, b"notes").unwrap();
        fs::write(&outside, b"outside").unwrap();

        assert_eq!(
            validate_readme_file(&game_directory, &readme),
            Ok(fs::canonicalize(&readme).unwrap())
        );
        assert_eq!(
            validate_readme_file(&game_directory, &other).unwrap_err(),
            "请选择 TXT 文本文件"
        );
        assert_eq!(
            validate_readme_file(&game_directory, &outside).unwrap_err(),
            "说明文本路径无效"
        );
    }
}
