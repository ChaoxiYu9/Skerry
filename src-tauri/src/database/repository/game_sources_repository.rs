//! Provider bindings and the release-date projection derived from their metadata.

use crate::database::dto::{InsertGameData, UpdateGameData, UpsertGameSourceData};
use crate::entity::game_sources;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, EntityTrait,
    QueryFilter, QuerySelect, Statement,
};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub(crate) struct GameSourcesRepository;

// game_id, source, external_id and data are the four writable source columns.
const SOURCE_UPSERT_BINDINGS_PER_ROW: usize = 4;
// Compatibility fallback when SQLite omits MAX_VARIABLE_NUMBER from compile_options.
const SQLITE_DEFAULT_MAX_VARIABLE_NUMBER: usize = 999;

impl GameSourcesRepository {
    pub(super) fn validate_source_changes(
        upserts: &[UpsertGameSourceData],
        removes: &[String],
    ) -> Result<(), DbErr> {
        let mut submitted_sources = HashSet::with_capacity(upserts.len());
        for source in upserts {
            if source.source.is_empty() {
                return Err(DbErr::Custom("source 不能为空".to_owned()));
            }
            if source.external_id.is_none() && source.data.is_none() {
                return Err(DbErr::Custom(format!(
                    "{} source 的 external_id 和 data 不能同时为空",
                    source.source
                )));
            }
            if !submitted_sources.insert(source.source.as_str()) {
                return Err(DbErr::Custom(format!(
                    "{} source 被重复提交",
                    source.source
                )));
            }
        }

        let mut removed_sources = HashSet::with_capacity(removes.len());
        for source in removes {
            if submitted_sources.contains(source.as_str()) {
                return Err(DbErr::Custom(format!(
                    "{} source 不能同时更新和删除",
                    source
                )));
            }
            if !removed_sources.insert(source) {
                return Err(DbErr::Custom(format!("{} source 被重复删除", source)));
            }
        }
        Ok(())
    }

    pub(super) fn normalize_insert_date(game: &mut InsertGameData) {
        // New games preserve provider input order; updates use the registered priority.
        if game.date.is_none() {
            game.date = game
                .sources
                .iter()
                .find_map(|source| Self::extract_source_date(source.data.as_ref()))
                .map(str::to_owned);
        }
    }

    fn extract_source_date(data: Option<&Value>) -> Option<&str> {
        let date = data?.get("date")?.as_str()?.trim();
        (!date.is_empty()).then_some(date)
    }

    fn resolve_source_date(source_data: &BTreeMap<String, Option<Value>>) -> Option<String> {
        let preferred_sources = super::game_source_priorities::MIXED_NAME_AND_DATE_PRIORITY;
        let preferred_date = preferred_sources.iter().find_map(|source| {
            source_data
                .get(*source)
                .and_then(|data| Self::extract_source_date(data.as_ref()))
        });
        let fallback_date = || {
            source_data
                .iter()
                .filter(|(source, _)| !preferred_sources.contains(&source.as_str()))
                .find_map(|(_, data)| Self::extract_source_date(data.as_ref()))
        };
        preferred_date.or_else(fallback_date).map(str::to_owned)
    }

    pub(super) async fn normalize_update_sources<C>(
        db: &C,
        game_id: i32,
        mut updates: UpdateGameData,
    ) -> Result<UpdateGameData, DbErr>
    where
        C: ConnectionTrait,
    {
        let requested_upserts = updates.upsert_sources.as_deref().unwrap_or_default();
        let requested_removals = updates.remove_sources.as_deref().unwrap_or_default();
        let must_guard_existing_bindings =
            requested_upserts.iter().any(|source| source.data.is_none());
        let must_derive_date = matches!(updates.date, Some(None))
            || updates.date.is_none()
                && (!requested_upserts.is_empty() || !requested_removals.is_empty());
        if !must_guard_existing_bindings && !must_derive_date {
            return Ok(updates);
        }

        // The caller's transaction supplies one authoritative snapshot for identity
        // protection and the post-edit date projection.
        let mut metadata_by_source: BTreeMap<String, Option<Value>> = game_sources::Entity::find()
            .select_only()
            .column(game_sources::Column::Source)
            .column(game_sources::Column::Data)
            .filter(game_sources::Column::GameId.eq(game_id))
            .into_tuple::<(String, Option<Value>)>()
            .all(db)
            .await?
            .into_iter()
            .collect();

        if let Some(upserts) = updates.upsert_sources.as_mut() {
            // Identity-only imports may create a binding. Replacing an existing
            // binding requires metadata so an enrichment request cannot erase it.
            upserts.retain(|source| {
                source.data.is_some() || !metadata_by_source.contains_key(&source.source)
            });
        }

        let effective_upserts = updates.upsert_sources.as_deref().unwrap_or_default();
        let effective_removals = updates.remove_sources.as_deref().unwrap_or_default();
        let refresh_date = match &updates.date {
            Some(Some(_)) => false,
            Some(None) => true,
            None => !effective_upserts.is_empty() || !effective_removals.is_empty(),
        };
        if refresh_date {
            for source in effective_removals {
                metadata_by_source.remove(source);
            }
            for source in effective_upserts {
                metadata_by_source.insert(source.source.clone(), source.data.clone());
            }
            updates.date = Some(Self::resolve_source_date(&metadata_by_source));
        }
        Ok(updates)
    }

    fn source_rows_per_statement(max_variable_number: usize) -> Result<usize, DbErr> {
        match max_variable_number / SOURCE_UPSERT_BINDINGS_PER_ROW {
            0 => Err(DbErr::Custom(format!(
                "SQLite 参数上限 {max_variable_number} 不足以写入一条来源记录"
            ))),
            rows => Ok(rows),
        }
    }

    async fn sqlite_max_variable_number<C>(db: &C) -> Result<usize, DbErr>
    where
        C: ConnectionTrait,
    {
        let options = db
            .query_all(Statement::from_string(
                DatabaseBackend::Sqlite,
                "PRAGMA compile_options",
            ))
            .await?;
        for option in options {
            let option: String = option.try_get_by(0)?;
            if let Some(limit) = option.strip_prefix("MAX_VARIABLE_NUMBER=") {
                return limit.parse().map_err(|error| {
                    DbErr::Custom(format!("无法解析 SQLite 参数上限 {limit}: {error}"))
                });
            }
        }
        Ok(SQLITE_DEFAULT_MAX_VARIABLE_NUMBER)
    }

    async fn execute_source_upsert_batches<C>(
        db: &C,
        game_id: i32,
        sources: &[UpsertGameSourceData],
        rows_per_statement: usize,
    ) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
        if rows_per_statement == 0 {
            return Err(DbErr::Custom(
                "来源批量写入的单条记录容量不能为零".to_owned(),
            ));
        }
        for batch in sources.chunks(rows_per_statement) {
            let mut statement = String::from(
                "INSERT INTO game_sources (game_id, source, external_id, data) VALUES ",
            );
            let mut bindings =
                Vec::<sea_orm::Value>::with_capacity(batch.len() * SOURCE_UPSERT_BINDINGS_PER_ROW);
            for (index, source) in batch.iter().enumerate() {
                if index != 0 {
                    statement.push_str(", ");
                }
                statement.push_str("(?, ?, ?, ?)");
                bindings.extend([
                    game_id.into(),
                    source.source.clone().into(),
                    source.external_id.clone().into(),
                    source.data.clone().into(),
                ]);
            }
            // score and rank belong to SQLite generated columns, never this writer.
            statement.push_str(
                " ON CONFLICT (game_id, source) DO UPDATE SET \
                 external_id = excluded.external_id, data = excluded.data",
            );
            db.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                statement,
                bindings,
            ))
            .await?;
        }
        Ok(())
    }

    pub(super) async fn upsert_sources<C>(
        db: &C,
        game_id: i32,
        sources: &[UpsertGameSourceData],
    ) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
        if sources.is_empty() {
            return Ok(());
        }
        if db.get_database_backend() != DatabaseBackend::Sqlite {
            return Err(DbErr::Custom("来源批量写入仅支持 SQLite 数据库".to_owned()));
        }
        let rows_per_statement = if sources.len() == 1 {
            1
        } else {
            Self::source_rows_per_statement(Self::sqlite_max_variable_number(db).await?)?
        };
        Self::execute_source_upsert_batches(db, game_id, sources, rows_per_statement).await
    }

    pub(super) async fn remove_sources<C>(
        db: &C,
        game_id: i32,
        sources: &[String],
    ) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
        if sources.is_empty() {
            return Ok(());
        }
        // One parameter is reserved for game_id; the rest belong to the IN list.
        let rows_per_statement = Self::sqlite_max_variable_number(db)
            .await?
            .checked_sub(1)
            .filter(|capacity| *capacity != 0)
            .ok_or_else(|| DbErr::Custom("SQLite 参数上限不足以删除来源记录".to_owned()))?;
        for batch in sources.chunks(rows_per_statement) {
            let mut statement =
                String::from("DELETE FROM game_sources WHERE game_id = ? AND source IN (");
            let mut bindings = Vec::<sea_orm::Value>::with_capacity(batch.len() + 1);
            bindings.push(game_id.into());
            for (index, source) in batch.iter().enumerate() {
                if index != 0 {
                    statement.push_str(", ");
                }
                statement.push('?');
                bindings.push(source.clone().into());
            }
            statement.push(')');
            db.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                statement,
                bindings,
            ))
            .await?;
        }
        Ok(())
    }

    pub(crate) async fn get_source_bindings(
        db: &DatabaseConnection,
        source: &str,
    ) -> Result<Vec<(i32, String)>, DbErr> {
        db.query_all(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            "SELECT game_id, external_id FROM game_sources \
             WHERE source = ? AND external_id IS NOT NULL",
            [source.into()],
        ))
        .await?
        .into_iter()
        .map(|row| Ok((row.try_get("", "game_id")?, row.try_get("", "external_id")?)))
        .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::GameSourcesRepository;
    use crate::database::dto::{UpdateGameData, UpsertGameSourceData};
    use crate::entity::game_sources::Entity as GameSources;
    use sea_orm::{ConnectionTrait, Database, EntityTrait, TransactionTrait};
    use serde_json::json;
    use std::collections::BTreeMap;

    async fn source_database() -> sea_orm::DatabaseConnection {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        db.execute_unprepared(
            r#"CREATE TABLE game_sources (
                game_id INTEGER NOT NULL,
                source TEXT NOT NULL,
                external_id TEXT,
                data TEXT,
                score REAL GENERATED ALWAYS AS (CAST(json_extract(data, '$.score') AS REAL)) VIRTUAL,
                rank INTEGER GENERATED ALWAYS AS (CAST(json_extract(data, '$.rank') AS INTEGER)) VIRTUAL,
                PRIMARY KEY (game_id, source),
                CHECK (external_id IS NOT NULL OR data IS NOT NULL),
                CHECK (data IS NULL OR json_valid(data))
            )"#,
        )
        .await
        .unwrap();
        db
    }

    fn valid_source_change(source: &str) -> UpsertGameSourceData {
        UpsertGameSourceData {
            source: source.to_string(),
            external_id: Some(format!("{source}-id")),
            data: None,
        }
    }

    #[test]
    fn source_change_index_rejects_duplicate_and_conflicting_intents() {
        let upserts = [valid_source_change("bgm"), valid_source_change("vndb")];
        let removes = ["kun".to_string()];
        assert!(GameSourcesRepository::validate_source_changes(&upserts, &removes).is_ok());

        let duplicate_upserts = [valid_source_change("bgm"), valid_source_change("bgm")];
        assert!(
            GameSourcesRepository::validate_source_changes(&duplicate_upserts, &[])
                .unwrap_err()
                .to_string()
                .contains("bgm source 被重复提交")
        );

        let duplicate_removes = ["bgm".to_string(), "bgm".to_string()];
        assert!(
            GameSourcesRepository::validate_source_changes(&[], &duplicate_removes)
                .unwrap_err()
                .to_string()
                .contains("bgm source 被重复删除")
        );

        let conflicting_removes = ["bgm".to_string()];
        assert!(
            GameSourcesRepository::validate_source_changes(&upserts[..1], &conflicting_removes)
                .unwrap_err()
                .to_string()
                .contains("bgm source 不能同时更新和删除")
        );

        let empty_source = [UpsertGameSourceData {
            source: String::new(),
            external_id: None,
            data: None,
        }];
        assert!(
            GameSourcesRepository::validate_source_changes(&empty_source, &[])
                .unwrap_err()
                .to_string()
                .contains("source 不能为空")
        );

        let identity_free_source = [UpsertGameSourceData {
            source: "bgm".to_string(),
            external_id: None,
            data: None,
        }];
        assert!(
            GameSourcesRepository::validate_source_changes(&identity_free_source, &[])
                .unwrap_err()
                .to_string()
                .contains("bgm source 的 external_id 和 data 不能同时为空")
        );
    }

    #[test]
    fn source_batch_capacity_uses_all_bindings_without_exceeding_sqlite_limit() {
        assert_eq!(
            GameSourcesRepository::source_rows_per_statement(999).unwrap(),
            249
        );
        assert_eq!(
            GameSourcesRepository::source_rows_per_statement(32_766).unwrap(),
            8_191
        );
        assert!(GameSourcesRepository::source_rows_per_statement(3).is_err());
    }

    #[tokio::test]
    async fn source_upserts_keep_input_order_across_statement_boundaries() {
        let db = source_database().await;
        let sources = vec![
            UpsertGameSourceData {
                source: "bgm".to_string(),
                external_id: Some("first".to_string()),
                data: Some(json!({"score": 7.5, "rank": 3})),
            },
            UpsertGameSourceData {
                source: "bgm".to_string(),
                external_id: Some("within-statement".to_string()),
                data: Some(json!({"score": 7.8, "rank": 2})),
            },
            UpsertGameSourceData {
                source: "vndb".to_string(),
                external_id: Some("vn-1".to_string()),
                data: Some(json!({"title": "Visual Novel"})),
            },
            UpsertGameSourceData {
                source: "bgm".to_string(),
                external_id: Some("last".to_string()),
                data: Some(json!({"score": 8.0, "rank": 2})),
            },
        ];

        GameSourcesRepository::execute_source_upsert_batches(&db, 17, &sources, 2)
            .await
            .unwrap();
        let persisted = GameSources::find().all(&db).await.unwrap();
        let bgm = persisted
            .iter()
            .find(|source| source.source == "bgm")
            .unwrap();
        let vndb = persisted
            .iter()
            .find(|source| source.source == "vndb")
            .unwrap();

        assert_eq!(bgm.external_id.as_deref(), Some("last"));
        assert_eq!(bgm.score, Some(8.0));
        assert_eq!(bgm.rank, Some(2));
        assert_eq!(vndb.external_id.as_deref(), Some("vn-1"));
        assert_eq!(persisted.len(), 2);
    }

    #[tokio::test]
    async fn failed_later_batch_leaves_rollback_to_the_callers_transaction() {
        let db = source_database().await;
        let transaction = db.begin().await.unwrap();
        let sources = vec![
            UpsertGameSourceData {
                source: "valid-one".to_string(),
                external_id: Some("one".to_string()),
                data: None,
            },
            UpsertGameSourceData {
                source: "valid-two".to_string(),
                external_id: Some("two".to_string()),
                data: None,
            },
            UpsertGameSourceData {
                source: "invalid".to_string(),
                external_id: None,
                data: None,
            },
        ];

        assert!(
            GameSourcesRepository::execute_source_upsert_batches(&transaction, 17, &sources, 2)
                .await
                .is_err()
        );
        transaction.rollback().await.unwrap();

        assert!(GameSources::find().all(&db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sqlite_variable_limit_comes_from_the_active_database_build() {
        let db = source_database().await;
        let actual_limit = GameSourcesRepository::sqlite_max_variable_number(&db)
            .await
            .unwrap();
        let rows_per_statement =
            GameSourcesRepository::source_rows_per_statement(actual_limit).unwrap();
        assert!(rows_per_statement >= 7);

        let sources = (0..7)
            .map(|index| UpsertGameSourceData {
                source: format!("source-{index}"),
                external_id: Some(format!("external-{index}")),
                data: None,
            })
            .collect::<Vec<_>>();
        GameSourcesRepository::upsert_sources(&db, 17, &sources)
            .await
            .unwrap();
        assert_eq!(GameSources::find().all(&db).await.unwrap().len(), 7);
    }

    #[tokio::test]
    async fn source_edit_projection_uses_effective_changes_and_preserves_identity_only_bindings() {
        let db = source_database().await;
        let current_sources = [
            UpsertGameSourceData {
                source: "bgm".to_owned(),
                external_id: Some("current-bgm-id".to_owned()),
                data: Some(json!({"date": "2024-01-01"})),
            },
            UpsertGameSourceData {
                source: "vndb".to_owned(),
                external_id: Some("current-vndb-id".to_owned()),
                data: Some(json!({"date": "2023-01-01"})),
            },
        ];
        GameSourcesRepository::upsert_sources(&db, 17, &current_sources)
            .await
            .unwrap();

        let identity_only = GameSourcesRepository::normalize_update_sources(
            &db,
            17,
            UpdateGameData {
                upsert_sources: Some(vec![valid_source_change("bgm")]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(identity_only.upsert_sources.unwrap().is_empty());
        assert_eq!(identity_only.date, None);

        let removal = GameSourcesRepository::normalize_update_sources(
            &db,
            17,
            UpdateGameData {
                date: Some(None),
                remove_sources: Some(vec!["bgm".to_owned()]),
                upsert_sources: Some(vec![valid_source_change("kun")]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(removal.date, Some(Some("2023-01-01".to_owned())));
        assert_eq!(removal.upsert_sources.unwrap().len(), 1);

        let explicit_date = GameSourcesRepository::normalize_update_sources(
            &db,
            17,
            UpdateGameData {
                date: Some(Some("2025-01-01".to_owned())),
                remove_sources: Some(vec!["bgm".to_owned()]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(explicit_date.date, Some(Some("2025-01-01".to_owned())));
    }

    #[tokio::test]
    async fn source_binding_reads_and_removal_keep_other_games_and_sources_intact() {
        let db = source_database().await;
        GameSourcesRepository::upsert_sources(&db, 17, &[valid_source_change("bgm")])
            .await
            .unwrap();
        GameSourcesRepository::upsert_sources(
            &db,
            23,
            &[valid_source_change("bgm"), valid_source_change("vndb")],
        )
        .await
        .unwrap();
        GameSourcesRepository::remove_sources(&db, 17, &["bgm".to_owned()])
            .await
            .unwrap();

        assert_eq!(
            GameSourcesRepository::get_source_bindings(&db, "bgm")
                .await
                .unwrap(),
            vec![(23, "bgm-id".to_owned())]
        );
        assert_eq!(GameSources::find().all(&db).await.unwrap().len(), 2);
    }

    #[test]
    fn registered_source_priority_precedes_lexical_fallback() {
        let source_data = BTreeMap::from([
            ("aaa".to_owned(), Some(json!({"date": "2020-01-01"}))),
            ("vndb".to_owned(), Some(json!({"date": "2023-01-01"}))),
            ("bgm".to_owned(), Some(json!({"date": " 2024-01-01 "}))),
        ]);

        assert_eq!(
            GameSourcesRepository::resolve_source_date(&source_data).as_deref(),
            Some("2024-01-01")
        );
    }

    #[test]
    fn fallback_chooses_the_smallest_source_with_a_nonempty_string_date() {
        let source_data = BTreeMap::from([
            ("zeta".to_owned(), Some(json!({"date": "2030-01-01"}))),
            ("alpha".to_owned(), Some(json!({"date": "  "}))),
            ("beta".to_owned(), Some(json!({"date": " 2022-03-04 "}))),
            ("aardvark".to_owned(), None),
        ]);

        assert_eq!(
            GameSourcesRepository::resolve_source_date(&source_data).as_deref(),
            Some("2022-03-04")
        );
    }

    #[test]
    fn returns_no_date_when_all_source_dates_are_missing_or_invalid() {
        let source_data = BTreeMap::from([
            ("alpha".to_owned(), None),
            ("beta".to_owned(), Some(json!({"date": 2024}))),
            ("gamma".to_owned(), Some(json!({"date": ""}))),
        ]);

        assert_eq!(
            GameSourcesRepository::resolve_source_date(&source_data),
            None
        );
    }
}
