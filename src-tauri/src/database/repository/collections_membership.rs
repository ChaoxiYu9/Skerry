use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct MembershipLink {
    pub(super) link_id: i32,
    pub(super) game_id: i32,
    pub(super) collection_id: i32,
    pub(super) sort_order: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct GameCollectionPair {
    pub(super) game_id: i32,
    pub(super) collection_id: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct GameCollectionInsert {
    pub(super) game_id: i32,
    pub(super) collection_id: i32,
    pub(super) sort_order: i32,
}

pub(super) struct GameCollectionDiff {
    pub(super) to_insert: Vec<GameCollectionPair>,
    pub(super) to_delete_link_ids: Vec<i32>,
}

pub(super) struct CategoryGamesDiff {
    pub(super) to_delete_link_ids: Vec<i32>,
    pub(super) to_insert: Vec<GameCollectionInsert>,
    pub(super) to_update_sort_orders: Vec<(i32, i32)>,
}

pub(super) struct MembershipRequest {
    pub(super) game_ids: Vec<i32>,
    pub(super) collection_ids: Vec<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MembershipPlanError {
    SortOrderOutOfRange,
}

pub(super) fn unique_ids_in_order(mut ids: Vec<i32>) -> Vec<i32> {
    let mut seen = HashSet::with_capacity(ids.len());
    ids.retain(|id| seen.insert(*id));
    ids
}

pub(super) fn plan_membership_request(
    game_ids: Vec<i32>,
    collection_ids: Vec<i32>,
) -> MembershipRequest {
    MembershipRequest {
        game_ids: unique_ids_in_order(game_ids),
        collection_ids: unique_ids_in_order(collection_ids),
    }
}

/// Membership identity is the stored (game, collection) pair. Target sets decide
/// removals independently of insertion order, so surviving rows keep their IDs.
pub(super) fn diff_membership_request(
    current_links: &[MembershipLink],
    request: &MembershipRequest,
) -> GameCollectionDiff {
    let target_games: HashSet<_> = request.game_ids.iter().copied().collect();
    let target_collections: HashSet<_> = request.collection_ids.iter().copied().collect();
    let existing: HashSet<_> = current_links
        .iter()
        .map(|link| (link.game_id, link.collection_id))
        .collect();
    let to_delete_link_ids = current_links
        .iter()
        .filter(|link| {
            !target_games.contains(&link.game_id)
                || !target_collections.contains(&link.collection_id)
        })
        .map(|link| link.link_id)
        .collect();
    let mut to_insert = Vec::new();
    for collection_id in &request.collection_ids {
        for game_id in &request.game_ids {
            if !existing.contains(&(*game_id, *collection_id)) {
                to_insert.push(GameCollectionPair {
                    game_id: *game_id,
                    collection_id: *collection_id,
                });
            }
        }
    }
    GameCollectionDiff {
        to_insert,
        to_delete_link_ids,
    }
}

fn sort_order_from_position(position: usize) -> Result<i32, MembershipPlanError> {
    i32::try_from(position).map_err(|_| MembershipPlanError::SortOrderOutOfRange)
}

/// Build the desired order first, then compare each surviving database row with
/// its target position. Existing rows are updated in place, never reinserted.
pub(super) fn build_category_games_diff(
    current_links: &[MembershipLink],
    new_game_ids: Vec<i32>,
    collection_id: i32,
) -> Result<CategoryGamesDiff, MembershipPlanError> {
    let targets = unique_ids_in_order(new_game_ids)
        .into_iter()
        .enumerate()
        .map(|(position, game_id)| Ok((game_id, sort_order_from_position(position)?)))
        .collect::<Result<Vec<_>, MembershipPlanError>>()?;
    let desired_positions: HashMap<_, _> = targets.iter().copied().collect();
    let existing_games: HashSet<_> = current_links.iter().map(|link| link.game_id).collect();
    let to_delete_link_ids = current_links
        .iter()
        .filter(|link| !desired_positions.contains_key(&link.game_id))
        .map(|link| link.link_id)
        .collect();
    let to_insert = targets
        .iter()
        .filter(|(game_id, _)| !existing_games.contains(game_id))
        .map(|(game_id, sort_order)| GameCollectionInsert {
            game_id: *game_id,
            collection_id,
            sort_order: *sort_order,
        })
        .collect();
    let mut to_update_sort_orders = current_links
        .iter()
        .filter_map(|link| {
            let order = *desired_positions.get(&link.game_id)?;
            (order != link.sort_order).then_some((link.link_id, order))
        })
        .collect::<Vec<_>>();
    to_update_sort_orders.sort_unstable_by_key(|(_, order)| *order);
    Ok(CategoryGamesDiff {
        to_delete_link_ids,
        to_insert,
        to_update_sort_orders,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        GameCollectionPair, MembershipLink, build_category_games_diff, diff_membership_request,
        plan_membership_request, unique_ids_in_order,
    };

    fn link(link_id: i32, game_id: i32, collection_id: i32, sort_order: i32) -> MembershipLink {
        MembershipLink {
            link_id,
            game_id,
            collection_id,
            sort_order,
        }
    }

    #[test]
    fn input_ids_keep_first_seen_order() {
        assert_eq!(unique_ids_in_order(vec![7, 3, 7, 4, 3]), [7, 3, 4]);
    }

    #[test]
    fn multi_collection_requests_expand_in_collection_then_game_order() {
        let plan = plan_membership_request(vec![7, 3, 7], vec![5, 2, 5]);

        assert_eq!(plan.game_ids, [7, 3]);
        assert_eq!(plan.collection_ids, [5, 2]);
        let diff = diff_membership_request(&[], &plan);
        assert_eq!(
            diff.to_insert,
            [
                GameCollectionPair {
                    game_id: 7,
                    collection_id: 5,
                },
                GameCollectionPair {
                    game_id: 3,
                    collection_id: 5,
                },
                GameCollectionPair {
                    game_id: 7,
                    collection_id: 2,
                },
                GameCollectionPair {
                    game_id: 3,
                    collection_id: 2,
                },
            ]
        );
    }

    #[test]
    fn membership_diff_inserts_missing_pairs_and_removes_only_untargeted_links() {
        let current = [link(11, 7, 5, 0), link(12, 3, 5, 1), link(13, 9, 5, 2)];
        let request = plan_membership_request(vec![7, 4], vec![5]);
        let diff = diff_membership_request(&current, &request);

        assert_eq!(diff.to_delete_link_ids, [12, 13]);
        assert_eq!(
            diff.to_insert,
            [GameCollectionPair {
                game_id: 4,
                collection_id: 5,
            }]
        );
    }

    #[test]
    fn replacing_game_memberships_keeps_existing_order_and_appends_new_pairs() {
        let current = [link(11, 7, 5, 4), link(12, 7, 2, 1)];
        let target = plan_membership_request(vec![7], vec![2, 8, 5]);
        let diff = diff_membership_request(&current, &target);

        assert!(diff.to_delete_link_ids.is_empty());
        assert_eq!(
            diff.to_insert,
            [GameCollectionPair {
                game_id: 7,
                collection_id: 8
            }]
        );
        assert!(diff.to_insert.iter().all(|pair| pair.collection_id != 2));
    }

    #[test]
    fn category_replacement_preserves_link_ids_and_sets_contiguous_first_seen_order() {
        let current = [link(11, 9, 5, 0), link(12, 7, 5, 2), link(13, 5, 5, 1)];
        let diff = build_category_games_diff(&current, vec![7, 5, 9, 10, 7], 5)
            .expect("可表示的排序位置应成功规划");

        assert!(diff.to_delete_link_ids.is_empty());
        assert_eq!(
            diff.to_insert,
            [super::GameCollectionInsert {
                game_id: 10,
                collection_id: 5,
                sort_order: 3,
            }]
        );
        assert_eq!(diff.to_update_sort_orders, [(12, 0), (11, 2)]);
    }

    #[test]
    fn empty_category_replacement_deletes_every_membership() {
        let current = [link(11, 9, 5, 0), link(12, 7, 5, 1)];
        let diff = build_category_games_diff(&current, Vec::new(), 5).expect("空列表应成功规划");

        assert_eq!(diff.to_delete_link_ids, [11, 12]);
        assert!(diff.to_insert.is_empty());
        assert!(diff.to_update_sort_orders.is_empty());
    }

    #[test]
    fn relationship_ledger_consumes_targets_once_and_keeps_delete_order() {
        let current = [link(11, 7, 5, 0), link(12, 3, 5, 1), link(13, 9, 5, 2)];
        let repeated_target = GameCollectionPair {
            game_id: 4,
            collection_id: 5,
        };
        let request = plan_membership_request(vec![7, 4, 4], vec![5]);

        let diff = diff_membership_request(&current, &request);

        assert_eq!(diff.to_delete_link_ids, [12, 13]);
        assert_eq!(diff.to_insert, [repeated_target]);
    }

    #[test]
    fn empty_membership_request_removes_all_current_links() {
        let current = [link(11, 7, 5, 0), link(12, 3, 2, 1)];
        let request = plan_membership_request(vec![7], Vec::new());

        let diff = diff_membership_request(&current, &request);

        assert_eq!(diff.to_delete_link_ids, [11, 12]);
        assert!(diff.to_insert.is_empty());
    }

    #[test]
    fn category_sort_order_rejects_positions_outside_i32_storage() {
        let last_supported_position =
            usize::try_from(i32::MAX).expect("i32 最大值应可表示为 usize");

        assert_eq!(
            super::build_category_games_diff(&[], vec![1], 5)
                .expect("普通位置应能规划")
                .to_insert[0]
                .sort_order,
            0
        );
        assert_eq!(
            super::sort_order_from_position(last_supported_position),
            Ok(i32::MAX)
        );
        assert_eq!(
            super::sort_order_from_position(last_supported_position + 1),
            Err(super::MembershipPlanError::SortOrderOutOfRange)
        );
    }
}
