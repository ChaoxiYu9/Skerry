//! Windows 外部工具路径设置校验及失效配置清理。

use crate::database::dto::UpdateSettingsData;
use crate::database::repository::settings_repository::SettingsRepository;
use sea_orm::DatabaseConnection;
use std::env::{self, VarError};
use std::fmt;
use std::path::PathBuf;

// Keep the verified Windows path expansion bound as part of the input contract.
const MAX_PATH_VARIABLE_EXPANSIONS: usize = 16;

#[derive(Clone, Copy)]
pub(super) enum ToolPathKind {
    Le,
    Magpie,
}

impl ToolPathKind {
    fn label(self) -> &'static str {
        match self {
            Self::Le => "LE转区软件",
            Self::Magpie => "Magpie软件",
        }
    }

    fn clear_update(self) -> UpdateSettingsData {
        match self {
            Self::Le => UpdateSettingsData {
                le_path: Some(None),
                ..Default::default()
            },
            Self::Magpie => UpdateSettingsData {
                magpie_path: Some(None),
                ..Default::default()
            },
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum VariableLookupError {
    Undefined,
    NonUnicode,
}

#[derive(Debug, PartialEq, Eq)]
enum ToolPathResolutionError {
    Empty,
    InvalidVariableSyntax(String),
    UndefinedVariable(String),
    NonUnicodeVariable(String),
    VariableCycle(Vec<String>),
    ExpansionDepthExceeded,
}

impl fmt::Display for ToolPathResolutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(formatter, "解析结果为空"),
            Self::InvalidVariableSyntax(value) => {
                write!(formatter, "路径变量语法无效: {value}")
            }
            Self::UndefinedVariable(name) => write!(formatter, "环境变量未定义: {name}"),
            Self::NonUnicodeVariable(name) => {
                write!(formatter, "环境变量不是有效 Unicode 文本: {name}")
            }
            Self::VariableCycle(names) => {
                write!(formatter, "环境变量存在循环引用: {}", names.join(" -> "))
            }
            Self::ExpansionDepthExceeded => {
                write!(
                    formatter,
                    "环境变量递归展开超过 {MAX_PATH_VARIABLE_EXPANSIONS} 层"
                )
            }
        }
    }
}

fn resolve_configured_tool_path(path: &str) -> Result<PathBuf, ToolPathResolutionError> {
    resolve_configured_tool_path_with(path, |name| {
        env::var(name).map_err(|error| match error {
            VarError::NotPresent => VariableLookupError::Undefined,
            VarError::NotUnicode(_) => VariableLookupError::NonUnicode,
        })
    })
}

fn resolve_configured_tool_path_with<F>(
    path: &str,
    mut lookup_variable: F,
) -> Result<PathBuf, ToolPathResolutionError>
where
    F: FnMut(&str) -> Result<String, VariableLookupError>,
{
    let mut resolved = path.to_string();
    if resolved.trim().is_empty() {
        return Err(ToolPathResolutionError::Empty);
    }

    let mut expanded_variables = Vec::<String>::new();
    loop {
        let Some((name, suffix)) = windows_variable_prefix(&resolved)? else {
            break;
        };

        if expanded_variables.len() == MAX_PATH_VARIABLE_EXPANSIONS {
            return Err(ToolPathResolutionError::ExpansionDepthExceeded);
        }

        if let Some(cycle_start) = expanded_variables
            .iter()
            .position(|expanded| expanded.eq_ignore_ascii_case(&name))
        {
            let mut cycle = expanded_variables[cycle_start..].to_vec();
            cycle.push(name);
            return Err(ToolPathResolutionError::VariableCycle(cycle));
        }

        let value = lookup_variable(&name).map_err(|error| match error {
            VariableLookupError::Undefined => {
                ToolPathResolutionError::UndefinedVariable(name.clone())
            }
            VariableLookupError::NonUnicode => {
                ToolPathResolutionError::NonUnicodeVariable(name.clone())
            }
        })?;

        resolved = format!("{value}{suffix}");
        expanded_variables.push(name);
    }

    if resolved.is_empty() {
        return Err(ToolPathResolutionError::Empty);
    }

    // Relative paths remain accepted when they identify an existing file; this
    // preserves Skerry's current filesystem validation contract.
    Ok(PathBuf::from(resolved))
}

fn windows_variable_prefix(value: &str) -> Result<Option<(String, &str)>, ToolPathResolutionError> {
    if !value.starts_with('%') {
        return Ok(None);
    }

    let Some(end) = value[1..].find('%').map(|index| index + 1) else {
        return Err(ToolPathResolutionError::InvalidVariableSyntax(
            value.to_string(),
        ));
    };
    let name = &value[1..end];
    if name.is_empty() {
        return Err(ToolPathResolutionError::InvalidVariableSyntax(
            value.to_string(),
        ));
    }

    Ok(Some((name.to_string(), &value[end + 1..])))
}

async fn clear_tool_path_setting(
    db: &DatabaseConnection,
    tool_kind: ToolPathKind,
) -> Result<(), String> {
    SettingsRepository::update_settings(db, tool_kind.clear_update())
        .await
        .map_err(|e| format!("清空{}路径失败: {}", tool_kind.label(), e))
}

pub(super) async fn resolve_tool_path(
    db: &DatabaseConnection,
    path: Option<&str>,
    tool_kind: ToolPathKind,
) -> Result<String, String> {
    let Some(configured_path) = path.filter(|value| !value.trim().is_empty()) else {
        return Err(format!("{}路径未设置，请先配置路径", tool_kind.label()));
    };

    let tool_path = match resolve_configured_tool_path(configured_path) {
        Ok(path) => path,
        Err(error) => {
            clear_tool_path_setting(db, tool_kind).await?;
            return Err(format!(
                "{}路径解析失败，已清空配置，请重新设置: {} ({})",
                tool_kind.label(),
                configured_path,
                error
            ));
        }
    };

    let invalid_reason = if !tool_path.exists() {
        Some("不存在")
    } else if !tool_path.is_file() {
        Some("不是文件")
    } else {
        None
    };

    if let Some(reason) = invalid_reason {
        clear_tool_path_setting(db, tool_kind).await?;
        return Err(format!(
            "{}路径{}，已清空配置，请重新设置: {}",
            tool_kind.label(),
            reason,
            configured_path
        ));
    }

    Ok(tool_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        ToolPathKind, ToolPathResolutionError, VariableLookupError,
        resolve_configured_tool_path_with, resolve_tool_path,
    };
    use crate::entity::user::Entity as User;
    use sea_orm::{ConnectionTrait, Database, EntityTrait};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    async fn settings_database() -> sea_orm::DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("内存数据库应连接成功");
        db.execute_unprepared(
            r#"CREATE TABLE user (
                id INTEGER PRIMARY KEY,
                bgm_auth TEXT,
                hikarinagi_auth TEXT,
                kungal_auth TEXT,
                vndb_token TEXT,
                save_root_path TEXT,
                db_backup_path TEXT,
                le_path TEXT,
                magpie_path TEXT,
                detail_backdrop_path TEXT,
                default_le_launch BOOLEAN NOT NULL DEFAULT 0,
                default_magpie BOOLEAN NOT NULL DEFAULT 0
            )"#,
        )
        .await
        .expect("应创建最小设置表");
        db.execute_unprepared(
            "INSERT INTO user (id, le_path, magpie_path) VALUES (1, 'old-le', 'old-magpie')",
        )
        .await
        .expect("应创建已有工具路径设置");
        db
    }

    fn resolve_with_values(
        input: &str,
        values: &[(&str, &str)],
    ) -> Result<PathBuf, ToolPathResolutionError> {
        let values = values
            .iter()
            .map(|(name, value)| (name.to_ascii_uppercase(), value.to_string()))
            .collect::<HashMap<_, _>>();
        resolve_configured_tool_path_with(input, |name| {
            values
                .get(&name.to_ascii_uppercase())
                .cloned()
                .ok_or(VariableLookupError::Undefined)
        })
    }

    #[test]
    fn expands_leading_variables_recursively_and_keeps_relative_paths() {
        let path = resolve_with_values(
            r"%TOOL_ROOT%\Magpie.exe",
            &[("TOOL_ROOT", r"%APP_ROOT%\Tools"), ("APP_ROOT", "relative")],
        )
        .expect("合法的前缀变量链应展开");

        assert_eq!(path, PathBuf::from(r"relative\Tools\Magpie.exe"));
    }

    #[test]
    fn preserves_whitespace_around_a_literal_path() {
        let path =
            resolve_with_values(" C:\\Games\\Magpie.exe ", &[]).expect("非变量前缀保持为字面路径");

        assert_eq!(path, PathBuf::from(" C:\\Games\\Magpie.exe "));
    }

    #[test]
    fn leaves_variable_like_text_after_the_prefix_unchanged() {
        let path = resolve_with_values(r"C:\Games\%TITLE%", &[("TITLE", "Other")])
            .expect("中段变量文本不是路径前缀变量");

        assert_eq!(path, PathBuf::from(r"C:\Games\%TITLE%"));
    }

    #[test]
    fn rejects_invalid_undefined_and_case_insensitive_cyclic_variables() {
        assert!(matches!(
            resolve_with_values("%%%", &[]),
            Err(ToolPathResolutionError::InvalidVariableSyntax(_))
        ));
        assert!(matches!(
            resolve_with_values("%MISSING%\\LE.exe", &[]),
            Err(ToolPathResolutionError::UndefinedVariable(name)) if name == "MISSING"
        ));
        assert!(matches!(
            resolve_with_values("%ROOT%", &[("ROOT", "%root%")]),
            Err(ToolPathResolutionError::VariableCycle(names)) if names == ["ROOT", "root"]
        ));
    }

    #[test]
    fn permits_sixteen_expansions_and_rejects_the_seventeenth() {
        let resolve_chain = |terminal: usize| {
            resolve_configured_tool_path_with("%V0%", |name| {
                let index = name
                    .strip_prefix('V')
                    .and_then(|value| value.parse::<usize>().ok())
                    .ok_or(VariableLookupError::Undefined)?;
                if index == terminal {
                    Ok(r"C:\Resolved.exe".to_string())
                } else {
                    Ok(format!("%V{}%", index + 1))
                }
            })
        };

        assert_eq!(
            resolve_chain(15).expect("第 16 层应允许"),
            PathBuf::from(r"C:\Resolved.exe")
        );
        assert_eq!(
            resolve_chain(16),
            Err(ToolPathResolutionError::ExpansionDepthExceeded)
        );
    }

    #[tokio::test]
    async fn clears_the_configured_tool_path_when_the_resolved_file_is_missing() {
        let db = settings_database().await;

        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let missing_path =
            std::env::temp_dir().join(format!("skerry-missing-tool-{unique_suffix}.exe"));
        assert!(!missing_path.exists(), "测试路径必须不存在");
        let configured_path = missing_path
            .to_str()
            .expect("临时路径应是 Unicode")
            .to_string();

        let error = resolve_tool_path(&db, Some(&configured_path), ToolPathKind::Le)
            .await
            .expect_err("缺失工具文件应返回错误");
        assert_eq!(
            error,
            format!("LE转区软件路径不存在，已清空配置，请重新设置: {configured_path}")
        );

        let settings = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置行应保留");
        assert_eq!(settings.le_path, None);
        assert_eq!(settings.magpie_path.as_deref(), Some("old-magpie"));
    }

    #[tokio::test]
    async fn clears_configuration_after_a_path_variable_cannot_be_resolved() {
        let db = settings_database().await;

        let error = resolve_tool_path(&db, Some("%%%"), ToolPathKind::Magpie)
            .await
            .expect_err("无效变量语法应返回错误");
        assert!(error.contains("Magpie软件路径解析失败，已清空配置"));
        assert!(error.contains("路径变量语法无效: %%%"));

        let settings = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置行应保留");
        assert_eq!(settings.le_path.as_deref(), Some("old-le"));
        assert_eq!(settings.magpie_path, None);
    }

    #[tokio::test]
    async fn clears_the_configured_tool_path_when_it_names_a_directory() {
        let db = settings_database().await;
        let directory_path = std::env::temp_dir()
            .to_str()
            .expect("临时目录路径应是 Unicode")
            .to_string();

        let error = resolve_tool_path(&db, Some(&directory_path), ToolPathKind::Magpie)
            .await
            .expect_err("目录不能作为工具可执行文件");
        assert_eq!(
            error,
            format!("Magpie软件路径不是文件，已清空配置，请重新设置: {directory_path}")
        );

        let settings = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置行应保留");
        assert_eq!(settings.le_path.as_deref(), Some("old-le"));
        assert_eq!(settings.magpie_path, None);
    }
}
