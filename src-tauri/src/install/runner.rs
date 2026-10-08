#[cfg(feature = "tauri-app")]
use super::host::TauriInstallHost;
use super::{
    download::{download_file, verify_file},
    persistence::check_task_control,
    persistence::{
        cleanup_task_artifacts, emit_progress, fail_task, find_task, save_game_install_result,
        set_task_cancelled, set_task_paused, set_task_stage,
    },
    types::{GAME_INSTALL_TASK_TYPE, GameInstallResultV1, InstallHost, TaskControl, TaskFailure},
    workflow::{
        emit_game_install_failed, game_directory_name, parse_game_install_payload,
        parse_game_install_result, prepare_game_import,
    },
};
use crate::entity::tasks;
use crate::install::archive::{collapse_single_directory_layers, extract_archive, move_game_root};
use sea_orm::DatabaseConnection;
use std::path::Path;
use tokio::sync::watch;

#[cfg(feature = "tauri-app")]
pub fn resume_pending_tasks(app: &tauri::AppHandle, db: &DatabaseConnection, task_ids: Vec<i64>) {
    let host = TauriInstallHost::new(app.clone());
    resume_pending_tasks_with_host(host, db, task_ids);
}

pub(crate) fn resume_pending_tasks_with_host<H: InstallHost>(
    host: H,
    db: &DatabaseConnection,
    task_ids: Vec<i64>,
) {
    for task_id in task_ids {
        if let Err(error) = spawn_task_with_host(host.clone(), db.clone(), task_id) {
            log::error!("恢复等待任务失败 task_id={task_id}: {error}");
        }
    }
}

#[cfg(feature = "tauri-app")]
pub(crate) fn spawn_task(
    app: tauri::AppHandle,
    db: DatabaseConnection,
    task_id: i64,
) -> Result<(), String> {
    spawn_task_with_host(TauriInstallHost::new(app), db, task_id)
}

pub(crate) fn spawn_task_with_host<H: InstallHost>(
    host: H,
    db: DatabaseConnection,
    task_id: i64,
) -> Result<(), String> {
    let control = host.start_task_control(task_id)?;
    tokio::spawn(async move {
        if let Err(failure) = run_task(&host, &db, task_id, control).await {
            match failure.code.as_str() {
                "paused" => {
                    if let Ok(task) = set_task_paused(&db, task_id).await {
                        emit_progress(
                            &host,
                            task_id,
                            &task.status,
                            task.stage.as_deref(),
                            task.progress_current,
                            task.progress_total,
                            task.progress_unit.as_deref(),
                        );
                    }
                }
                "cancelled" => {
                    let _ = set_task_cancelled(&db, task_id).await;
                }
                _ => {
                    log::error!(
                        "任务失败 task_id={} code={}: {}",
                        task_id,
                        failure.code,
                        failure.message
                    );
                    let failed =
                        fail_task(&db, task_id, &failure.code, &failure.message, None).await;
                    emit_game_install_failed(&host, task_id, failed.as_ref().ok(), &failure);
                }
            }
        }
        host.finish_task(task_id);
    });
    Ok(())
}

async fn run_task<H: InstallHost>(
    host: &H,
    db: &DatabaseConnection,
    task_id: i64,
    mut control: watch::Receiver<TaskControl>,
) -> Result<(), TaskFailure> {
    let task = find_task(db, task_id)
        .await
        .map_err(|message| TaskFailure::new("task_not_found", message))?;
    match task.task_type.as_str() {
        GAME_INSTALL_TASK_TYPE => run_game_install_task(host, db, task, &mut control).await,
        task_type => Err(TaskFailure::new(
            "unsupported_task_type",
            format!("不支持的任务类型: {task_type}"),
        )),
    }
}

async fn run_game_install_task<H: InstallHost>(
    host: &H,
    db: &DatabaseConnection,
    task: tasks::Model,
    control: &mut watch::Receiver<TaskControl>,
) -> Result<(), TaskFailure> {
    let payload = parse_game_install_payload(&task)?;
    let request = &payload.request;
    check_task_control(control)?;

    if let Some(result) = parse_game_install_result(&task)?
        && Path::new(&result.install_path).is_dir()
    {
        prepare_game_import(host, db, &task, request, result, control).await?;
        cleanup_task_artifacts(&payload, task.id).await;
        return Ok(());
    }

    let install_root = payload.install_root()?;
    tokio::fs::create_dir_all(&install_root)
        .await
        .map_err(|error| TaskFailure::new("install_root_failed", error.to_string()))?;
    let download_path = payload.download_path(task.id)?;

    set_task_stage(db, task.id, "downloading").await?;
    emit_progress(
        host,
        task.id,
        "running",
        Some("downloading"),
        task.progress_current,
        Some(request.size as i64),
        Some("bytes"),
    );
    download_file(host, db, &task, request, &download_path, control).await?;
    check_task_control(control)?;

    set_task_stage(db, task.id, "verifying").await?;
    emit_progress(
        host,
        task.id,
        "running",
        Some("verifying"),
        request.size as i64,
        Some(request.size as i64),
        Some("bytes"),
    );
    verify_file(download_path.clone(), request.clone()).await?;
    check_task_control(control)?;

    set_task_stage(db, task.id, "extracting").await?;
    emit_progress(
        host,
        task.id,
        "running",
        Some("extracting"),
        request.size as i64,
        Some(request.size as i64),
        Some("bytes"),
    );
    let staging = payload.staging_directory(task.id)?;
    let seven_zip = host
        .seven_zip_path()
        .map_err(|message| TaskFailure::new("seven_zip_missing", message))?;
    tokio::task::spawn_blocking({
        let download_path = download_path.clone();
        let archive_format = request.archive_format.clone();
        let staging = staging.clone();
        move || extract_archive(&seven_zip, &download_path, &archive_format, &staging)
    })
    .await
    .map_err(|error| TaskFailure::new("extract_task_failed", error.to_string()))?
    .map_err(|message| TaskFailure::new("extract_failed", message))?;

    check_task_control(control)?;
    set_task_stage(db, task.id, "organizing").await?;
    emit_progress(
        host,
        task.id,
        "running",
        Some("organizing"),
        request.size as i64,
        Some(request.size as i64),
        Some("bytes"),
    );
    let game_root = tokio::task::spawn_blocking({
        let staging = staging.clone();
        move || collapse_single_directory_layers(&staging)
    })
    .await
    .map_err(|error| TaskFailure::new("organize_task_failed", error.to_string()))?
    .map_err(|message| TaskFailure::new("organize_failed", message))?;
    let directory_name = game_directory_name(&game_root, &staging, request, task.id);
    let final_root = tokio::task::spawn_blocking({
        let install_root = install_root.clone();
        move || move_game_root(&game_root, &install_root, &directory_name, task.id)
    })
    .await
    .map_err(|error| TaskFailure::new("organize_task_failed", error.to_string()))?
    .map_err(|message| TaskFailure::new("organize_failed", message))?;
    let result = GameInstallResultV1::partial(&final_root, None);
    save_game_install_result(db, task.id, &result).await?;
    prepare_game_import(host, db, &task, request, result, control).await?;
    cleanup_task_artifacts(&payload, task.id).await;
    Ok(())
}
