mod import_rules;
use import_rules::{SteamCandidateRules, SteamImportFilter};

use crate::database::repository::game_import_repository::GameImportRepository;
use crate::game::import_path_index::ImportPathIndex;
use sea_orm::DatabaseConnection;
use serde::Serialize;
use std::fs;
use std::path::Path;
use steamlocate::{Library, SteamDir};
use tauri::{State, command};

const STEAMWORKS_COMMON_REDISTRIBUTABLES: u32 = 228_980;

mod shortcuts;
use shortcuts::{decode_shortcut_text, parse_shortcuts_vdf, parse_url_launch_id};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SteamLaunchTarget {
    pub steam_launch_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub localpath: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SteamLaunchTargetScanResult {
    pub targets: Vec<SteamLaunchTarget>,
    pub warnings: Vec<String>,
}

fn normalized_path_key(path: &Path) -> String {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let key = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        key.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        key
    }
}

fn locate_steam_dirs() -> Result<Vec<SteamDir>, String> {
    let directories = steamlocate::locate_all()
        .map_err(|error| format!("未找到 Steam 安装目录: {error}"))?
        .into_iter()
        .filter(|directory| {
            let root = directory.path();
            root.join("steamapps").is_dir() || root.join("userdata").is_dir()
        })
        .collect::<Vec<_>>();
    if directories.is_empty() {
        Err("未找到 Steam 安装目录".to_string())
    } else {
        Ok(directories)
    }
}

fn steam_libraries(steam_dir: &SteamDir, warnings: &mut Vec<String>) -> Vec<Library> {
    let mut libraries = Vec::<(String, Library)>::new();
    match steam_dir.libraries() {
        Ok(found) => {
            for library in found.flatten() {
                let key = normalized_path_key(library.path());
                libraries.push((key, library));
            }
        }
        Err(error) => warnings.push(format!(
            "解析 {} 失败: {error}",
            steam_dir
                .path()
                .join("steamapps")
                .join("libraryfolders.vdf")
                .display()
        )),
    }

    let root_key = normalized_path_key(steam_dir.path());
    if !libraries.iter().any(|(key, _)| key == &root_key)
        && let Ok(root_library) = Library::from_dir(steam_dir.path())
    {
        libraries.push((root_key, root_library));
    }
    libraries.sort_by(|left, right| left.0.cmp(&right.0));
    libraries.dedup_by(|left, right| left.0 == right.0);
    libraries.into_iter().map(|(_, library)| library).collect()
}

fn app_target(app: &steamlocate::App, library: &Library) -> Result<SteamLaunchTarget, String> {
    if app.app_id == 0 {
        return Err("应用清单 appid 必须大于 0".to_string());
    }
    let name = app
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "应用清单缺少游戏名称".to_string())?;
    if app.install_dir.trim().is_empty() {
        return Err("应用清单缺少 installdir".to_string());
    }
    Ok(SteamLaunchTarget {
        steam_launch_id: app.app_id.to_string(),
        name: name.to_owned(),
        localpath: Some(library.resolve_app_dir(app).to_string_lossy().into_owned()),
        executable: None,
    })
}

fn has_monitor_directory(
    candidate: &SteamLaunchTarget,
    source: &Path,
    warnings: &mut Vec<String>,
) -> bool {
    let Some(directory) = candidate
        .localpath
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        warnings.push(format!(
            "{} 的启动项 {} 缺少可监控目录，已跳过",
            source.display(),
            candidate.steam_launch_id
        ));
        return false;
    };
    if !Path::new(directory).is_dir() {
        warnings.push(format!(
            "{} 的启动项 {} 对应目录不存在，已跳过: {}",
            source.display(),
            candidate.steam_launch_id,
            directory
        ));
        return false;
    }
    true
}

fn inspect_steam_directory(
    steam_dir: &SteamDir,
    existing_games: &SteamImportFilter,
    candidates: &mut SteamCandidateRules,
    warnings: &mut Vec<String>,
) {
    for library in steam_libraries(steam_dir, warnings) {
        for app in library.apps() {
            let app = match app {
                Ok(app) => app,
                Err(error) => {
                    warnings.push(format!(
                        "解析 {} 中的 Steam 应用清单失败: {error}",
                        library.path().join("steamapps").display()
                    ));
                    continue;
                }
            };
            if app.app_id == STEAMWORKS_COMMON_REDISTRIBUTABLES {
                continue;
            }
            let manifest = library
                .path()
                .join("steamapps")
                .join(format!("appmanifest_{}.acf", app.app_id));
            match app_target(&app, &library) {
                Err(error) => warnings.push(format!(
                    "解析 Steam 应用清单 {} 失败: {error}",
                    manifest.display()
                )),
                Ok(candidate) => {
                    if !has_monitor_directory(&candidate, &manifest, warnings)
                        || existing_games.exclusion_reason(&candidate).is_some()
                    {
                        continue;
                    }
                    candidates.consider(candidate, manifest.display().to_string(), warnings);
                }
            }
        }
    }

    let userdata = steam_dir.path().join("userdata");
    let entries = match fs::read_dir(&userdata) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            warnings.push(format!("读取 {} 失败: {error}", userdata.display()));
            return;
        }
    };
    let mut shortcut_files = entries
        .flatten()
        .map(|entry| entry.path().join("config").join("shortcuts.vdf"))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    shortcut_files.sort_by_key(|path| normalized_path_key(path));

    for shortcut_file in shortcut_files {
        match parse_shortcuts_vdf(&shortcut_file) {
            Err(error) => warnings.push(error),
            Ok((targets, file_warnings)) => {
                warnings.extend(file_warnings);
                for target in targets {
                    if !has_monitor_directory(&target, &shortcut_file, warnings)
                        || existing_games.exclusion_reason(&target).is_some()
                    {
                        continue;
                    }
                    candidates.consider(target, shortcut_file.display().to_string(), warnings);
                }
            }
        }
    }
}

fn scan_steam_dirs(
    steam_dirs: &[SteamDir],
    existing_games: &SteamImportFilter,
) -> SteamLaunchTargetScanResult {
    let mut warnings = Vec::new();
    let mut candidates = SteamCandidateRules::default();
    for directory in steam_dirs {
        inspect_steam_directory(directory, existing_games, &mut candidates, &mut warnings);
    }
    SteamLaunchTargetScanResult {
        targets: candidates.finish(),
        warnings,
    }
}

#[command]
pub async fn scan_steam_launch_targets(
    db: State<'_, DatabaseConnection>,
    exclude_existing: bool,
) -> Result<SteamLaunchTargetScanResult, String> {
    let existing = if exclude_existing {
        let paths = GameImportRepository::get_all_game_directories(&db)
            .await
            .map_err(|error| format!("查询已有路径失败: {error}"))?;
        let steam_ids = GameImportRepository::get_all_steam_launch_ids(&*db)
            .await
            .map_err(|error| format!("查询已有 Steam 启动 ID 失败: {error}"))?;
        SteamImportFilter::from_database(ImportPathIndex::from_paths(paths), steam_ids)
    } else {
        SteamImportFilter::default()
    };
    tokio::task::spawn_blocking(move || {
        locate_steam_dirs().map(|directories| scan_steam_dirs(&directories, &existing))
    })
    .await
    .map_err(|error| format!("Steam 扫描任务异常: {error}"))?
}

fn resolve_steam_shortcut_file_blocking(path: &Path) -> Result<SteamLaunchTarget, String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("url"))
    {
        return Err("仅支持 .url Steam 快捷方式".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    let launch_id = parse_url_launch_id(&decode_shortcut_text(&bytes)?)?;
    let directories = locate_steam_dirs()?;
    scan_steam_dirs(&directories, &SteamImportFilter::default())
        .targets
        .into_iter()
        .find(|target| target.steam_launch_id == launch_id)
        .ok_or_else(|| format!("本机 Steam 库中未找到启动项 {launch_id}"))
}

#[command]
pub async fn resolve_steam_shortcut_file(path: String) -> Result<SteamLaunchTarget, String> {
    tokio::task::spawn_blocking(move || resolve_steam_shortcut_file_blocking(Path::new(&path)))
        .await
        .map_err(|error| format!("Steam 快捷方式解析任务异常: {error}"))?
}
#[cfg(test)]
mod tests {
    use super::shortcuts::{
        lexical_file_name, lexical_parent, parse_shortcuts_vdf_contents, shortcut_launch_id,
        strip_outer_quotes,
    };
    use super::*;

    fn push_cstring(bytes: &mut Vec<u8>, value: &str) {
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(0);
    }

    fn push_object(bytes: &mut Vec<u8>, key: &str) {
        bytes.push(0);
        push_cstring(bytes, key);
    }

    fn push_string(bytes: &mut Vec<u8>, key: &str, value: &str) {
        bytes.push(1);
        push_cstring(bytes, key);
        push_cstring(bytes, value);
    }

    fn push_u32(bytes: &mut Vec<u8>, key: &str, value: u32) {
        bytes.push(2);
        push_cstring(bytes, key);
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    fn push_wstring(bytes: &mut Vec<u8>, key: &str, value: &str) {
        bytes.push(5);
        push_cstring(bytes, key);
        bytes.extend_from_slice(&[0xFF, 0xFE]);
        bytes.extend(value.encode_utf16().flat_map(u16::to_le_bytes));
        bytes.extend_from_slice(&[0, 0]);
    }

    fn shortcut_fixture(app_id: u32, name: &str, exe: &str, start_dir: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        push_object(&mut bytes, "shortcuts");
        push_object(&mut bytes, "0");
        push_wstring(&mut bytes, "WideIgnored", "测试");
        push_u32(&mut bytes, "appid", app_id);
        push_string(&mut bytes, "AppName", name);
        push_string(&mut bytes, "Exe", exe);
        push_string(&mut bytes, "StartDir", start_dir);
        push_object(&mut bytes, "tags");
        push_string(&mut bytes, "0", "视觉小说");
        bytes.extend_from_slice(&[8, 8, 8, 8]);
        bytes
    }

    #[test]
    fn skips_missing_and_duplicate_library_entries_during_scan() {
        let root = std::env::temp_dir().join(format!(
            "skerry-steam-library-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let valid_library = root.join("valid-library");
        let stale_library = root.join("missing-library");
        let valid_library_alias = valid_library.join("..").join("valid-library");
        fs::create_dir_all(root.join("steamapps")).unwrap();
        fs::create_dir_all(valid_library.join("steamapps")).unwrap();
        fs::create_dir_all(
            valid_library
                .join("steamapps")
                .join("common")
                .join("Test Game"),
        )
        .unwrap();
        fs::create_dir_all(
            valid_library
                .join("steamapps")
                .join("common")
                .join("Steamworks Shared"),
        )
        .unwrap();

        let vdf_path = root.join("steamapps").join("libraryfolders.vdf");
        let valid_path = valid_library.to_string_lossy().replace('\\', "/");
        let valid_alias_path = valid_library_alias.to_string_lossy().replace('\\', "/");
        let stale_path = stale_library.to_string_lossy().replace('\\', "/");
        fs::write(
            vdf_path,
            format!(
                r#""libraryfolders"
                {{
                    "0" {{ "path" "{}" }}
                    "1" {{ "path" "{}" }}
                    "2" {{ "path" "{}" }}
                    "3" {{ "path" "{}" }}
                }}"#,
                root.to_string_lossy().replace('\\', "/"),
                valid_path,
                valid_alias_path,
                stale_path,
            ),
        )
        .unwrap();
        fs::write(
            valid_library.join("steamapps").join("appmanifest_730.acf"),
            r#""AppState"
            {
                "appid" "730"
                "name" "Test Game"
                "installdir" "Test Game"
            }"#,
        )
        .unwrap();
        fs::write(
            valid_library
                .join("steamapps")
                .join("appmanifest_228980.acf"),
            r#""AppState"
            {
                "appid" "228980"
                "name" "Steamworks Common Redistributables"
                "installdir" "Steamworks Shared"
            }"#,
        )
        .unwrap();

        let steam_dir = SteamDir::from_dir(&root).unwrap();
        let mut library_warnings = Vec::new();
        let libraries = steam_libraries(&steam_dir, &mut library_warnings);
        let library_path_keys = libraries
            .iter()
            .map(|library| normalized_path_key(library.path()))
            .collect::<Vec<_>>();
        let mut sorted_library_path_keys = library_path_keys.clone();
        sorted_library_path_keys.sort();
        sorted_library_path_keys.dedup();
        assert_eq!(library_path_keys, sorted_library_path_keys);
        assert_eq!(libraries.len(), 2);
        let valid_library_entry = libraries
            .iter()
            .find(|library| {
                normalized_path_key(library.path()) == normalized_path_key(&valid_library)
            })
            .expect("valid library should be retained");
        assert_eq!(valid_library_entry.path(), valid_library.as_path());
        assert!(library_warnings.is_empty());

        let result = scan_steam_dirs(&[steam_dir], &SteamImportFilter::default());
        assert_eq!(result.targets.len(), 1);
        assert_eq!(result.targets[0].steam_launch_id, "730");
        assert_eq!(result.targets[0].name, "Test Game");
        assert!(
            !result
                .warnings
                .iter()
                .any(|warning| warning.contains(&stale_path))
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn import_filter_matches_existing_steam_id_and_path() {
        let steam_root = std::env::temp_dir().join("skerry-existing-steam-game");
        let existing_path = steam_root.join("Build").join("Game");
        let filter = SteamImportFilter::from_database(
            ImportPathIndex::from_paths([existing_path.to_string_lossy().into_owned()]),
            ["730".to_string()],
        );
        let same_id = SteamLaunchTarget {
            steam_launch_id: "730".to_string(),
            name: "Same ID".to_string(),
            localpath: Some("different-path".to_string()),
            executable: Some("game.exe".to_string()),
        };
        let same_path = SteamLaunchTarget {
            steam_launch_id: "440".to_string(),
            name: "Same Path".to_string(),
            localpath: Some(steam_root.to_string_lossy().into_owned()),
            executable: None,
        };
        let new_game = SteamLaunchTarget {
            steam_launch_id: "570".to_string(),
            name: "New Game".to_string(),
            localpath: Some("new-path".to_string()),
            executable: None,
        };

        assert!(filter.exclusion_reason(&same_id).is_some());
        assert!(filter.exclusion_reason(&same_path).is_some());
        assert!(filter.exclusion_reason(&new_game).is_none());
    }

    #[test]
    fn parses_binary_shortcut_with_unsigned_app_id_and_split_path() {
        let app_id = 0xF123_4567;
        let fixture = shortcut_fixture(
            app_id,
            "测试游戏",
            r#""D:\Games\Test\game.exe""#,
            r#""D:\Games\Test""#,
        );
        let (candidates, warnings) =
            parse_shortcuts_vdf_contents(&fixture, Path::new("shortcuts.vdf")).unwrap();
        let candidate = candidates.into_iter().next().unwrap();
        assert!(warnings.is_empty());
        assert_eq!(candidate.steam_launch_id, shortcut_launch_id(app_id));
        assert_eq!(candidate.name, "测试游戏");
        assert_eq!(candidate.localpath.as_deref(), Some(r"D:\Games\Test"));
        assert_eq!(candidate.executable.as_deref(), Some("game.exe"));
    }

    #[test]
    fn rejects_truncated_or_trailing_binary_vdf() {
        let fixture = shortcut_fixture(730, "Game", r#""D:\Game\game.exe""#, r#""D:\Game""#);
        assert!(
            parse_shortcuts_vdf_contents(&fixture[..fixture.len() - 1], Path::new("shortcuts.vdf"))
                .is_err()
        );

        let mut trailing = fixture;
        trailing.push(0);
        assert!(parse_shortcuts_vdf_contents(&trailing, Path::new("shortcuts.vdf")).is_err());

        let mut unsupported_type = Vec::new();
        push_object(&mut unsupported_type, "shortcuts");
        unsupported_type.push(42);
        push_cstring(&mut unsupported_type, "unknown");
        unsupported_type.extend_from_slice(&[8, 8]);
        assert!(
            parse_shortcuts_vdf_contents(&unsupported_type, Path::new("shortcuts.vdf")).is_err()
        );
    }

    #[test]
    fn streams_only_shortcut_fields_and_keeps_numeric_entry_order() {
        let mut bytes = Vec::new();
        push_object(&mut bytes, "shortcuts");
        push_object(&mut bytes, "10");
        push_u32(&mut bytes, "appid", 10);
        push_string(&mut bytes, "appname", "Lowercase key");
        push_string(&mut bytes, "AppName", "Selected key");
        push_string(&mut bytes, "AppName", "Last exact duplicate");
        push_string(&mut bytes, "Exe", r#""D:\Ten\ten.exe""#);
        push_object(&mut bytes, "unused");
        push_string(&mut bytes, "DeeplyUnused", "ignored");
        bytes.extend_from_slice(&[8, 8]);
        push_object(&mut bytes, "2");
        push_u32(&mut bytes, "appid", 2);
        push_string(&mut bytes, "AppName", "Second Game");
        push_string(&mut bytes, "Exe", r#""D:\Two\two.exe""#);
        bytes.extend_from_slice(&[8, 8, 8]);

        let (candidates, warnings) =
            parse_shortcuts_vdf_contents(&bytes, Path::new("shortcuts.vdf")).unwrap();

        assert!(warnings.is_empty());
        assert_eq!(
            candidates
                .iter()
                .map(|game| game.name.as_str())
                .collect::<Vec<_>>(),
            ["Second Game", "Last exact duplicate"]
        );
        assert_eq!(candidates[1].executable.as_deref(), Some("ten.exe"));
    }

    #[test]
    fn preserves_shortcut_candidate_warnings_and_their_order() {
        let mut bytes = Vec::new();
        push_object(&mut bytes, "shortcuts");
        push_u32(&mut bytes, "0", 12);
        push_object(&mut bytes, "1");
        push_u32(&mut bytes, "appid", 0);
        push_string(&mut bytes, "AppName", "Invalid ID");
        bytes.push(8);
        push_object(&mut bytes, "2");
        push_u32(&mut bytes, "appid", 20);
        bytes.push(8);
        bytes.extend_from_slice(&[8, 8]);

        let (candidates, warnings) =
            parse_shortcuts_vdf_contents(&bytes, Path::new("shortcuts.vdf")).unwrap();

        assert!(candidates.is_empty());
        assert_eq!(
            warnings,
            [
                "shortcuts.vdf 的快捷方式 0 不是对象",
                "shortcuts.vdf 的快捷方式 1 缺少有效 appid",
                "shortcuts.vdf 的快捷方式 2 缺少游戏名称",
            ]
        );
    }

    #[test]
    fn derives_start_directory_from_executable_when_missing() {
        let executable = strip_outer_quotes(r#""D:\Games\Test\game.exe""#).unwrap();
        assert_eq!(
            lexical_parent(&executable).as_deref(),
            Some(r"D:\Games\Test")
        );
        assert_eq!(lexical_file_name(&executable).as_deref(), Some("game.exe"));
    }

    #[test]
    fn parses_utf8_bom_and_utf16le_shortcuts_strictly() {
        let content = "[InternetShortcut]\r\nURL=steam://rungameid/000730\r\n";
        let mut utf8 = vec![0xEF, 0xBB, 0xBF];
        utf8.extend_from_slice(content.as_bytes());
        assert_eq!(
            parse_url_launch_id(&decode_shortcut_text(&utf8).unwrap()).unwrap(),
            "730"
        );

        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend(
            content
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        assert_eq!(
            parse_url_launch_id(&decode_shortcut_text(&utf16).unwrap()).unwrap(),
            "730"
        );

        let ansi =
            b"[InternetShortcut]\r\nURL=steam://rungameid/730\r\nIconFile=\xD3\xCE\xCF\xB7.ico\r\n";
        assert_eq!(
            parse_url_launch_id(&decode_shortcut_text(ansi).unwrap()).unwrap(),
            "730"
        );

        for invalid in [
            "steam://rungameid/0",
            "steam://rungameid/730/",
            "steam://rungameid/730?x=1",
            "https://example.com/730",
            "这不是一个 Steam 快捷方式地址",
        ] {
            let text = format!("[InternetShortcut]\nURL={invalid}\n");
            assert!(parse_url_launch_id(&text).is_err(), "{invalid}");
        }
    }
}
