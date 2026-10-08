use crate::database::dto::UpdateSettingsData;
use crate::entity::prelude::*;
use crate::entity::user;
use crate::entity::user::Model;
use crate::utils::fs::normalize_install_root_path;
use sea_orm::*;

/// 用户设置仓库
pub struct SettingsRepository;

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
    /// 确保用户记录存在（ID 固定为 1）
    async fn ensure_user_exists(db: &DatabaseConnection) -> Result<(), DbErr> {
        let existing = User::find_by_id(1).one(db).await?;

        if existing.is_none() {
            let user = user::ActiveModel {
                id: Set(1),
                bgm_auth: Set(None),
                hikarinagi_auth: Set(None),
                vndb_token: Set(None),
                save_root_path: Set(None),
                db_backup_path: Set(None),
                install_root_path: Set(None),
                le_path: Set(None),
                magpie_path: Set(None),
                detail_backdrop_path: Set(None),
                  default_le_launch: Set(false),
                  default_magpie: Set(false),
            };

            user.insert(db).await?;
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
        let data = data.cleaned(); // 清洗空字符串

        Self::ensure_user_exists(db).await?;

        let user = User::find_by_id(1)
            .one(db)
            .await?
            .ok_or(DbErr::RecordNotFound("User record not found".to_string()))?;

        let has_le_path = data
            .le_path
            .as_ref()
            .map(Option::as_deref)
            .unwrap_or(user.le_path.as_deref())
            .is_some();
        let has_magpie_path = data
            .magpie_path
            .as_ref()
            .map(Option::as_deref)
            .unwrap_or(user.magpie_path.as_deref())
            .is_some();

        if data.default_le_launch == Some(true) && !has_le_path {
            return Err(DbErr::Custom("请先设置 LE 转区软件路径".to_string()));
        }
        if data.default_magpie == Some(true) && !has_magpie_path {
            return Err(DbErr::Custom("请先设置 Magpie 软件路径".to_string()));
        }

        let mut active: user::ActiveModel = user.into();

        if !has_le_path {
            active.default_le_launch = Set(false);
        } else if let Some(enabled) = data.default_le_launch {
            active.default_le_launch = Set(enabled);
        }

        if !has_magpie_path {
            active.default_magpie = Set(false);
        } else if let Some(enabled) = data.default_magpie {
            active.default_magpie = Set(enabled);
        }

        if let Some(auth) = data.bgm_auth {
            active.bgm_auth = Set(auth);
        }

        if let Some(auth) = data.hikarinagi_auth {
            active.hikarinagi_auth = Set(auth);
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

        if let Some(path) = data.install_root_path {
            let path = path
                .map(|path| {
                    normalize_install_root_path(&path)
                        .map(|path| path.to_string_lossy().into_owned())
                })
                .transpose()
                .map_err(DbErr::Custom)?;
            active.install_root_path = Set(path);
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

        active.update(db).await?;
        Ok(())
    }
}
