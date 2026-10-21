//! Compatibility order shared by mixed-mode list names and inferred release dates.
//! A concrete selected source keeps its own scope; this list applies only to fallback.

pub(super) const MIXED_NAME_AND_DATE_PRIORITY: [&str; 4] = ["bgm", "vndb", "ymgal", "kun"];
