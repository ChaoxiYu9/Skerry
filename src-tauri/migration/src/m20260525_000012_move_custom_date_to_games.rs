//! 将旧 custom_data.date 合并到 games.date，并从 custom_data JSON 中移除。

use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let move_date = Query::update()
            .table(Games::Table)
            .value(
                Games::Date,
                Expr::cust(r#"json_extract("custom_data", '$.date')"#),
            )
            .and_where(Expr::col(Games::CustomData).is_not_null())
            .and_where(Expr::cust(r#"json_valid("custom_data")"#))
            .and_where(Expr::cust(r#"json_type("custom_data", '$.date')"#).eq("text"))
            .and_where(Expr::cust(r#"trim(json_extract("custom_data", '$.date'))"#).ne(""))
            .to_owned();

        manager.exec_stmt(move_date).await?;

        let remove_custom_date = Query::update()
            .table(Games::Table)
            .value(
                Games::CustomData,
                Expr::cust(r#"json_remove("custom_data", '$.date')"#),
            )
            .and_where(Expr::col(Games::CustomData).is_not_null())
            .and_where(Expr::cust(r#"json_valid("custom_data")"#))
            .and_where(Expr::cust(r#"json_type("custom_data", '$.date')"#).is_not_null())
            .to_owned();

        manager.exec_stmt(remove_custom_date).await?;

        let fallback_source_date = Query::update()
            .table(Games::Table)
            .value(
                Games::Date,
                Expr::cust(
                    r#"COALESCE(
                        CASE
                            WHEN "bgm_data" IS NOT NULL AND json_valid("bgm_data")
                            THEN NULLIF(trim(json_extract("bgm_data", '$.date')), '')
                        END,
                        CASE
                            WHEN "vndb_data" IS NOT NULL AND json_valid("vndb_data")
                            THEN NULLIF(trim(json_extract("vndb_data", '$.date')), '')
                        END,
                        CASE
                            WHEN "ymgal_data" IS NOT NULL AND json_valid("ymgal_data")
                            THEN NULLIF(trim(json_extract("ymgal_data", '$.date')), '')
                        END
                    )"#,
                ),
            )
            .and_where(Expr::cust(r#"("date" IS NULL OR trim("date") = '')"#))
            .and_where(Expr::cust(
                r#"("bgm_data" IS NOT NULL OR "vndb_data" IS NOT NULL OR "ymgal_data" IS NOT NULL)"#,
            ))
            .to_owned();

        manager.exec_stmt(fallback_source_date).await?;

        Ok(())
    }
}

#[derive(DeriveIden)]
enum Games {
    Table,
    Date,
    CustomData,
}
