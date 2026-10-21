//! 为 user 表增加 KunGal (NextMoe) OAuth 授权信息列。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(r#"ALTER TABLE "user" ADD COLUMN "kungal_auth" TEXT"#)
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(r#"ALTER TABLE "user" DROP COLUMN "kungal_auth""#)
            .await?;
        Ok(())
    }
}
