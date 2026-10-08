//! 通用后台任务实体。

use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "tasks")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    #[sea_orm(column_type = "Text")]
    pub task_type: String,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub status: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub stage: Option<String>,
    #[sea_orm(column_type = "Json")]
    pub payload_json: Json,
    #[sea_orm(column_type = "Json", nullable)]
    pub result_json: Option<Json>,
    pub progress_current: i64,
    pub progress_total: Option<i64>,
    #[sea_orm(column_type = "Text", nullable)]
    pub progress_unit: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub dedupe_key: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error_code: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error_message: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
