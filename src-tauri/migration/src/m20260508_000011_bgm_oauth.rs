//! BGM 授权信息 JSON 化，并统一 user 表 token 列名为小写。
//!
//! - BGM_TOKEN -> bgm_auth，并把旧 access token 包装成 BgmAuth JSON。
//! - VNDB_TOKEN -> vndb_token。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(User::Table)
                    .rename_column(User::BgmToken, User::BgmAuth)
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(User::Table)
                    .rename_column(User::VndbTokenUpper, User::VndbToken)
                    .to_owned(),
            )
            .await?;

        // SQLite JSON 包装用 json_object 更直接；迁移其余结构仍走 SeaORM schema builder。
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                UPDATE "user"
                SET "bgm_auth" = json_object(
                    'access_token', "bgm_auth",
                    'refresh_token', null,
                    'expires_at', null,
                    'username', null,
                    'nickname', null
                )
                WHERE "bgm_auth" IS NOT NULL
                  AND "bgm_auth" != ''
                  AND json_valid("bgm_auth") = 0
                "#,
            )
            .await?;

        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Err(DbErr::Custom(
            "此迁移无法回滚，请从备份恢复数据库".to_string(),
        ))
    }
}

#[derive(DeriveIden)]
enum User {
    Table,
    #[sea_orm(iden = "BGM_TOKEN")]
    BgmToken,
    BgmAuth,
    #[sea_orm(iden = "VNDB_TOKEN")]
    VndbTokenUpper,
    VndbToken,
}
