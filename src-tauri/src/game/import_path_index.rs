use std::collections::BTreeSet;
use std::path::{Component, Path};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ImportPathComponent {
    Prefix(String),
    Root,
    Parent,
    Normal(String),
}

/// Stores normalized paths in sorted component order for prefix lookup.
pub(crate) struct ImportPathIndex {
    paths: BTreeSet<Vec<ImportPathComponent>>,
}

impl Default for ImportPathIndex {
    fn default() -> Self {
        Self {
            paths: BTreeSet::new(),
        }
    }
}

impl ImportPathIndex {
    pub(crate) fn from_paths(paths: impl IntoIterator<Item = String>) -> Self {
        let mut index = Self::default();
        for path in paths {
            index.insert(Path::new(&path));
        }
        index
    }

    pub(crate) fn insert(&mut self, path: &Path) {
        if let Some(components) = normalize_import_path(path) {
            self.paths.insert(components);
        }
    }

    /// True when the candidate is already stored or lies beneath a stored game directory.
    pub(crate) fn is_imported_or_descendant(&self, candidate: &Path) -> bool {
        let Some(components) = normalize_import_path(candidate) else {
            return false;
        };
        (1..=components.len()).any(|end| self.paths.contains(&components[..end]))
    }

    /// True when a stored game path is the Steam install root or one of its descendants.
    pub(crate) fn has_imported_path_within(&self, root: &Path) -> bool {
        let Some(root_components) = normalize_import_path(root) else {
            return false;
        };
        self.paths
            .range(root_components.clone()..)
            .next()
            .is_some_and(|path| path.starts_with(&root_components))
    }

    pub(crate) fn len(&self) -> usize {
        self.paths.len()
    }
}

fn normalize_import_path(path: &Path) -> Option<Vec<ImportPathComponent>> {
    let mut normalized = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(ImportPathComponent::Prefix(
                normalize_import_component(prefix.as_os_str()),
            )),
            Component::RootDir => normalized.push(ImportPathComponent::Root),
            Component::CurDir => {}
            Component::ParentDir => match normalized.last() {
                Some(ImportPathComponent::Normal(_)) => {
                    normalized.pop();
                }
                Some(ImportPathComponent::Root) => {}
                _ => normalized.push(ImportPathComponent::Parent),
            },
            Component::Normal(value) => normalized.push(ImportPathComponent::Normal(
                normalize_import_component(value),
            )),
        }
    }
    (!normalized.is_empty()).then_some(normalized)
}

#[cfg(windows)]
fn normalize_import_component(value: &std::ffi::OsStr) -> String {
    value.to_string_lossy().to_lowercase()
}

#[cfg(not(windows))]
fn normalize_import_component(value: &std::ffi::OsStr) -> String {
    value.to_string_lossy().into_owned()
}
#[cfg(test)]
mod tests {
    use super::ImportPathIndex;
    use std::path::Path;

    #[test]
    fn prefix_queries_distinguish_ancestors_descendants_and_siblings() {
        let imported_game = Path::new("scan-root/Games/A/Build/Game");
        let sibling_game = Path::new("scan-root/Games/AB/Game");
        let index = ImportPathIndex::from_paths([
            imported_game.to_string_lossy().into_owned(),
            imported_game.to_string_lossy().into_owned(),
            sibling_game.to_string_lossy().into_owned(),
        ]);

        assert_eq!(index.len(), 2);
        assert!(index.is_imported_or_descendant(imported_game));
        assert!(index.is_imported_or_descendant(&imported_game.join("Data")));
        assert!(!index.is_imported_or_descendant(imported_game.parent().unwrap()));
        assert!(!index.is_imported_or_descendant(Path::new("scan-root/Games/A")));
        assert!(!index.is_imported_or_descendant(Path::new("scan-root/Games/A2")));

        assert!(index.has_imported_path_within(Path::new("scan-root/Games/A")));
        assert!(index.has_imported_path_within(sibling_game));
        assert!(!index.has_imported_path_within(Path::new("scan-root/Games/A2")));
        assert!(!index.has_imported_path_within(&imported_game.join("Data")));
    }

    #[test]
    fn normalized_parent_components_share_the_same_prefix_path() {
        let mut index = ImportPathIndex::default();
        index.insert(Path::new("scan-root/Games/../Games/Title"));

        assert!(index.is_imported_or_descendant(Path::new("scan-root/Games/Title/Data")));
        assert!(index.has_imported_path_within(Path::new("scan-root/Games/Title")));
        assert!(!index.has_imported_path_within(Path::new("scan-root/Games/Other")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_component_matching_remains_case_insensitive() {
        let mut index = ImportPathIndex::default();
        index.insert(Path::new(r"C:\Games\Title"));

        assert!(index.is_imported_or_descendant(Path::new(r"c:\games\title\Data")));
        assert!(index.has_imported_path_within(Path::new(r"c:\games")));
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_component_matching_remains_case_sensitive() {
        let mut index = ImportPathIndex::default();
        index.insert(Path::new("Games/Title"));

        assert!(index.is_imported_or_descendant(Path::new("Games/Title/Data")));
        assert!(!index.is_imported_or_descendant(Path::new("games/title/Data")));
        assert!(!index.has_imported_path_within(Path::new("games")));
    }
}
