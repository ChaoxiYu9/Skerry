use crate::database::dto::UpdateSettingsData;
use crate::entity::prelude::*;
use crate::entity::user;
use crate::entity::user::Model;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::*;

/// 用户设置仓库
pub struct SettingsRepository;

#[derive(Clone, Copy)]
enum RefreshTokenCondition<'a> {
    Equals(&'a str),
    Is(Option<&'a str>),
}

pub trait DbSettingsExt {
    /// 获取设置模型，并自动处理好错误转换
    async fn get_settings(&self) -> Result<Model, String>;
}

impl DbSettingsExt for DatabaseConnection {
    async fn get_settings(&self) -> Result<Model, String> {
        SettingsRepository::get_all_settings(self)
            .await
            .map_err(|e| format!("获取设置失败: {}", e))
    }
}

impl SettingsRepository {
    fn resolve_tool_default(
        current_value: bool,
        requested_value: Option<bool>,
        path_is_configured: bool,
        missing_path_error: &'static str,
    ) -> Result<bool, DbErr> {
        if requested_value == Some(true) && !path_is_configured {
            return Err(DbErr::Custom(missing_path_error.to_string()));
        }

        Ok(path_is_configured && requested_value.unwrap_or(current_value))
    }

    /// 确保用户记录存在（ID 固定为 1）
    async fn ensure_user_exists(db: &impl ConnectionTrait) -> Result<(), DbErr> {
        let existing = User::find_by_id(1).one(db).await?;

        if existing.is_none() {
            let default_user = user::ActiveModel {
                id: Set(1),
                bgm_auth: Set(None),
                hikarinagi_auth: Set(None),
                kungal_auth: Set(None),
                vndb_token: Set(None),
                save_root_path: Set(None),
                db_backup_path: Set(None),
                le_path: Set(None),
                magpie_path: Set(None),
                detail_backdrop_path: Set(None),
                default_le_launch: Set(false),
                default_magpie: Set(false),
            };

            User::insert(default_user)
                .on_conflict(OnConflict::column(user::Column::Id).do_nothing().to_owned())
                .exec_without_returning(db)
                .await?;
        }

        Ok(())
    }

    /// 获取所有设置
    pub async fn get_all_settings(db: &DatabaseConnection) -> Result<user::Model, DbErr> {
        Self::ensure_user_exists(db).await?;

        User::find_by_id(1)
            .one(db)
            .await?
            .ok_or(DbErr::RecordNotFound("User record not found".to_string()))
    }

    /// 批量更新设置
    pub async fn update_settings(
        db: &DatabaseConnection,
        data: UpdateSettingsData,
    ) -> Result<(), DbErr> {
        db.transaction::<_, _, DbErr>(|transaction| {
            Box::pin(async move {
                let existing_user = User::find_by_id(1).one(transaction).await?;

                let has_le_path = data
                    .le_path
                    .as_ref()
                    .map(Option::as_deref)
                    .unwrap_or_else(|| {
                        existing_user
                            .as_ref()
                            .and_then(|user| user.le_path.as_deref())
                    })
                    .is_some();
                let has_magpie_path = data
                    .magpie_path
                    .as_ref()
                    .map(Option::as_deref)
                    .unwrap_or_else(|| {
                        existing_user
                            .as_ref()
                            .and_then(|user| user.magpie_path.as_deref())
                    })
                    .is_some();

                let default_le_launch = Self::resolve_tool_default(
                    existing_user
                        .as_ref()
                        .is_some_and(|user| user.default_le_launch),
                    data.default_le_launch,
                    has_le_path,
                    "请先设置 LE 转区软件路径",
                )?;
                let default_magpie = Self::resolve_tool_default(
                    existing_user
                        .as_ref()
                        .is_some_and(|user| user.default_magpie),
                    data.default_magpie,
                    has_magpie_path,
                    "请先设置 Magpie 软件路径",
                )?;

                let user = match existing_user {
                    Some(user) => user,
                    None => {
                        Self::ensure_user_exists(transaction).await?;
                        User::find_by_id(1)
                            .one(transaction)
                            .await?
                            .ok_or(DbErr::RecordNotFound("User record not found".to_string()))?
                    }
                };

                let mut active: user::ActiveModel = user.into();
                active.default_le_launch = Set(default_le_launch);
                active.default_magpie = Set(default_magpie);

                if let Some(auth) = data.bgm_auth {
                    active.bgm_auth = Set(auth);
                }

                if let Some(auth) = data.hikarinagi_auth {
                    active.hikarinagi_auth = Set(auth);
                }

                if let Some(auth) = data.kungal_auth {
                    active.kungal_auth = Set(auth);
                }

                if let Some(token) = data.vndb_token {
                    active.vndb_token = Set(token);
                }

                if let Some(path) = data.save_root_path {
                    active.save_root_path = Set(path);
                }

                if let Some(path) = data.db_backup_path {
                    active.db_backup_path = Set(path);
                }

                if let Some(path) = data.le_path {
                    active.le_path = Set(path);
                }

                if let Some(path) = data.magpie_path {
                    active.magpie_path = Set(path);
                }

                if let Some(path) = data.detail_backdrop_path {
                    active.detail_backdrop_path = Set(path);
                }

                active.update(transaction).await?;
                Ok(())
            })
        })
        .await
        .map_err(|error| match error {
            TransactionError::Connection(error) | TransactionError::Transaction(error) => error,
        })
    }

    async fn update_provider_auth_if_current(
        db: &DatabaseConnection,
        auth_column: user::Column,
        patch: user::ActiveModel,
        expected_access_token: &str,
        refresh_token_condition: RefreshTokenCondition<'_>,
    ) -> Result<bool, DbErr> {
        let auth_column = auth_column.to_string();
        let access_token_match = Expr::cust_with_values(
            format!("json_extract({auth_column}, '$.access_token') = ?"),
            [expected_access_token],
        );
        let refresh_token_match = match refresh_token_condition {
            RefreshTokenCondition::Equals(token) => Expr::cust_with_values(
                format!("json_extract({auth_column}, '$.refresh_token') = ?"),
                [token],
            ),
            RefreshTokenCondition::Is(token) => Expr::cust_with_values(
                format!("json_extract({auth_column}, '$.refresh_token') IS ?"),
                [token],
            ),
        };

        let result = User::update_many()
            .set(patch)
            .filter(user::Column::Id.eq(1))
            .filter(access_token_match)
            .filter(refresh_token_match)
            .exec(db)
            .await?;

        Ok(result.rows_affected == 1)
    }

    /// Replace BGM credentials only while the supplied token pair remains current.
    pub async fn replace_bgm_auth_if_tokens_match(
        db: &DatabaseConnection,
        expected_access_token: &str,
        expected_refresh_token: &str,
        replacement: Option<user::BgmAuth>,
    ) -> Result<bool, DbErr> {
        let mut patch = <user::ActiveModel as std::default::Default>::default();
        patch.bgm_auth = Set(replacement);

        Self::update_provider_auth_if_current(
            db,
            user::Column::BgmAuth,
            patch,
            expected_access_token,
            RefreshTokenCondition::Equals(expected_refresh_token),
        )
        .await
    }

    /// Replace Hikarinagi credentials only while the supplied token pair remains current.
    pub async fn replace_hikarinagi_auth_if_tokens_match(
        db: &DatabaseConnection,
        expected_access_token: &str,
        expected_refresh_token: &str,
        replacement: Option<user::HikarinagiAuth>,
    ) -> Result<bool, DbErr> {
        let mut patch = <user::ActiveModel as std::default::Default>::default();
        patch.hikarinagi_auth = Set(replacement);

        Self::update_provider_auth_if_current(
            db,
            user::Column::HikarinagiAuth,
            patch,
            expected_access_token,
            RefreshTokenCondition::Equals(expected_refresh_token),
        )
        .await
    }

    /// Replace KunGal credentials only while the supplied token pair remains current.
    pub async fn replace_kungal_auth_if_tokens_match(
        db: &DatabaseConnection,
        expected_access_token: &str,
        expected_refresh_token: &str,
        replacement: Option<user::KungalAuth>,
    ) -> Result<bool, DbErr> {
        let mut patch = <user::ActiveModel as std::default::Default>::default();
        patch.kungal_auth = Set(replacement);

        Self::update_provider_auth_if_current(
            db,
            user::Column::KungalAuth,
            patch,
            expected_access_token,
            RefreshTokenCondition::Equals(expected_refresh_token),
        )
        .await
    }

    /// Clear BGM credentials only while the supplied token credentials remain current.
    pub async fn clear_bgm_auth_if_tokens_match(
        db: &DatabaseConnection,
        expected_access_token: &str,
        expected_refresh_token: Option<&str>,
    ) -> Result<bool, DbErr> {
        let mut patch = <user::ActiveModel as std::default::Default>::default();
        patch.bgm_auth = Set(None);

        Self::update_provider_auth_if_current(
            db,
            user::Column::BgmAuth,
            patch,
            expected_access_token,
            RefreshTokenCondition::Is(expected_refresh_token),
        )
        .await
    }

    /// Clear Hikarinagi credentials only while the supplied token credentials remain current.
    pub async fn clear_hikarinagi_auth_if_tokens_match(
        db: &DatabaseConnection,
        expected_access_token: &str,
        expected_refresh_token: Option<&str>,
    ) -> Result<bool, DbErr> {
        let mut patch = <user::ActiveModel as std::default::Default>::default();
        patch.hikarinagi_auth = Set(None);

        Self::update_provider_auth_if_current(
            db,
            user::Column::HikarinagiAuth,
            patch,
            expected_access_token,
            RefreshTokenCondition::Is(expected_refresh_token),
        )
        .await
    }

    /// Clear KunGal credentials only while the supplied token credentials remain current.
    pub async fn clear_kungal_auth_if_tokens_match(
        db: &DatabaseConnection,
        expected_access_token: &str,
        expected_refresh_token: Option<&str>,
    ) -> Result<bool, DbErr> {
        let mut patch = <user::ActiveModel as std::default::Default>::default();
        patch.kungal_auth = Set(None);

        Self::update_provider_auth_if_current(
            db,
            user::Column::KungalAuth,
            patch,
            expected_access_token,
            RefreshTokenCondition::Is(expected_refresh_token),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::SettingsRepository;
    use crate::database::dto::UpdateSettingsData;
    use crate::entity::prelude::*;
    use crate::entity::user::{self, BgmAuth, HikarinagiAuth, KungalAuth};
    use sea_orm::{
        ActiveModelTrait, ConnectionTrait, Database, DatabaseConnection, EntityTrait, Set,
    };

    async fn empty_settings_database() -> DatabaseConnection {
        let db = Database::connect("sqlite::memory:")
            .await
            .expect("内存数据库应连接成功");
        db.execute_unprepared(
            r#"CREATE TABLE user (
                id INTEGER PRIMARY KEY,
                bgm_auth TEXT,
                hikarinagi_auth TEXT,
                kungal_auth TEXT,
                vndb_token TEXT,
                save_root_path TEXT,
                db_backup_path TEXT,
                le_path TEXT,
                magpie_path TEXT,
                detail_backdrop_path TEXT,
                default_le_launch BOOLEAN NOT NULL DEFAULT 0,
                default_magpie BOOLEAN NOT NULL DEFAULT 0
            )"#,
        )
        .await
        .expect("应创建最小设置表");
        db
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_first_reads_create_the_settings_singleton_once() {
        let db = empty_settings_database().await;
        let reads = (0..32)
            .map(|_| {
                let db = db.clone();
                tokio::spawn(async move { SettingsRepository::get_all_settings(&db).await })
            })
            .collect::<Vec<_>>();

        for read in reads {
            let settings = read
                .await
                .expect("设置读取任务应完成")
                .expect("并发首次设置读取都应成功");
            assert_eq!(settings.id, 1);
            assert!(!settings.default_le_launch);
            assert!(!settings.default_magpie);
        }

        assert_eq!(
            User::find().all(&db).await.expect("用户查询应成功").len(),
            1
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_settings_patches_keep_tool_defaults_consistent_with_paths() {
        const ROUNDS: usize = 8;
        const UNRELATED_PATCHES: usize = 32;

        for round in 0..ROUNDS {
            let db = settings_database(Some("C:/LE.exe"), Some("C:/Magpie.exe"), true, true).await;
            let start = std::sync::Arc::new(tokio::sync::Barrier::new(UNRELATED_PATCHES + 3));

            let clear_le = {
                let db = db.clone();
                let start = start.clone();
                tokio::spawn(async move {
                    start.wait().await;
                    SettingsRepository::update_settings(
                        &db,
                        UpdateSettingsData {
                            le_path: Some(None),
                            ..Default::default()
                        },
                    )
                    .await
                })
            };
            let clear_magpie = {
                let db = db.clone();
                let start = start.clone();
                tokio::spawn(async move {
                    start.wait().await;
                    SettingsRepository::update_settings(
                        &db,
                        UpdateSettingsData {
                            magpie_path: Some(None),
                            ..Default::default()
                        },
                    )
                    .await
                })
            };
            let token_updates = (0..UNRELATED_PATCHES)
                .map(|patch| {
                    let db = db.clone();
                    let start = start.clone();
                    tokio::spawn(async move {
                        start.wait().await;
                        SettingsRepository::update_settings(
                            &db,
                            UpdateSettingsData {
                                vndb_token: Some(Some(format!("token-{round}-{patch}"))),
                                ..Default::default()
                            },
                        )
                        .await
                    })
                })
                .collect::<Vec<_>>();

            start.wait().await;
            clear_le
                .await
                .expect("LE 路径更新任务应完成")
                .expect("LE 路径更新应成功");
            clear_magpie
                .await
                .expect("Magpie 路径更新任务应完成")
                .expect("Magpie 路径更新应成功");
            for update in token_updates {
                update
                    .await
                    .expect("令牌更新任务应完成")
                    .expect("令牌更新应成功");
            }

            let saved = User::find_by_id(1)
                .one(&db)
                .await
                .expect("设置查询应成功")
                .expect("设置记录应存在");
            assert!(saved.le_path.is_none());
            assert!(
                !saved.default_le_launch,
                "LE default stayed enabled in round {round}"
            );
            assert!(saved.magpie_path.is_none());
            assert!(
                !saved.default_magpie,
                "Magpie default stayed enabled in round {round}"
            );
        }
    }

    async fn settings_database(
        le_path: Option<&str>,
        magpie_path: Option<&str>,
        default_le_launch: bool,
        default_magpie: bool,
    ) -> DatabaseConnection {
        let db = empty_settings_database().await;
        user::ActiveModel {
            id: Set(1),
            bgm_auth: Set(None),
            hikarinagi_auth: Set(None),
            kungal_auth: Set(None),
            vndb_token: Set(None),
            save_root_path: Set(None),
            db_backup_path: Set(None),
            le_path: Set(le_path.map(str::to_string)),
            magpie_path: Set(magpie_path.map(str::to_string)),
            detail_backdrop_path: Set(None),
            default_le_launch: Set(default_le_launch),
            default_magpie: Set(default_magpie),
        }
        .insert(&db)
        .await
        .expect("应建立设置记录");
        db
    }

    #[test]
    fn tool_default_requires_a_path_only_when_enabling() {
        assert_eq!(
            SettingsRepository::resolve_tool_default(false, None, false, "missing path")
                .expect("缺路径时应保持关闭"),
            false
        );
        assert_eq!(
            SettingsRepository::resolve_tool_default(true, None, true, "missing path")
                .expect("未提交开关时应保留已有状态"),
            true
        );
        assert_eq!(
            SettingsRepository::resolve_tool_default(false, Some(false), true, "missing path")
                .expect("明确关闭应生效"),
            false
        );
        assert_eq!(
            SettingsRepository::resolve_tool_default(false, Some(true), true, "missing path")
                .expect("路径已配置时允许启用"),
            true
        );
        assert!(
            SettingsRepository::resolve_tool_default(false, Some(true), false, "missing path")
                .is_err()
        );
    }

    #[tokio::test]
    async fn clearing_a_tool_path_clears_its_default_enabled_state() {
        let db = settings_database(Some("C:/LE.exe"), Some("C:/Magpie.exe"), true, true).await;

        SettingsRepository::update_settings(
            &db,
            UpdateSettingsData {
                le_path: Some(None),
                ..Default::default()
            },
        )
        .await
        .expect("清除 LE 路径应同步关闭默认启动");

        let saved = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置记录应存在");
        assert_eq!(saved.le_path, None);
        assert!(!saved.default_le_launch);
        assert_eq!(saved.magpie_path.as_deref(), Some("C:/Magpie.exe"));
        assert!(saved.default_magpie);
    }

    #[tokio::test]
    async fn enabling_a_tool_without_a_path_preserves_the_existing_settings() {
        let db = settings_database(None, Some("C:/Magpie.exe"), false, false).await;

        let result = SettingsRepository::update_settings(
            &db,
            UpdateSettingsData {
                default_le_launch: Some(true),
                ..Default::default()
            },
        )
        .await;

        assert!(
            matches!(result, Err(sea_orm::DbErr::Custom(message)) if message == "请先设置 LE 转区软件路径")
        );
        let saved = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置记录应存在");
        assert_eq!(saved.le_path, None);
        assert!(!saved.default_le_launch);
        assert_eq!(saved.magpie_path.as_deref(), Some("C:/Magpie.exe"));
        assert!(!saved.default_magpie);
    }

    #[tokio::test]
    async fn invalid_tool_default_does_not_create_the_first_user_record() {
        let invalid_updates = [
            (
                UpdateSettingsData {
                    default_le_launch: Some(true),
                    ..Default::default()
                },
                "请先设置 LE 转区软件路径",
            ),
            (
                UpdateSettingsData {
                    default_magpie: Some(true),
                    ..Default::default()
                },
                "请先设置 Magpie 软件路径",
            ),
        ];

        for (update, expected_message) in invalid_updates {
            let db = empty_settings_database().await;
            let result = SettingsRepository::update_settings(&db, update).await;

            assert!(matches!(
                result,
                Err(sea_orm::DbErr::Custom(message)) if message == expected_message
            ));
            assert!(
                User::find_by_id(1)
                    .one(&db)
                    .await
                    .expect("设置查询应成功")
                    .is_none()
            );
        }
    }

    #[tokio::test]
    async fn valid_update_creates_the_first_user_record_after_validation() {
        let db = empty_settings_database().await;

        SettingsRepository::update_settings(
            &db,
            UpdateSettingsData {
                vndb_token: Some(Some("token".to_string())),
                ..Default::default()
            },
        )
        .await
        .expect("有效设置补丁仍应初始化用户记录");

        let saved = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置记录应存在");
        assert_eq!(saved.vndb_token.as_deref(), Some("token"));
        assert!(!saved.default_le_launch);
        assert!(!saved.default_magpie);
    }

    #[tokio::test]
    async fn oauth_refresh_replaces_only_the_matching_token_pair() {
        let db = settings_database(None, None, false, false).await;
        let expected_bgm = BgmAuth {
            access_token: "bgm-access-old".to_string(),
            refresh_token: Some("bgm-refresh-old".to_string()),
            ..Default::default()
        };
        let next_bgm = BgmAuth {
            access_token: "bgm-access-new".to_string(),
            refresh_token: Some("bgm-refresh-new".to_string()),
            ..Default::default()
        };
        let expected_hikarinagi = HikarinagiAuth {
            access_token: "hika-access-old".to_string(),
            refresh_token: Some("hika-refresh-old".to_string()),
            ..Default::default()
        };
        let next_hikarinagi = HikarinagiAuth {
            access_token: "hika-access-new".to_string(),
            refresh_token: Some("hika-refresh-new".to_string()),
            ..Default::default()
        };
        let expected_kungal = KungalAuth {
            access_token: "kungal-access-old".to_string(),
            refresh_token: Some("kungal-refresh-old".to_string()),
            ..Default::default()
        };
        let next_kungal = KungalAuth {
            access_token: "kungal-access-new".to_string(),
            refresh_token: Some("kungal-refresh-new".to_string()),
            ..Default::default()
        };

        let saved = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置记录应存在");
        let mut active: user::ActiveModel = saved.into();
        active.bgm_auth = Set(Some(expected_bgm.clone()));
        active.hikarinagi_auth = Set(Some(expected_hikarinagi.clone()));
        active.kungal_auth = Set(Some(expected_kungal.clone()));
        active.update(&db).await.expect("应写入授权测试数据");

        assert!(
            SettingsRepository::replace_bgm_auth_if_tokens_match(
                &db,
                "bgm-access-old",
                "bgm-refresh-old",
                Some(next_bgm.clone()),
            )
            .await
            .expect("BGM CAS 应成功")
        );
        assert!(
            SettingsRepository::replace_hikarinagi_auth_if_tokens_match(
                &db,
                "hika-access-old",
                "hika-refresh-old",
                Some(next_hikarinagi.clone()),
            )
            .await
            .expect("Hikarinagi CAS 应成功")
        );
        assert!(
            SettingsRepository::replace_kungal_auth_if_tokens_match(
                &db,
                "kungal-access-old",
                "kungal-refresh-old",
                Some(next_kungal.clone()),
            )
            .await
            .expect("KunGal CAS 应成功")
        );

        assert!(
            !SettingsRepository::replace_bgm_auth_if_tokens_match(
                &db,
                "bgm-access-old",
                "bgm-refresh-old",
                Some(expected_bgm.clone()),
            )
            .await
            .expect("过期 BGM CAS 应返回冲突")
        );
        assert!(
            !SettingsRepository::replace_hikarinagi_auth_if_tokens_match(
                &db,
                "hika-access-old",
                "hika-refresh-old",
                Some(expected_hikarinagi.clone()),
            )
            .await
            .expect("过期 Hikarinagi CAS 应返回冲突")
        );
        assert!(
            !SettingsRepository::replace_kungal_auth_if_tokens_match(
                &db,
                "kungal-access-old",
                "kungal-refresh-old",
                Some(expected_kungal.clone()),
            )
            .await
            .expect("过期 KunGal CAS 应返回冲突")
        );

        let saved = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置记录应存在");
        assert_eq!(saved.bgm_auth, Some(next_bgm));
        assert_eq!(saved.hikarinagi_auth, Some(next_hikarinagi));
        assert_eq!(saved.kungal_auth, Some(next_kungal));
    }

    #[tokio::test]
    async fn stale_oauth_tokens_cannot_clear_replaced_credentials() {
        let db = settings_database(None, None, false, false).await;
        let bgm_auth = BgmAuth {
            access_token: "current-access".to_string(),
            refresh_token: Some("current-refresh".to_string()),
            ..Default::default()
        };
        let hikarinagi_auth = HikarinagiAuth {
            access_token: "hika-current-access".to_string(),
            refresh_token: Some("hika-current-refresh".to_string()),
            ..Default::default()
        };
        let kungal_auth = KungalAuth {
            access_token: "kungal-current-access".to_string(),
            refresh_token: Some("kungal-current-refresh".to_string()),
            ..Default::default()
        };
        let saved = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置记录应存在");
        let mut active: user::ActiveModel = saved.into();
        active.bgm_auth = Set(Some(bgm_auth.clone()));
        active.hikarinagi_auth = Set(Some(hikarinagi_auth.clone()));
        active.kungal_auth = Set(Some(kungal_auth.clone()));
        active.update(&db).await.expect("应写入授权测试数据");

        assert!(
            !SettingsRepository::clear_bgm_auth_if_tokens_match(
                &db,
                "stale-access",
                Some("current-refresh"),
            )
            .await
            .expect("过期 access token 应返回冲突")
        );
        assert!(
            !SettingsRepository::clear_bgm_auth_if_tokens_match(
                &db,
                "current-access",
                Some("stale-refresh"),
            )
            .await
            .expect("过期 refresh token 应返回冲突")
        );
        assert!(
            !SettingsRepository::clear_bgm_auth_if_tokens_match(&db, "current-access", None)
                .await
                .expect("缺失 refresh token 不能匹配当前 refresh token")
        );
        assert!(
            !SettingsRepository::clear_hikarinagi_auth_if_tokens_match(
                &db,
                "hika-stale-access",
                Some("hika-current-refresh"),
            )
            .await
            .expect("过期 Hikarinagi token 应返回冲突")
        );
        assert!(
            !SettingsRepository::clear_hikarinagi_auth_if_tokens_match(
                &db,
                "hika-current-access",
                None,
            )
            .await
            .expect("缺失 refresh token 不能匹配当前 Hikarinagi refresh token")
        );
        assert!(
            !SettingsRepository::clear_kungal_auth_if_tokens_match(
                &db,
                "kungal-current-access",
                Some("kungal-stale-refresh"),
            )
            .await
            .expect("过期 KunGal token 应返回冲突")
        );
        assert!(
            !SettingsRepository::clear_kungal_auth_if_tokens_match(
                &db,
                "kungal-current-access",
                None,
            )
            .await
            .expect("缺失 refresh token 不能匹配当前 KunGal refresh token")
        );

        let saved = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置记录应存在");
        assert_eq!(saved.bgm_auth, Some(bgm_auth));
        assert_eq!(saved.hikarinagi_auth, Some(hikarinagi_auth));
        assert_eq!(saved.kungal_auth, Some(kungal_auth));

        assert!(
            SettingsRepository::clear_bgm_auth_if_tokens_match(
                &db,
                "current-access",
                Some("current-refresh"),
            )
            .await
            .expect("当前 token 应允许清理")
        );
        assert!(
            SettingsRepository::clear_hikarinagi_auth_if_tokens_match(
                &db,
                "hika-current-access",
                Some("hika-current-refresh"),
            )
            .await
            .expect("当前 Hikarinagi token 应允许清理")
        );
        assert!(
            SettingsRepository::clear_kungal_auth_if_tokens_match(
                &db,
                "kungal-current-access",
                Some("kungal-current-refresh"),
            )
            .await
            .expect("当前 KunGal token 应允许清理")
        );
        assert_eq!(
            User::find_by_id(1)
                .one(&db)
                .await
                .expect("设置查询应成功")
                .and_then(|settings| settings.bgm_auth),
            None
        );
        let saved = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置记录应存在");
        assert_eq!(saved.hikarinagi_auth, None);
        assert_eq!(saved.kungal_auth, None);

        let mut active: user::ActiveModel = saved.into();
        active.hikarinagi_auth = Set(Some(HikarinagiAuth {
            access_token: "hika-access-without-refresh".to_string(),
            ..Default::default()
        }));
        active.kungal_auth = Set(Some(KungalAuth {
            access_token: "kungal-access-without-refresh".to_string(),
            ..Default::default()
        }));
        active
            .update(&db)
            .await
            .expect("应写入没有 refresh token 的授权");

        assert!(
            SettingsRepository::clear_hikarinagi_auth_if_tokens_match(
                &db,
                "hika-access-without-refresh",
                None,
            )
            .await
            .expect("缺少 Hikarinagi refresh token 时应按空值匹配清理")
        );
        assert!(
            SettingsRepository::clear_kungal_auth_if_tokens_match(
                &db,
                "kungal-access-without-refresh",
                None,
            )
            .await
            .expect("缺少 KunGal refresh token 时应按空值匹配清理")
        );

        let saved = User::find_by_id(1)
            .one(&db)
            .await
            .expect("设置查询应成功")
            .expect("设置记录应存在");
        assert_eq!(saved.hikarinagi_auth, None);
        assert_eq!(saved.kungal_auth, None);

        let mut active: user::ActiveModel = saved.into();
        active.bgm_auth = Set(Some(BgmAuth {
            access_token: "manual-access-without-refresh".to_string(),
            ..Default::default()
        }));
        active
            .update(&db)
            .await
            .expect("应写入没有 refresh token 的手动授权");
        assert!(
            SettingsRepository::clear_bgm_auth_if_tokens_match(
                &db,
                "manual-access-without-refresh",
                None,
            )
            .await
            .expect("当前缺少 refresh token 时允许按空值匹配清理")
        );
    }

    #[tokio::test]
    async fn oauth_refresh_accepts_legacy_auth_json_without_optional_fields() {
        let db = settings_database(None, None, false, false).await;
        db.execute_unprepared(
            r#"UPDATE user SET bgm_auth = '{"access_token":"legacy-access","refresh_token":"legacy-refresh"}' WHERE id = 1"#,
        )
        .await
        .expect("应写入缺少可选字段的旧版授权 JSON");

        let refreshed = BgmAuth {
            access_token: "refreshed-access".to_string(),
            refresh_token: Some("refreshed-refresh".to_string()),
            ..Default::default()
        };
        assert!(
            SettingsRepository::replace_bgm_auth_if_tokens_match(
                &db,
                "legacy-access",
                "legacy-refresh",
                Some(refreshed.clone()),
            )
            .await
            .expect("旧版 JSON 的授权信息应能按 token 条件更新")
        );
        assert_eq!(
            User::find_by_id(1)
                .one(&db)
                .await
                .expect("设置查询应成功")
                .and_then(|settings| settings.bgm_auth),
            Some(refreshed)
        );
    }
}
