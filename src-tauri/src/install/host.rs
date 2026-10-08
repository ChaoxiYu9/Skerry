use super::types::{
    GameInstallCompletedEvent, GameInstallFailedEvent, GameInstallMetadataRequestedEvent,
    InstallHost, TaskControl, TaskProgressEvent, TaskRuntimeState,
};
use std::path::PathBuf;
use tokio::sync::watch;

#[cfg(feature = "tauri-app")]
use tauri::{Emitter, Manager};

#[cfg(feature = "tauri-app")]
#[derive(Clone)]
pub(crate) struct TauriInstallHost {
    app: tauri::AppHandle,
}

#[cfg(feature = "tauri-app")]
impl TauriInstallHost {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(feature = "tauri-app")]
impl InstallHost for TauriInstallHost {
    fn start_task_control(&self, task_id: i64) -> Result<watch::Receiver<TaskControl>, String> {
        self.app.state::<TaskRuntimeState>().start(task_id)
    }

    fn finish_task(&self, task_id: i64) {
        self.app.state::<TaskRuntimeState>().finish(task_id);
    }

    fn seven_zip_path(&self) -> Result<PathBuf, String> {
        let resource_dir = self
            .app
            .path()
            .resource_dir()
            .map_err(|error| format!("无法定位应用资源目录: {error}"))?;
        super::archive::bundled_seven_zip_path(&resource_dir)
    }

    fn emit_progress(&self, event: TaskProgressEvent) {
        let _ = self.app.emit("task-progress", event);
    }

    fn emit_metadata_requested(&self, event: GameInstallMetadataRequestedEvent) {
        let _ = self.app.emit("game-install-metadata-requested", event);
    }

    fn emit_completed(&self, event: GameInstallCompletedEvent) {
        let _ = self.app.emit("game-install-completed", event);
    }

    fn emit_failed(&self, event: GameInstallFailedEvent) {
        let _ = self.app.emit("game-install-failed", event);
    }
}

#[derive(Clone)]
pub(crate) struct NativeInstallHost {
    runtime: TaskRuntimeState,
    resource_dir: PathBuf,
}

impl NativeInstallHost {
    pub(crate) fn new(runtime: TaskRuntimeState, resource_dir: PathBuf) -> Self {
        Self {
            runtime,
            resource_dir,
        }
    }
}

impl InstallHost for NativeInstallHost {
    fn start_task_control(&self, task_id: i64) -> Result<watch::Receiver<TaskControl>, String> {
        self.runtime.start(task_id)
    }

    fn finish_task(&self, task_id: i64) {
        self.runtime.finish(task_id);
    }

    fn seven_zip_path(&self) -> Result<PathBuf, String> {
        super::archive::bundled_seven_zip_path(&self.resource_dir)
    }

    fn emit_progress(&self, _event: TaskProgressEvent) {}

    fn emit_metadata_requested(&self, _event: GameInstallMetadataRequestedEvent) {}

    fn emit_completed(&self, _event: GameInstallCompletedEvent) {}

    fn emit_failed(&self, _event: GameInstallFailedEvent) {}

    fn auto_import_metadata(&self) -> bool {
        true
    }
}
