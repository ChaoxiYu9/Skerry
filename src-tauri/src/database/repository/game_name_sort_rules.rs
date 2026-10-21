//! Selects the effective list name and builds one sortable key per game.

use super::game_query_rules::SortDirection;
use super::game_source_priorities::MIXED_NAME_AND_DATE_PRIORITY;
use std::cmp::Ordering;
use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub(super) struct SourceNameFields {
    pub name: Option<String>,
    pub name_cn: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(super) struct NameSortRecord {
    pub id: i32,
    pub id_type: String,
    pub custom_name: Option<String>,
    pub custom_name_cn: Option<String>,
    pub sources: HashMap<String, SourceNameFields>,
}

pub(super) fn order_game_ids_by_name(
    records: Vec<NameSortRecord>,
    use_chinese_names: bool,
    direction: SortDirection,
) -> Vec<i32> {
    let mut keys: Vec<(i32, Option<String>)> = records
        .into_iter()
        .map(|record| (record.id, name_sort_key(&record, use_chinese_names)))
        .collect();
    keys.sort_unstable_by(|(left_id, left), (right_id, right)| {
        let name_order = match (left, right) {
            (Some(left), Some(right)) => match direction {
                SortDirection::Asc => left.cmp(right),
                SortDirection::Desc => right.cmp(left),
            },
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        };
        name_order.then_with(|| left_id.cmp(right_id))
    });
    keys.into_iter().map(|(id, _)| id).collect()
}

fn name_sort_key(record: &NameSortRecord, use_chinese_names: bool) -> Option<String> {
    // The current list contract prefers a Chinese translation in every locale.
    // Locale changes only the treatment of an original name without a translation.
    let translation = non_empty(record.custom_name_cn.as_deref())
        .or_else(|| name_sources(record).find_map(|source| non_empty(source.name_cn.as_deref())));
    let (name, use_pinyin) = match translation {
        Some(name) => (name, true),
        None => (
            non_empty(record.custom_name.as_deref()).or_else(|| {
                name_sources(record).find_map(|source| non_empty(source.name.as_deref()))
            })?,
            use_chinese_names,
        ),
    };
    if !use_pinyin {
        return Some(name.to_lowercase());
    }

    use pinyin::ToPinyin;
    let mut key = String::new();
    for character in name.chars() {
        if let Some(syllable) = character.to_pinyin() {
            key.push_str(syllable.plain());
        } else {
            key.extend(character.to_lowercase());
        }
    }
    Some(key)
}

fn name_sources(record: &NameSortRecord) -> impl Iterator<Item = &SourceNameFields> {
    let primary = match record.id_type.as_str() {
        "mixed" | "custom" | "Whitecloud" => None,
        source => record.sources.get(source),
    };
    primary.into_iter().chain(
        MIXED_NAME_AND_DATE_PRIORITY
            .iter()
            .filter(move |_| primary.is_none())
            .filter_map(|source| record.sources.get(*source)),
    )
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: i32, id_type: &str) -> NameSortRecord {
        NameSortRecord {
            id,
            id_type: id_type.to_string(),
            ..Default::default()
        }
    }

    fn source_names(
        record: &mut NameSortRecord,
        source: &str,
        name: Option<&str>,
        name_cn: Option<&str>,
    ) {
        record.sources.insert(
            source.to_string(),
            SourceNameFields {
                name: name.map(str::to_string),
                name_cn: name_cn.map(str::to_string),
            },
        );
    }

    #[test]
    fn custom_chinese_name_is_the_highest_priority_in_every_locale() {
        let mut entry = record(1, "bgm");
        entry.custom_name_cn = Some("甲名".to_string());
        entry.custom_name = Some("Zulu".to_string());
        source_names(&mut entry, "bgm", Some("Zulu"), Some("乙名"));
        assert_eq!(name_sort_key(&entry, false), Some("jiaming".to_string()));
        assert_eq!(name_sort_key(&entry, true), Some("jiaming".to_string()));
    }

    #[test]
    fn selected_source_scope_does_not_fall_back_to_another_sources_translation() {
        let mut entry = record(1, "vndb");
        entry.custom_name = Some("Zeta".to_string());
        source_names(&mut entry, "vndb", Some("Omega"), None);
        source_names(&mut entry, "bgm", Some("Alpha"), Some("甲名"));

        assert_eq!(name_sort_key(&entry, false), Some("zeta".to_string()));
        assert_eq!(name_sort_key(&entry, true), Some("zeta".to_string()));
    }

    #[test]
    fn concrete_source_translation_precedes_mixed_source_priority() {
        let mut entry = record(1, "vndb");
        source_names(&mut entry, "bgm", Some("Alpha"), Some("甲名"));
        source_names(&mut entry, "vndb", Some("Zulu"), Some("乙名"));
        assert_eq!(name_sort_key(&entry, false), Some("yiming".to_string()));

        entry.id_type = "mixed".to_string();
        assert_eq!(name_sort_key(&entry, false), Some("jiaming".to_string()));
    }

    #[test]
    fn custom_original_name_precedes_source_original_name_when_no_translation_exists() {
        let mut entry = record(1, "bgm");
        entry.custom_name = Some("  Alpha  ".to_string());
        source_names(&mut entry, "bgm", Some("Zulu"), None);
        assert_eq!(name_sort_key(&entry, false), Some("alpha".to_string()));
    }

    #[test]
    fn empty_names_are_ignored_and_source_translations_precede_original_names() {
        let mut entry = record(1, "bgm");
        entry.custom_name = Some("   ".to_string());
        source_names(&mut entry, "bgm", Some("  Game  "), Some("游戏"));
        assert_eq!(name_sort_key(&entry, true), Some("youxi".to_string()));
        assert_eq!(name_sort_key(&entry, false), Some("youxi".to_string()));

        let mut original_only = record(2, "bgm");
        source_names(&mut original_only, "bgm", Some("  Game  "), None);
        assert_eq!(
            name_sort_key(&original_only, true),
            Some("game".to_string())
        );
        assert_eq!(
            name_sort_key(&original_only, false),
            Some("game".to_string())
        );
    }

    #[test]
    fn descending_reverses_named_keys_but_missing_names_remain_last_and_ties_use_id() {
        let mut zulu = record(1, "custom");
        zulu.custom_name = Some("Zulu".to_string());
        let mut alpha_later = record(3, "custom");
        alpha_later.custom_name = Some("Alpha".to_string());
        let mut alpha_earlier = record(2, "custom");
        alpha_earlier.custom_name = Some(" alpha ".to_string());
        let missing = record(4, "custom");

        assert_eq!(
            order_game_ids_by_name(
                vec![
                    zulu.clone(),
                    alpha_later.clone(),
                    alpha_earlier.clone(),
                    missing.clone()
                ],
                false,
                SortDirection::Asc,
            ),
            vec![2, 3, 1, 4]
        );
        assert_eq!(
            order_game_ids_by_name(
                vec![zulu, alpha_later, alpha_earlier, missing],
                false,
                SortDirection::Desc,
            ),
            vec![1, 2, 3, 4]
        );
    }
    #[test]
    fn absent_primary_source_uses_mixed_fallback_without_considering_unknown_sources() {
        let mut entry = record(1, "vndb");
        source_names(&mut entry, "kun", Some("Zulu"), None);
        source_names(&mut entry, "bgm", Some("Beta"), None);
        source_names(&mut entry, "unknown", Some("Alpha"), Some("甲"));
        assert_eq!(name_sort_key(&entry, false), Some("beta".to_string()));
    }

    #[test]
    fn locale_changes_original_chinese_keys_and_preserves_ascii_characters() {
        let mut entry = record(1, "custom");
        entry.custom_name = Some(" 中文A9! ".to_string());
        assert_eq!(name_sort_key(&entry, true), Some("zhongwena9!".to_string()));
        assert_eq!(name_sort_key(&entry, false), Some("中文a9!".to_string()));
    }
}
