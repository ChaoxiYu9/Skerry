pub mod archive;
pub mod protocol;

#[cfg(feature = "tauri-app")]
mod commands;
mod download;
mod host;
mod persistence;
mod runner;
mod types;
mod workflow;

#[cfg(feature = "tauri-app")]
pub use commands::{
    cancel_task, complete_game_install_task, create_game_install_task, delete_task,
    fail_game_install_metadata, list_tasks, pause_task, resume_task, retry_task,
};
pub use persistence::recover_interrupted_tasks;

pub(crate) use host::NativeInstallHost;
pub(crate) use persistence::{find_task, remove_task_artifacts, set_task_cancelled};
#[cfg(feature = "tauri-app")]
pub use runner::resume_pending_tasks;
pub(crate) use runner::{resume_pending_tasks_with_host, spawn_task_with_host};
pub use types::TaskRuntimeState;
pub(crate) use types::{ACTIVE_TASK_STATUSES, GameInstallTaskPayloadV1, wait_for_task_completion};
