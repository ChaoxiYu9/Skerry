use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DirectoryExclusionReason {
    OperatingSystem,
    DevelopmentArtifact,
    RuntimeSetup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ExecutableExclusionReason {
    Uninstaller,
    Installer,
    RuntimeSetup,
    CrashReporter,
}

const DIRECTORY_RULES: &[(&str, DirectoryExclusionReason)] = &[
    ("$recycle.bin", DirectoryExclusionReason::OperatingSystem),
    (
        "system volume information",
        DirectoryExclusionReason::OperatingSystem,
    ),
    ("windows", DirectoryExclusionReason::OperatingSystem),
    ("program files", DirectoryExclusionReason::OperatingSystem),
    (
        "program files (x86)",
        DirectoryExclusionReason::OperatingSystem,
    ),
    ("programdata", DirectoryExclusionReason::OperatingSystem),
    ("appdata", DirectoryExclusionReason::OperatingSystem),
    (".git", DirectoryExclusionReason::DevelopmentArtifact),
    (".vs", DirectoryExclusionReason::DevelopmentArtifact),
    (
        "node_modules",
        DirectoryExclusionReason::DevelopmentArtifact,
    ),
    ("__pycache__", DirectoryExclusionReason::DevelopmentArtifact),
    ("redist", DirectoryExclusionReason::RuntimeSetup),
    ("redistributables", DirectoryExclusionReason::RuntimeSetup),
    ("_commonredist", DirectoryExclusionReason::RuntimeSetup),
    ("directx", DirectoryExclusionReason::RuntimeSetup),
    ("vcredist", DirectoryExclusionReason::RuntimeSetup),
];

const EXECUTABLE_RULES: &[(&str, ExecutableExclusionReason)] = &[
    ("unins", ExecutableExclusionReason::Uninstaller),
    ("uninst", ExecutableExclusionReason::Uninstaller),
    ("uninstall", ExecutableExclusionReason::Uninstaller),
    ("setup", ExecutableExclusionReason::Installer),
    ("install", ExecutableExclusionReason::Installer),
    ("dxsetup", ExecutableExclusionReason::RuntimeSetup),
    ("vcredist", ExecutableExclusionReason::RuntimeSetup),
    ("vc_redist", ExecutableExclusionReason::RuntimeSetup),
    ("dotnetfx", ExecutableExclusionReason::RuntimeSetup),
    ("oalinst", ExecutableExclusionReason::RuntimeSetup),
    ("crashhandler", ExecutableExclusionReason::CrashReporter),
    ("crash_handler", ExecutableExclusionReason::CrashReporter),
    ("crashreport", ExecutableExclusionReason::CrashReporter),
    ("crash_report", ExecutableExclusionReason::CrashReporter),
    ("bugreport", ExecutableExclusionReason::CrashReporter),
    ("bug_report", ExecutableExclusionReason::CrashReporter),
    ("unitycrashandler", ExecutableExclusionReason::CrashReporter),
];

pub(super) fn trim_dirname_to_search_name(directory_name: &str) -> String {
    let mut name = String::with_capacity(directory_name.len());
    let mut depths = [0_usize; 4];
    let mut pending_space = false;

    for character in directory_name.chars() {
        let bracket = match character {
            '[' => Some((0, true)),
            ']' => Some((0, false)),
            '(' => Some((1, true)),
            ')' => Some((1, false)),
            '【' => Some((2, true)),
            '】' => Some((2, false)),
            '（' => Some((3, true)),
            '）' => Some((3, false)),
            _ => None,
        };
        if let Some((index, opening)) = bracket {
            if opening {
                depths[index] += 1;
            } else {
                depths[index] = depths[index].saturating_sub(1);
            }
            continue;
        }
        if depths.iter().any(|depth| *depth > 0) {
            continue;
        }
        if character.is_whitespace() {
            pending_space |= !name.is_empty();
        } else {
            if pending_space {
                name.push(' ');
                pending_space = false;
            }
            name.push(character);
        }
    }
    if name.is_empty() {
        directory_name.trim().to_owned()
    } else {
        name
    }
}

pub(super) fn directory_exclusion_reason(name: &str) -> Option<DirectoryExclusionReason> {
    DIRECTORY_RULES
        .iter()
        .find(|(excluded_name, _)| name.eq_ignore_ascii_case(excluded_name))
        .map(|(_, reason)| *reason)
}

fn contains_ascii_case_insensitive(value: &str, pattern: &str) -> bool {
    let pattern = pattern.as_bytes();
    !pattern.is_empty()
        && value
            .as_bytes()
            .windows(pattern.len())
            .any(|candidate| candidate.eq_ignore_ascii_case(pattern))
}

pub(super) fn executable_exclusion_reason(path: &Path) -> Option<ExecutableExclusionReason> {
    let stem = path.file_stem()?.to_string_lossy();
    EXECUTABLE_RULES
        .iter()
        .find(|(pattern, _)| contains_ascii_case_insensitive(&stem, pattern))
        .map(|(_, reason)| *reason)
}

pub(super) fn has_supported_executable_extension(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        ["exe", "bat", "cmd"]
            .iter()
            .any(|expected| extension.eq_ignore_ascii_case(expected))
    })
}

fn has_han_without_kana(filename: &str) -> bool {
    let filename = Path::new(filename)
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| filename.into());
    let mut has_han = false;
    for character in filename.chars() {
        if matches!(character,
            '\u{3040}'..='\u{30FF}' | '\u{31F0}'..='\u{31FF}' | '\u{FF65}'..='\u{FF9F}' |
            '\u{1AFF0}'..='\u{1AFFF}' | '\u{1B000}'..='\u{1B16F}')
        {
            return false;
        }
        has_han |= matches!(character,
            '\u{3400}'..='\u{4DBF}' | '\u{4E00}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' |
            '\u{20000}'..='\u{2EBEF}' | '\u{30000}'..='\u{323AF}');
    }
    has_han
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ExecutableOrder {
    startup: bool,
    missing_language_tag: bool,
    missing_han_name: bool,
    missing_game_name: bool,
    filename_length: usize,
    lowercase_name: String,
    original_name: String,
}

pub(super) fn sort_executables(executables: &mut [String], game_name: &str) {
    let folded_game_name = game_name.to_lowercase();
    let mut ranked = executables
        .iter()
        .map(|filename| {
            let folded_filename = filename.to_lowercase();
            let order = ExecutableOrder {
                startup: folded_filename.contains("startup"),
                missing_language_tag: !(folded_filename.contains("chs")
                    || folded_filename.contains("cn")),
                missing_han_name: !has_han_without_kana(filename),
                missing_game_name: !folded_filename.contains(&folded_game_name),
                filename_length: filename.len(),
                lowercase_name: folded_filename,
                original_name: filename.clone(),
            };
            (order, filename.clone())
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| left.0.cmp(&right.0));
    for (slot, (_, filename)) in executables.iter_mut().zip(ranked) {
        *slot = filename;
    }
}
#[cfg(test)]
mod tests {
    use super::{
        DIRECTORY_RULES, DirectoryExclusionReason, EXECUTABLE_RULES, ExecutableExclusionReason,
        contains_ascii_case_insensitive, directory_exclusion_reason, executable_exclusion_reason,
        has_supported_executable_extension,
    };
    use std::path::Path;

    #[test]
    fn directory_rules_match_only_named_components_without_case_sensitivity() {
        assert_eq!(
            directory_exclusion_reason("WINDOWS"),
            Some(DirectoryExclusionReason::OperatingSystem)
        );
        assert_eq!(
            directory_exclusion_reason("Node_Modules"),
            Some(DirectoryExclusionReason::DevelopmentArtifact)
        );
        assert_eq!(
            directory_exclusion_reason("DirectX"),
            Some(DirectoryExclusionReason::RuntimeSetup)
        );
        assert_eq!(directory_exclusion_reason("Windows.old"), None);
        assert_eq!(directory_exclusion_reason("WKndows"), None);
        assert_eq!(directory_exclusion_reason("Wİndows"), None);
    }

    #[test]
    fn executable_rules_explain_rejected_utility_names_and_keep_extensions_separate() {
        assert_eq!(
            executable_exclusion_reason(Path::new("D:/Game/UninstallTool.exe")),
            Some(ExecutableExclusionReason::Uninstaller)
        );
        assert_eq!(
            executable_exclusion_reason(Path::new("D:/Game/VC_redist.x64.exe")),
            Some(ExecutableExclusionReason::RuntimeSetup)
        );
        assert_eq!(
            executable_exclusion_reason(Path::new("D:/Game/Crash_Handler.exe")),
            Some(ExecutableExclusionReason::CrashReporter)
        );
        assert_eq!(
            executable_exclusion_reason(Path::new("D:/游戏/UnInStAlLTool.exe")),
            Some(ExecutableExclusionReason::Uninstaller)
        );
        assert_eq!(
            executable_exclusion_reason(Path::new("D:/Game/İnstallTool.exe")),
            None
        );
        assert_eq!(
            executable_exclusion_reason(Path::new("D:/Game/game.exe")),
            None
        );
        assert!(has_supported_executable_extension(Path::new("game.CMD")));
        assert!(!has_supported_executable_extension(Path::new("game.dll")));
    }

    #[test]
    fn exclusion_patterns_are_nonempty_ascii_fragments() {
        assert!(
            DIRECTORY_RULES
                .iter()
                .all(|(pattern, _)| !pattern.is_empty() && pattern.is_ascii())
        );
        assert!(
            EXECUTABLE_RULES
                .iter()
                .all(|(pattern, _)| !pattern.is_empty() && pattern.is_ascii())
        );
    }

    #[test]
    fn ascii_matchers_keep_existing_unicode_case_mapping_boundaries() {
        for replacement in ['İ', 'K'] {
            for (pattern, _) in DIRECTORY_RULES {
                for (index, character) in pattern.char_indices() {
                    let end = index + character.len_utf8();
                    let candidate =
                        format!("{}{replacement}{}", &pattern[..index], &pattern[end..]);
                    assert_eq!(
                        candidate.to_lowercase() == *pattern,
                        candidate.eq_ignore_ascii_case(pattern),
                        "directory rule {pattern:?} with {replacement:?}"
                    );
                }
            }

            for (pattern, _) in EXECUTABLE_RULES {
                for (index, character) in pattern.char_indices() {
                    let end = index + character.len_utf8();
                    let candidate =
                        format!("{}{replacement}{}", &pattern[..index], &pattern[end..]);
                    assert_eq!(
                        candidate.to_lowercase().contains(pattern),
                        contains_ascii_case_insensitive(&candidate, pattern),
                        "executable rule {pattern:?} with {replacement:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn directory_name_cleanup_streams_unicode_whitespace_and_nested_tags() {
        assert_eq!(
            super::trim_dirname_to_search_name(" [社团（旧版）]\u{00a0} 游戏\t\n名 【版本】  ",),
            "游戏 名"
        );
        assert_eq!(
            super::trim_dirname_to_search_name("] 游戏 ) [隐藏部分"),
            "游戏"
        );
    }
}
