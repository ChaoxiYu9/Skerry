//! Stored identity facts consumed by scan and import planning.
//!
//! These reads keep the persisted strings unchanged. Windows path and Steam ID
//! normalization belongs to the corresponding scan/import use case.

use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, Statement};
use std::collections::HashSet;

pub(crate) const GAME_IDENTITY_SOURCES: [&str; 7] = [
    "bgm",
    "vndb",
    "hikarinagi",
    "ymgal",
    "kun",
    "dlsite",
    "erogamescape",
];

pub struct GameImportRepository;

impl GameImportRepository {
    pub async fn get_all_game_directories(
        db: &DatabaseConnection,
    ) -> Result<HashSet<String>, DbErr> {
        db.query_all(Statement::from_string(
            DatabaseBackend::Sqlite,
            "SELECT localpath FROM games WHERE localpath IS NOT NULL",
        ))
        .await?
        .into_iter()
        .map(|row| row.try_get("", "localpath"))
        .collect()
    }

    pub async fn get_all_steam_launch_ids<C>(db: &C) -> Result<HashSet<String>, DbErr>
    where
        C: ConnectionTrait,
    {
        db.query_all(Statement::from_string(
            DatabaseBackend::Sqlite,
            "SELECT steam_launch_id FROM games WHERE steam_launch_id IS NOT NULL",
        ))
        .await?
        .into_iter()
        .map(|row| row.try_get("", "steam_launch_id"))
        .collect()
    }

    pub async fn get_all_source_identities<C>(db: &C) -> Result<HashSet<(String, String)>, DbErr>
    where
        C: ConnectionTrait,
    {
        let source_slots = vec!["?"; GAME_IDENTITY_SOURCES.len()].join(", ");
        let query = format!(
            "SELECT source, external_id FROM game_sources \
             WHERE external_id IS NOT NULL AND source IN ({source_slots})"
        );
        db.query_all(Statement::from_sql_and_values(
            DatabaseBackend::Sqlite,
            query,
            GAME_IDENTITY_SOURCES.into_iter().map(sea_orm::Value::from),
        ))
        .await?
        .into_iter()
        .map(|row| Ok((row.try_get("", "source")?, row.try_get("", "external_id")?)))
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{GAME_IDENTITY_SOURCES, GameImportRepository};
    use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement, TransactionTrait};
    use std::collections::HashSet;

    #[tokio::test]
    async fn identity_reads_preserve_stored_values_and_scope_provider_keys() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        db.execute_unprepared(
            "CREATE TABLE games (localpath TEXT, steam_launch_id TEXT); \
             CREATE TABLE game_sources (source TEXT, external_id TEXT); \
             INSERT INTO games VALUES ('E:\\Games\\One', '00042'), \
             ('E:\\Games\\One', '00042'), ('', ''), (NULL, NULL); \
             INSERT INTO game_sources VALUES ('bgm', '001'), ('bgm', '001'), \
             ('unknown', '001'), ('vndb', NULL)",
        )
        .await
        .unwrap();

        assert_eq!(
            GameImportRepository::get_all_game_directories(&db)
                .await
                .unwrap(),
            HashSet::from(["E:\\Games\\One".to_owned(), String::new()])
        );
        let transaction = db.begin().await.unwrap();
        assert_eq!(
            GameImportRepository::get_all_steam_launch_ids(&transaction)
                .await
                .unwrap(),
            HashSet::from(["00042".to_owned(), String::new()])
        );
        assert_eq!(
            GameImportRepository::get_all_source_identities(&transaction)
                .await
                .unwrap(),
            HashSet::from([("bgm".to_owned(), "001".to_owned())])
        );
        transaction.rollback().await.unwrap();

        for source in GAME_IDENTITY_SOURCES {
            db.execute(Statement::from_sql_and_values(
                DatabaseBackend::Sqlite,
                "INSERT INTO game_sources (source, external_id) VALUES (?, ?)",
                [source.into(), "registered".into()],
            ))
            .await
            .unwrap();
        }
        let identities = GameImportRepository::get_all_source_identities(&db)
            .await
            .unwrap();
        for source in GAME_IDENTITY_SOURCES {
            assert!(identities.contains(&(source.to_owned(), "registered".to_owned())));
        }
    }
}
