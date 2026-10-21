use super::{
    LaunchResult, StopResult, load_game, magpie, validate_and_open_steam, validate_local_launch,
};
use crate::database::repository::settings_repository::DbSettingsExt;
use crate::game::monitor::{
    GameForegroundWaitOutcome, TimeTrackingMode, is_game_foreground, monitor_game,
    stop_game_session, wait_for_game_foreground,
};
use crate::utils::command_ext::CommandGuiExt;
use sea_orm::DatabaseConnection;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Runtime, State, command};
use windows::Win32::Foundation::ERROR_ELEVATION_REQUIRED;
use {
    log::{debug, info, warn},
    tokio::time,
};

mod elevated;
mod tool_paths;
use tool_paths::{ToolPathKind, resolve_tool_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalLaunchMode {
    Direct,
    LocaleEmulator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchIntent {
    Standard,
    Administrator,
}

impl LocalLaunchMode {
    fn log_name(self) -> &'static str {
        match self {
            Self::Direct => "normal",
            Self::LocaleEmulator => "le",
        }
    }

    fn result_suffix(self) -> &'static str {
        match self {
            Self::Direct => "",
            Self::LocaleEmulator => " (LE转区)",
        }
    }
}

/// One argument plan feeds both normal spawning and the automatic UAC retry.
#[derive(Debug, PartialEq, Eq)]
struct LocalLaunchInvocation {
    program: String,
    arguments: Option<Vec<String>>,
    working_directory: PathBuf,
    mode: LocalLaunchMode,
}

impl LocalLaunchInvocation {
    fn for_game(
        game_path: &str,
        game_directory: &Path,
        use_le: bool,
        le_path: Option<String>,
        additional_arguments: Option<Vec<String>>,
    ) -> Result<Self, String> {
        let (program, arguments, mode) = if use_le {
            let le_path =
                le_path.ok_or_else(|| "LE转区软件路径未设置，请先配置路径".to_string())?;
            let mut arguments = vec![game_path.to_string()];
            if let Some(additional_arguments) = additional_arguments {
                arguments.extend(additional_arguments);
            }

            (le_path, Some(arguments), LocalLaunchMode::LocaleEmulator)
        } else {
            (
                game_path.to_string(),
                additional_arguments,
                LocalLaunchMode::Direct,
            )
        };

        Ok(Self {
            program,
            arguments,
            working_directory: game_directory.to_path_buf(),
            mode,
        })
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.current_dir(&self.working_directory);
        if let Some(arguments) = &self.arguments {
            command.args(arguments);
        }
        command
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalLaunchMethod {
    Direct,
    ElevatedFallback,
    ExplicitAdministrator,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StartedLocalProcess {
    process_id: u32,
    method: LocalLaunchMethod,
}

struct StartedGame {
    monitor_process_id: u32,
    result_process_id: Option<u32>,
    detection_dir: String,
    magpie_path: Option<String>,
    message: String,
}

impl StartedGame {
    fn from_steam(
        steam_launch_id: String,
        detection_dir: String,
        magpie_path: Option<String>,
    ) -> Self {
        Self {
            monitor_process_id: 0,
            result_process_id: None,
            detection_dir,
            magpie_path,
            message: format!("已交由 Steam 启动游戏 ({steam_launch_id})"),
        }
    }

    fn from_local(
        started: StartedLocalProcess,
        executable_name: &str,
        game_dir: &Path,
        mode: LocalLaunchMode,
        magpie_path: Option<String>,
    ) -> Self {
        let message = match started.method {
            LocalLaunchMethod::Direct => format!(
                "成功启动游戏: {}，工作目录: {:?}{}",
                executable_name,
                game_dir,
                mode.result_suffix()
            ),
            LocalLaunchMethod::ElevatedFallback => format!(
                "已使用管理员权限启动游戏: {}{}，工作目录: {:?}",
                executable_name,
                mode.result_suffix(),
                game_dir
            ),
            LocalLaunchMethod::ExplicitAdministrator => {
                format!("已使用管理员权限启动游戏: {executable_name}")
            }
        };

        Self {
            monitor_process_id: started.process_id,
            result_process_id: Some(started.process_id),
            detection_dir: game_dir.to_string_lossy().into_owned(),
            magpie_path,
            message,
        }
    }
}

#[derive(Debug)]
enum LocalLaunchStartFailure {
    Spawn(std::io::Error),
    ExplicitAdministrator(String),
    ElevatedFallback {
        spawn_error: std::io::Error,
        elevated_error: String,
    },
}

impl LocalLaunchStartFailure {
    fn error_message(self, game_directory: &Path) -> String {
        match self {
            Self::Spawn(error) => {
                format!("启动游戏失败: {}，目录: {:?}", error, game_directory)
            }
            Self::ExplicitAdministrator(error) => error,
            Self::ElevatedFallback {
                spawn_error,
                elevated_error,
            } => format!(
                "普通启动失败且提权启动失败: {} | {}",
                spawn_error, elevated_error
            ),
        }
    }
}

fn is_elevation_required(error: &std::io::Error) -> bool {
    error
        .raw_os_error()
        .and_then(|code| u32::try_from(code).ok())
        .is_some_and(|code| code == ERROR_ELEVATION_REQUIRED.0)
}

fn start_local_launch(
    intent: LaunchIntent,
    game_id: u32,
    invocation: &LocalLaunchInvocation,
    spawn_directly: impl FnOnce(&LocalLaunchInvocation) -> std::io::Result<u32>,
    spawn_elevated: impl FnOnce(&LocalLaunchInvocation) -> Result<u32, String>,
) -> Result<StartedLocalProcess, LocalLaunchStartFailure> {
    if intent == LaunchIntent::Administrator {
        return spawn_elevated(invocation)
            .map(|process_id| StartedLocalProcess {
                process_id,
                method: LocalLaunchMethod::ExplicitAdministrator,
            })
            .map_err(LocalLaunchStartFailure::ExplicitAdministrator);
    }

    match spawn_directly(invocation) {
        Ok(process_id) => Ok(StartedLocalProcess {
            process_id,
            method: LocalLaunchMethod::Direct,
        }),
        Err(spawn_error) if is_elevation_required(&spawn_error) => {
            warn!(
                "普通启动需要提权，准备回退到管理员启动 game_id={}: {}",
                game_id, spawn_error
            );
            spawn_elevated(invocation)
                .map(|process_id| StartedLocalProcess {
                    process_id,
                    method: LocalLaunchMethod::ElevatedFallback,
                })
                .map_err(|elevated_error| LocalLaunchStartFailure::ElevatedFallback {
                    spawn_error,
                    elevated_error,
                })
        }
        Err(spawn_error) => Err(LocalLaunchStartFailure::Spawn(spawn_error)),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ERROR_ELEVATION_REQUIRED, LaunchIntent, LocalLaunchInvocation, LocalLaunchMethod,
        LocalLaunchMode, LocalLaunchStartFailure, StartedGame, StartedLocalProcess,
        start_local_launch,
    };
    use std::cell::Cell;
    use std::ffi::OsStr;
    use std::io;
    use std::path::Path;

    #[test]
    fn steam_launch_receipt_keeps_the_external_process_id_out_of_the_response() {
        let receipt = StartedGame::from_steam(
            "7654321".to_string(),
            r"C:\Games\SteamTitle".to_string(),
            Some(r"C:\Tools\Magpie.exe".to_string()),
        );

        assert_eq!(receipt.monitor_process_id, 0);
        assert_eq!(receipt.result_process_id, None);
        assert_eq!(receipt.detection_dir, r"C:\Games\SteamTitle");
        assert_eq!(receipt.magpie_path.as_deref(), Some(r"C:\Tools\Magpie.exe"));
        assert_eq!(receipt.message, "已交由 Steam 启动游戏 (7654321)");
    }

    #[test]
    fn local_launch_receipt_uses_one_pid_for_monitoring_and_response() {
        let game_dir = Path::new(r"C:\Games\sample");
        let receipt = StartedGame::from_local(
            StartedLocalProcess {
                process_id: 42,
                method: LocalLaunchMethod::ElevatedFallback,
            },
            "game.exe",
            game_dir,
            LocalLaunchMode::LocaleEmulator,
            None,
        );

        assert_eq!(receipt.monitor_process_id, 42);
        assert_eq!(receipt.result_process_id, Some(42));
        assert_eq!(receipt.detection_dir, game_dir.to_string_lossy());
        assert_eq!(receipt.magpie_path, None);
        assert_eq!(
            receipt.message,
            format!(
                "已使用管理员权限启动游戏: game.exe (LE转区)，工作目录: {:?}",
                game_dir
            )
        );
    }

    #[test]
    fn explicit_administrator_receipt_keeps_its_original_message_and_pid() {
        let game_dir = Path::new(r"C:\Games\sample");
        let receipt = StartedGame::from_local(
            StartedLocalProcess {
                process_id: 84,
                method: LocalLaunchMethod::ExplicitAdministrator,
            },
            "game.exe",
            game_dir,
            LocalLaunchMode::Direct,
            None,
        );

        assert_eq!(receipt.monitor_process_id, 84);
        assert_eq!(receipt.result_process_id, Some(84));
        assert_eq!(receipt.detection_dir, game_dir.to_string_lossy());
        assert_eq!(receipt.message, "已使用管理员权限启动游戏: game.exe");
    }

    #[test]
    fn direct_launch_preserves_absent_arguments() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            false,
            None,
            None,
        )
        .expect("direct launch plan should be valid");

        assert_eq!(invocation.program, r"C:\Games\sample\game.exe");
        assert_eq!(invocation.arguments, None);
        assert_eq!(invocation.working_directory, Path::new(r"C:\Games\sample"));
        assert_eq!(invocation.mode, LocalLaunchMode::Direct);
    }

    #[test]
    fn direct_launch_preserves_an_explicit_empty_argument_list() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            false,
            None,
            Some(Vec::new()),
        )
        .expect("direct launch plan should be valid");

        assert_eq!(invocation.arguments, Some(Vec::new()));
    }

    #[test]
    fn locale_emulator_receives_the_game_path_before_user_arguments() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            true,
            Some(r"C:\Tools\LEProc.exe".to_string()),
            Some(vec!["--windowed".to_string(), "two words".to_string()]),
        )
        .expect("locale emulator launch plan should be valid");

        assert_eq!(invocation.program, r"C:\Tools\LEProc.exe");
        assert_eq!(
            invocation.arguments,
            Some(vec![
                r"C:\Games\sample\game.exe".to_string(),
                "--windowed".to_string(),
                "two words".to_string(),
            ])
        );
        assert_eq!(invocation.mode, LocalLaunchMode::LocaleEmulator);
    }

    #[test]
    fn locale_emulator_plan_keeps_game_path_when_user_arguments_are_absent() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            true,
            Some(r"C:\Tools\LEProc.exe".to_string()),
            None,
        )
        .expect("locale emulator launch plan should be valid");

        assert_eq!(
            invocation.arguments,
            Some(vec![r"C:\Games\sample\game.exe".to_string()])
        );
    }

    #[test]
    fn command_uses_the_plan_program_arguments_and_working_directory() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            true,
            Some(r"C:\Tools\LEProc.exe".to_string()),
            Some(vec!["--windowed".to_string()]),
        )
        .expect("locale emulator launch plan should be valid");

        let command = invocation.command();
        let arguments = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(command.get_program(), OsStr::new(r"C:\Tools\LEProc.exe"));
        assert_eq!(
            command.get_current_dir(),
            Some(Path::new(r"C:\Games\sample"))
        );
        assert_eq!(
            arguments,
            vec![
                r"C:\Games\sample\game.exe".to_string(),
                "--windowed".to_string()
            ]
        );
    }

    #[test]
    fn locale_emulator_launch_requires_a_configured_program() {
        let error = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            true,
            None,
            None,
        )
        .expect_err("locale emulator launch must require its configured program");

        assert_eq!(error, "LE转区软件路径未设置，请先配置路径");
    }

    #[test]
    fn direct_start_returns_its_process_without_attempting_elevation() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            false,
            None,
            None,
        )
        .expect("direct launch plan should be valid");
        let elevated_called = Cell::new(false);

        let started = start_local_launch(
            LaunchIntent::Standard,
            7,
            &invocation,
            |_| Ok(42),
            |_| {
                elevated_called.set(true);
                Err("unexpected elevation".to_string())
            },
        )
        .expect("direct start should succeed");

        assert_eq!(started.process_id, 42);
        assert_eq!(started.method, LocalLaunchMethod::Direct);
        assert!(!elevated_called.get());
    }

    #[test]
    fn explicit_administrator_start_skips_direct_spawn_and_preserves_launch_error() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            false,
            None,
            None,
        )
        .expect("direct launch plan should be valid");
        let direct_called = Cell::new(false);
        let elevated_called = Cell::new(false);

        let started = start_local_launch(
            LaunchIntent::Administrator,
            7,
            &invocation,
            |_| {
                direct_called.set(true);
                Err(io::Error::other("direct spawn must not run"))
            },
            |plan| {
                elevated_called.set(true);
                assert_eq!(plan, &invocation);
                Ok(84)
            },
        )
        .expect("explicit administrator intent should use its elevated execution");

        assert_eq!(started.process_id, 84);
        assert_eq!(started.method, LocalLaunchMethod::ExplicitAdministrator);
        assert!(!direct_called.get());
        assert!(elevated_called.get());

        let failure = start_local_launch(
            LaunchIntent::Administrator,
            7,
            &invocation,
            |_| panic!("direct spawn must not run for explicit administrator intent"),
            |_| Err("user cancelled elevation".to_string()),
        )
        .expect_err("explicit elevation failure should be returned directly");

        assert_eq!(
            failure.error_message(Path::new(r"C:\Games\sample")),
            "user cancelled elevation"
        );
    }

    #[test]
    fn elevation_required_retries_the_same_launch_invocation_once() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            true,
            Some(r"C:\Tools\LEProc.exe".to_string()),
            Some(vec!["--windowed".to_string()]),
        )
        .expect("locale-emulator launch plan should be valid");
        let direct_attempts = Cell::new(0);
        let elevated_attempts = Cell::new(0);

        let started = start_local_launch(
            LaunchIntent::Standard,
            7,
            &invocation,
            |attempt| {
                direct_attempts.set(direct_attempts.get() + 1);
                assert_eq!(attempt, &invocation);
                Err(io::Error::from_raw_os_error(
                    i32::try_from(ERROR_ELEVATION_REQUIRED.0)
                        .expect("Win32 elevation error code should fit an OS error"),
                ))
            },
            |attempt| {
                elevated_attempts.set(elevated_attempts.get() + 1);
                assert_eq!(attempt, &invocation);
                Ok(84)
            },
        )
        .expect("the elevation-required error should retry the exact launch plan");

        assert_eq!(started.process_id, 84);
        assert_eq!(started.method, LocalLaunchMethod::ElevatedFallback);
        assert_eq!(direct_attempts.get(), 1);
        assert_eq!(elevated_attempts.get(), 1);
    }

    #[test]
    fn other_spawn_errors_do_not_trigger_elevation() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            false,
            None,
            None,
        )
        .expect("direct launch plan should be valid");
        let elevated_called = Cell::new(false);

        let failure = start_local_launch(
            LaunchIntent::Standard,
            7,
            &invocation,
            |_| Err(io::Error::other("missing executable")),
            |_| {
                elevated_called.set(true);
                Err("unexpected elevation".to_string())
            },
        )
        .expect_err("non-740 failures should remain ordinary spawn failures");

        assert!(matches!(failure, LocalLaunchStartFailure::Spawn(_)));
        assert!(!elevated_called.get());
    }

    #[test]
    fn elevation_failure_keeps_both_attempt_errors() {
        let invocation = LocalLaunchInvocation::for_game(
            r"C:\Games\sample\game.exe",
            Path::new(r"C:\Games\sample"),
            false,
            None,
            None,
        )
        .expect("direct launch plan should be valid");

        let failure = start_local_launch(
            LaunchIntent::Standard,
            7,
            &invocation,
            |_| {
                Err(io::Error::from_raw_os_error(
                    i32::try_from(ERROR_ELEVATION_REQUIRED.0)
                        .expect("Win32 elevation error code should fit an OS error"),
                ))
            },
            |_| Err("user cancelled elevation".to_string()),
        )
        .expect_err("failed elevated start should retain both errors");

        match failure {
            LocalLaunchStartFailure::ElevatedFallback {
                spawn_error,
                elevated_error,
            } => {
                assert_eq!(
                    spawn_error.raw_os_error(),
                    Some(
                        i32::try_from(ERROR_ELEVATION_REQUIRED.0)
                            .expect("Win32 elevation error code should fit an OS error")
                    )
                );
                assert_eq!(elevated_error, "user cancelled elevation");
            }
            LocalLaunchStartFailure::Spawn(_) => {
                panic!("740 with a failed elevated attempt has both error sources")
            }
            LocalLaunchStartFailure::ExplicitAdministrator(_) => {
                panic!("standard launch must report the elevation fallback variant")
            }
        }
    }

    #[test]
    fn ordinary_spawn_failure_keeps_its_existing_message_and_game_directory() {
        let game_directory = Path::new(r"C:\Games\sample");
        let failure = LocalLaunchStartFailure::Spawn(io::Error::other("missing executable"));

        assert_eq!(
            failure.error_message(game_directory),
            format!(
                "启动游戏失败: missing executable，目录: {:?}",
                game_directory
            )
        );
    }

    #[test]
    fn failed_elevation_keeps_the_combined_attempt_message() {
        let game_directory = Path::new(r"C:\Games\sample");
        let spawn_error = io::Error::from_raw_os_error(
            i32::try_from(ERROR_ELEVATION_REQUIRED.0)
                .expect("Win32 elevation error code should fit an OS error"),
        );
        let expected = format!(
            "普通启动失败且提权启动失败: {} | user cancelled elevation",
            spawn_error
        );
        let failure = LocalLaunchStartFailure::ElevatedFallback {
            spawn_error,
            elevated_error: "user cancelled elevation".to_string(),
        };

        assert_eq!(failure.error_message(game_directory), expected);
    }
}

/// 启动游戏
///
/// # Arguments
///
/// * `app_handle` - Tauri应用句柄
/// * `game_id` - 游戏ID (数据库记录ID)
/// * `args` - 可选的游戏启动参数
///
/// # Returns
///
/// 启动结果，区分已监控、已委托和失败三种状态
#[command]
pub async fn launch_game<R: Runtime>(
    app_handle: AppHandle<R>,
    db: State<'_, DatabaseConnection>,
    game_id: u32,
    args: Option<Vec<String>>,
    time_tracking_mode: TimeTrackingMode,
) -> Result<LaunchResult, String> {
    Ok(
        match execute_launch_request(
            app_handle,
            db,
            game_id,
            args,
            time_tracking_mode,
            LaunchIntent::Standard,
        )
        .await
        {
            Ok(result) => result,
            Err(message) => LaunchResult::failed(message),
        },
    )
}

#[command]
pub async fn launch_game_as_admin<R: Runtime>(
    app_handle: AppHandle<R>,
    db: State<'_, DatabaseConnection>,
    game_id: u32,
    args: Option<Vec<String>>,
    time_tracking_mode: TimeTrackingMode,
) -> Result<LaunchResult, String> {
    Ok(
        match execute_launch_request(
            app_handle,
            db,
            game_id,
            args,
            time_tracking_mode,
            LaunchIntent::Administrator,
        )
        .await
        {
            Ok(result) => result,
            Err(message) => LaunchResult::failed(message),
        },
    )
}

async fn execute_launch_request<R: Runtime>(
    app_handle: AppHandle<R>,
    db: State<'_, DatabaseConnection>,
    game_id: u32,
    args: Option<Vec<String>>,
    time_tracking_mode: TimeTrackingMode,
    intent: LaunchIntent,
) -> Result<LaunchResult, String> {
    let game = load_game(db.inner(), game_id).await?;
    let started = if game.launch_type == "steam" {
        launch_steam_target(
            &app_handle,
            db.inner(),
            game_id,
            &game,
            args.as_deref(),
            intent,
        )
        .await?
    } else {
        launch_local_target(db.inner(), game_id, &game, args, intent).await?
    };

    track_started_game(
        app_handle,
        db.inner().clone(),
        time_tracking_mode,
        game_id,
        started.monitor_process_id,
        started.detection_dir,
        started.magpie_path,
    )
    .await;

    Ok(LaunchResult::tracking(
        started.message,
        started.result_process_id,
    ))
}

async fn launch_steam_target<R: Runtime>(
    app_handle: &AppHandle<R>,
    db: &DatabaseConnection,
    game_id: u32,
    game: &crate::database::dto::FullGameData,
    args: Option<&[String]>,
    intent: LaunchIntent,
) -> Result<StartedGame, String> {
    if intent == LaunchIntent::Administrator {
        return Err("Steam 启动项不支持以管理员身份运行".to_string());
    }

    let steam = validate_and_open_steam(
        app_handle,
        game_id,
        game.steam_launch_id.as_deref(),
        game.localpath.as_deref(),
        args,
    )?;
    let magpie_path = if game.magpie.unwrap_or(0) == 1 {
        resolve_optional_steam_magpie(db, game_id).await
    } else {
        None
    };
    Ok(StartedGame::from_steam(
        steam.steam_launch_id,
        steam.game_dir,
        magpie_path,
    ))
}

async fn resolve_optional_steam_magpie(db: &DatabaseConnection, game_id: u32) -> Option<String> {
    let settings = match db.get_settings().await {
        Ok(settings) => settings,
        Err(error) => {
            warn!(
                "Steam 已启动，但读取 Magpie 配置失败 game_id={}: {}",
                game_id, error
            );
            return None;
        }
    };
    match resolve_tool_path(db, settings.magpie_path_value(), ToolPathKind::Magpie).await {
        Ok(path) => Some(path),
        Err(error) => {
            warn!(
                "Steam 已启动，但 Magpie 配置不可用 game_id={}: {}",
                game_id, error
            );
            None
        }
    }
}

async fn launch_local_target(
    db: &DatabaseConnection,
    game_id: u32,
    game: &crate::database::dto::FullGameData,
    args: Option<Vec<String>>,
    intent: LaunchIntent,
) -> Result<StartedGame, String> {
    let local = validate_local_launch(game)?;
    let game_dir = local.game_dir;
    let executable_path = local.executable_path;
    let game_path = executable_path.to_string_lossy().into_owned();
    let is_standard_launch = intent == LaunchIntent::Standard;
    let use_le = is_standard_launch && game.le_launch.unwrap_or(0) == 1;
    let use_magpie = is_standard_launch && game.magpie.unwrap_or(0) == 1;

    let settings = if use_le || use_magpie {
        Some(db.get_settings().await?)
    } else {
        None
    };
    let le_path = if use_le {
        Some(
            resolve_tool_path(
                db,
                settings.as_ref().and_then(|value| value.le_path_value()),
                ToolPathKind::Le,
            )
            .await?,
        )
    } else {
        None
    };
    let magpie_path = if use_magpie {
        Some(
            resolve_tool_path(
                db,
                settings
                    .as_ref()
                    .and_then(|value| value.magpie_path_value()),
                ToolPathKind::Magpie,
            )
            .await?,
        )
    } else {
        None
    };

    let executable_name = executable_path
        .file_name()
        .ok_or_else(|| "无法获取游戏可执行文件名".to_string())?
        .to_string_lossy()
        .into_owned();
    let argument_count = if is_standard_launch {
        args.as_ref().map_or(0, Vec::len)
    } else {
        0
    };
    let invocation = LocalLaunchInvocation::for_game(&game_path, &game_dir, use_le, le_path, args)?;

    if is_standard_launch {
        debug!(
            "准备启动游戏 game_id={} mode={} magpie={} arg_count={} cwd={}",
            game_id,
            invocation.mode.log_name(),
            use_magpie,
            argument_count,
            game_dir.display()
        );
    }

    let started = start_local_launch(
        intent,
        game_id,
        &invocation,
        |plan| plan.command().gui_safe().spawn().map(|child| child.id()),
        |plan| {
            elevated::shell_execute_runas(
                &plan.program,
                plan.arguments.as_deref(),
                &plan.working_directory,
            )
        },
    )
    .map_err(|failure| failure.error_message(&game_dir))?;

    match started.method {
        LocalLaunchMethod::Direct => info!(
            "游戏启动成功 game_id={} pid={} mode={} magpie={}",
            game_id,
            started.process_id,
            invocation.mode.log_name(),
            use_magpie
        ),
        LocalLaunchMethod::ElevatedFallback => info!(
            "游戏提权启动成功 game_id={} pid={} mode={} magpie={}",
            game_id,
            started.process_id,
            invocation.mode.log_name(),
            use_magpie
        ),
        LocalLaunchMethod::ExplicitAdministrator => info!(
            "手动管理员启动成功 game_id={} pid={} cwd={}",
            game_id,
            started.process_id,
            game_dir.display()
        ),
    }

    Ok(StartedGame::from_local(
        started,
        &executable_name,
        &game_dir,
        invocation.mode,
        magpie_path,
    ))
}
/// 停止游戏
///
/// # Arguments
///
/// * `game_id` - 游戏ID (bgm_id 或 vndb_id)
///
/// # Returns
///
/// 停止结果，包含成功标志、消息和终止的进程数量
#[command]
pub async fn stop_game(game_id: u32) -> Result<StopResult, String> {
    match stop_game_session(game_id).await {
        Ok(terminated_count) => Ok(StopResult::success(
            format!(
                "已成功停止游戏 {}, 终止了 {} 个进程",
                game_id, terminated_count
            ),
            terminated_count,
        )),
        Err(e) => Err(format!("停止游戏失败: {}", e)),
    }
}

/// 注册成功启动的游戏，并按当前路径的既有配置异步启动 Magpie。
async fn track_started_game<R: Runtime>(
    app_handle: AppHandle<R>,
    db: DatabaseConnection,
    time_tracking_mode: TimeTrackingMode,
    game_id: u32,
    process_id: u32,
    detection_dir: String,
    magpie_path: Option<String>,
) {
    monitor_game(
        app_handle,
        db,
        time_tracking_mode,
        game_id,
        process_id,
        detection_dir,
    )
    .await;

    if let Some(magpie_path) = magpie_path {
        tokio::spawn(async move {
            if let Err(error) = start_magpie_for_game(game_id, &magpie_path).await {
                warn!("启动 Magpie 全屏缩放失败 game_id={}: {}", game_id, error);
            }
        });
    }
}

/// 为游戏启动Magpie放大
async fn start_magpie_for_game(game_id: u32, magpie_path: &str) -> Result<(), String> {
    let was_running = magpie::ensure_running(magpie_path)?;
    debug!(
        "Magpie 状态 game_id={} was_running={}",
        game_id, was_running
    );

    magpie::wait_until_ready(time::Duration::from_secs(5)).await?;

    match wait_for_game_foreground(game_id).await {
        GameForegroundWaitOutcome::Ready => {}
        GameForegroundWaitOutcome::SessionStopped => {
            info!("游戏 {} 的监控会话已停止，取消 Magpie 全屏缩放", game_id);
            return Ok(());
        }
        GameForegroundWaitOutcome::SessionEnded => {
            info!("游戏 {} 的监控会话已结束，取消 Magpie 全屏缩放", game_id);
            return Ok(());
        }
        GameForegroundWaitOutcome::RegistrationTimedOut => {
            info!(
                "游戏 {} 的监控会话未及时注册，取消 Magpie 全屏缩放",
                game_id
            );
            return Ok(());
        }
        GameForegroundWaitOutcome::ForegroundTimedOut => {
            info!(
                "游戏 {} 未在启动期限内进入前台，取消 Magpie 全屏缩放",
                game_id
            );
            return Ok(());
        }
    }

    debug!("游戏 {} 已进入前台", game_id);
    debug!("游戏 {} 将在固定 2 秒后触发 Magpie 全屏缩放", game_id);
    time::sleep(time::Duration::from_secs(2)).await;

    let game_is_foreground = is_game_foreground(game_id);
    debug!(
        "Magpie 延迟结束 game_id={} game_foreground={}",
        game_id, game_is_foreground
    );
    if !game_is_foreground {
        info!("游戏 {} 在 Magpie 延迟期间离开前台，取消全屏缩放", game_id);
        return Ok(());
    }

    magpie::trigger_fullscreen_scaling()?;

    info!("已触发 Magpie 全屏缩放 game_id={}", game_id);
    Ok(())
}
