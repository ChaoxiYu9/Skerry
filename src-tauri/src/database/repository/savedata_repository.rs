//! 游戏的存档备份记录仓库。

use crate::entity::prelude::*;
use crate::entity::savedata;
use sea_orm::*;

pub struct SavedataRepository;

impl SavedataRepository {
    // ==================== 存档备份相关操作 ====================

    pub async fn save_savedata_record(
        db: &DatabaseConnection,
        game_id: i32,
        file_name: &str,
        backup_time: i32,
        file_size: i32,
    ) -> Result<i32, DbErr> {
        let savedata_record = savedata::ActiveModel {
            id: NotSet,
            game_id: Set(game_id),
            file: Set(file_name.to_string()),
            backup_time: Set(backup_time),
            file_size: Set(file_size),
        };
        let result = savedata_record.insert(db).await?;
        Ok(result.id)
    }

    pub async fn get_savedata_count(db: &DatabaseConnection, game_id: i32) -> Result<u64, DbErr> {
        Savedata::find()
            .filter(savedata::Column::GameId.eq(game_id))
            .count(db)
            .await
    }

    pub async fn get_savedata_records(
        db: &DatabaseConnection,
        game_id: i32,
    ) -> Result<Vec<savedata::Model>, DbErr> {
        Savedata::find()
            .filter(savedata::Column::GameId.eq(game_id))
            .order_by_desc(savedata::Column::BackupTime)
            .all(db)
            .await
    }

    pub async fn get_savedata_record_by_id(
        db: &DatabaseConnection,
        backup_id: i32,
    ) -> Result<Option<savedata::Model>, DbErr> {
        Savedata::find_by_id(backup_id).one(db).await
    }

    pub async fn delete_savedata_record<C>(db: &C, backup_id: i32) -> Result<DeleteResult, DbErr>
    where
        C: ConnectionTrait,
    {
        Savedata::delete_by_id(backup_id).exec(db).await
    }
}
