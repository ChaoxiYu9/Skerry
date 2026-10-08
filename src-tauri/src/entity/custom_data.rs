//! 自定义元数据 JSON 结构体
//!
//! 此文件定义了存储在 games.custom_data 列中的 JSON 数据结构。
//! 用于替代原有的 other_data 表和 custom_name/custom_cover 字段。

use sea_orm::FromJsonQueryResult;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 外部数据源类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
    Bgm,
    Vndb,
    Ymgal,
    Kun,
    Hikarinagi,
    Dlsite,
    Erogamescape,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameStaffRole {
    Writer,
    Artist,
    Composer,
    Director,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameStaffMember {
    pub id: i32,
    pub name: String,
    pub roles: Vec<GameStaffRole>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BannerFocus {
    pub x: f64,
    pub y: f64,
}

/// 自定义元数据结构（存储为 JSON）
///
/// 用于用户自定义的游戏数据，包括：
/// - 手动添加的游戏
/// - 从 Whitecloud 等其他来源导入的游戏
/// - 用户自定义的名称和封面
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClearRecord {
    pub id: String,
    pub round: i32,
    pub date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// 自定义元数据结构（存储为 JSON）
///
/// 包含用户自定义的游戏数据，例如：
/// - 手动添加的游戏
/// - 从 Whitecloud 等额外数据源导入的游戏
/// - 用户自定义的名称和封面
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default, FromJsonQueryResult)]
#[serde(default)]
pub struct CustomData {
    /// 自定义封面图片路径或 URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,

    /// PotatoVN-style banner image identifier stored in the game media folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<String>,

    /// Detail-page-only backdrop identifier; cards and home still prefer banner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_backdrop: Option<String>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner_focus: Option<BannerFocus>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail_backdrop_focus: Option<BannerFocus>,

    /// Mixed 模式下选定的封面数据源
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_source: Option<SourceType>,

    /// 自定义名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// 自定义中文名称
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_cn: Option<String>,

    /// 自定义译名
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translated_name: Option<String>,

    /// 别名列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,

    /// 简介/摘要
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,

    /// 标签列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,

    /// 开发商
    #[serde(skip_serializing_if = "Option::is_none")]
    pub developer: Option<String>,

    /// 是否为成人内容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nsfw: Option<bool>,

    /// 用户个人评分，范围 0-10，0 表示清空评分
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_rating: Option<f64>,

    /// 用户个人评价
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_review: Option<String>,

    /// 制作人员，仅包含剧本、原画、音乐和监督。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staff: Option<Vec<GameStaffMember>>,

    /// 是否已由用户手动覆盖制作人员；用于区分“未导入”和“明确清空”。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staff_overridden: Option<bool>,

    /// Whether the normal launch action should start this local game as administrator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_as_admin: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub cgs: Option<Vec<String>>,

    /// Online screenshot URLs already copied into local CG storage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_screenshot_urls: Option<Vec<String>>,

    /// Maps online screenshot URLs to their saved local CG identifiers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_screenshot_map: Option<BTreeMap<String, String>>,

    /// Source screenshot URLs hidden from the detail-page gallery.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden_source_screenshots: Option<Vec<String>>,

    /// 通关历程记录（支持多周目与准确日期）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear_records: Option<Vec<ClearRecord>>,
}
