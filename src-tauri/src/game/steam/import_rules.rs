use super::SteamLaunchTarget;
use crate::game::import_path_index::ImportPathIndex;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExistingSteamTargetReason {
    LaunchIdAlreadyLinked,
    ExistingGameInsideInstallRoot,
}

#[derive(Default)]
pub(super) struct SteamImportFilter {
    paths: ImportPathIndex,
    launch_ids: HashSet<String>,
}

impl SteamImportFilter {
    pub(super) fn from_database(
        paths: ImportPathIndex,
        launch_ids: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            paths,
            launch_ids: launch_ids.into_iter().collect(),
        }
    }

    pub(super) fn exclusion_reason(
        &self,
        candidate: &SteamLaunchTarget,
    ) -> Option<ExistingSteamTargetReason> {
        if self.launch_ids.contains(&candidate.steam_launch_id) {
            return Some(ExistingSteamTargetReason::LaunchIdAlreadyLinked);
        }
        candidate.localpath.as_deref().and_then(|path| {
            self.paths
                .has_imported_path_within(Path::new(path))
                .then_some(ExistingSteamTargetReason::ExistingGameInsideInstallRoot)
        })
    }
}

#[derive(PartialEq, Eq)]
struct CandidateDetails {
    name: String,
    localpath: Option<String>,
    executable: Option<String>,
}

#[derive(Default)]
struct CandidateHistory {
    first_source: Option<String>,
    accepted: Option<CandidateDetails>,
    conflicted: bool,
}

impl CandidateHistory {
    fn observe(
        &mut self,
        candidate: CandidateDetails,
        source: String,
        id: &str,
        warnings: &mut Vec<String>,
    ) {
        if self.conflicted {
            return;
        }
        match &self.accepted {
            None => {
                self.first_source = Some(source);
                self.accepted = Some(candidate);
            }
            Some(first) if first == &candidate => {}
            Some(_) => {
                let original_source = self.first_source.as_deref().unwrap_or("未知来源");
                warnings.push(format!(
                    "Steam 启动项 {id} 在 {original_source} 与 {source} 中信息冲突，已跳过"
                ));
                self.accepted = None;
                self.first_source = None;
                self.conflicted = true;
            }
        }
    }
}

#[derive(Default)]
pub(super) struct SteamCandidateRules {
    histories: BTreeMap<String, CandidateHistory>,
}

impl SteamCandidateRules {
    pub(super) fn consider(
        &mut self,
        candidate: SteamLaunchTarget,
        source: String,
        warnings: &mut Vec<String>,
    ) {
        let SteamLaunchTarget {
            steam_launch_id,
            name,
            localpath,
            executable,
        } = candidate;
        let details = CandidateDetails {
            name,
            localpath,
            executable,
        };
        self.histories
            .entry(steam_launch_id.clone())
            .or_default()
            .observe(details, source, &steam_launch_id, warnings);
    }

    pub(super) fn finish(self) -> Vec<SteamLaunchTarget> {
        let mut resolved = self
            .histories
            .into_iter()
            .filter_map(|(steam_launch_id, history)| {
                history.accepted.map(|details| SteamLaunchTarget {
                    steam_launch_id,
                    name: details.name,
                    localpath: details.localpath,
                    executable: details.executable,
                })
            })
            .collect::<Vec<_>>();
        resolved.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.steam_launch_id.cmp(&right.steam_launch_id))
        });
        resolved
    }
}
#[cfg(test)]
mod tests {
    use super::super::SteamLaunchTarget;
    use super::{ExistingSteamTargetReason, SteamCandidateRules, SteamImportFilter};
    use crate::game::import_path_index::ImportPathIndex;
    use std::path::Path;

    fn target(id: &str, name: &str, localpath: Option<&str>) -> SteamLaunchTarget {
        SteamLaunchTarget {
            steam_launch_id: id.to_string(),
            name: name.to_string(),
            localpath: localpath.map(str::to_string),
            executable: None,
        }
    }

    #[test]
    fn existing_filter_explains_launch_id_and_install_root_matches() {
        let existing = Path::new("C:/SteamLibrary/steamapps/common/Title/build/Game");
        let filter = SteamImportFilter::from_database(
            ImportPathIndex::from_paths([existing.to_string_lossy().into_owned()]),
            ["730".to_string()],
        );

        assert_eq!(
            filter.exclusion_reason(&target("730", "Same ID", Some("D:/Other/Game"))),
            Some(ExistingSteamTargetReason::LaunchIdAlreadyLinked)
        );
        assert_eq!(
            filter.exclusion_reason(&target(
                "440",
                "Same Install",
                Some("C:/SteamLibrary/steamapps/common/Title")
            )),
            Some(ExistingSteamTargetReason::ExistingGameInsideInstallRoot)
        );
        assert_eq!(
            filter.exclusion_reason(&target("570", "New", Some("D:/Steam/Game"))),
            None
        );
    }

    #[test]
    fn repeated_equal_targets_keep_first_and_conflicts_suppress_the_identity() {
        let mut rules = SteamCandidateRules::default();
        let mut warnings = Vec::new();
        let first = target("730", "Game", Some("C:/Steam/Game"));
        rules.consider(first.clone(), "first.acf".into(), &mut warnings);
        rules.consider(first.clone(), "same target.vdf".into(), &mut warnings);
        let mut conflict = first.clone();
        conflict.localpath = Some("D:/Steam/Game".into());
        rules.consider(conflict, "second.acf".into(), &mut warnings);
        rules.consider(first, "later.vdf".into(), &mut warnings);

        assert!(rules.finish().is_empty());
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("first.acf"));
        assert!(warnings[0].contains("second.acf"));
        assert!(warnings[0].contains("信息冲突"));
    }

    #[test]
    fn accepted_target_reconstructs_the_first_candidate_from_its_identity_key() {
        let mut rules = SteamCandidateRules::default();
        let mut warnings = Vec::new();
        let first = SteamLaunchTarget {
            steam_launch_id: "730".to_string(),
            name: "Game".to_string(),
            localpath: Some("C:/Steam/Game".to_string()),
            executable: Some("game.exe".to_string()),
        };
        rules.consider(first.clone(), "first.acf".into(), &mut warnings);
        rules.consider(first.clone(), "same target.vdf".into(), &mut warnings);

        assert_eq!(rules.finish(), vec![first]);
        assert!(warnings.is_empty());
    }

    #[test]
    fn resolved_targets_are_sorted_by_lowercase_name_then_launch_id() {
        let mut rules = SteamCandidateRules::default();
        let mut warnings = Vec::new();
        for (id, name) in [("10", "beta"), ("9", "Alpha"), ("8", "alpha")] {
            rules.consider(target(id, name, None), format!("{id}.acf"), &mut warnings);
        }

        let targets = rules.finish();
        assert_eq!(
            targets
                .iter()
                .map(|target| target.steam_launch_id.as_str())
                .collect::<Vec<_>>(),
            ["8", "9", "10"]
        );
    }
}
