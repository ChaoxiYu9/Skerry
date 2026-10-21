//! 保留既有数据库的 0017 schema 版本及安装目录字段。
//!
//! 当前 Skerry 没有后台任务表的业务调用方；迁移仍需保留，因为历史数据库
//! 已记录此版本，且该步骤建立的列和表属于现有 SQLite schema。

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, TransactionTrait};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        transaction
            .execute_unprepared(r#"ALTER TABLE "user" ADD COLUMN "install_root_path" TEXT"#)
            .await?;
        transaction
            .execute_unprepared(
                r#"
                CREATE TABLE tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_type TEXT NOT NULL CHECK (trim(task_type) <> ''),
                    title TEXT NOT NULL CHECK (trim(title) <> ''),
                    status TEXT NOT NULL CHECK (status IN (
                        'pending', 'running', 'paused', 'completed', 'failed', 'cancelled'
                    )),
                    stage TEXT,
                    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
                    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
                    progress_current INTEGER NOT NULL DEFAULT 0 CHECK (progress_current >= 0),
                    progress_total INTEGER CHECK (progress_total IS NULL OR progress_total >= 0),
                    progress_unit TEXT,
                    dedupe_key TEXT,
                    error_code TEXT,
                    error_message TEXT,
                    created_at INTEGER NOT NULL,
                    started_at INTEGER,
                    updated_at INTEGER NOT NULL,
                    finished_at INTEGER
                )
                "#,
            )
            .await?;
        transaction
            .execute_unprepared("CREATE INDEX idx_tasks_status ON tasks(status)")
            .await?;
        transaction
            .execute_unprepared("CREATE INDEX idx_tasks_type ON tasks(task_type)")
            .await?;
        transaction
            .execute_unprepared("CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC)")
            .await?;
        transaction
            .execute_unprepared(
                "CREATE UNIQUE INDEX idx_tasks_active_dedupe ON tasks(dedupe_key) \
                 WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running', 'paused')",
            )
            .await?;
        transaction.commit().await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        transaction
            .execute_unprepared("DROP TABLE IF EXISTS tasks")
            .await?;
        transaction
            .execute_unprepared(r#"ALTER TABLE "user" DROP COLUMN "install_root_path""#)
            .await?;
        transaction.commit().await
    }
}
