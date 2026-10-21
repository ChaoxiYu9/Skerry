//! Steam 快捷方式文件解析：二进制 shortcuts.vdf 与 InternetShortcut .url。

use super::SteamLaunchTarget;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub(super) const STEAM_SHORTCUT_MARKER: u64 = 0x0200_0000;
const MAX_BINARY_VDF_DEPTH: usize = 64;

enum CapturedVdfValue {
    String(String),
    U32(u32),
    Other,
}

struct SelectedShortcutField {
    key: String,
    value: CapturedVdfValue,
}

#[derive(Default)]
struct ShortcutFields {
    app_id: Option<SelectedShortcutField>,
    name: Option<SelectedShortcutField>,
    executable: Option<SelectedShortcutField>,
    start_directory: Option<SelectedShortcutField>,
}

enum ShortcutEntry {
    Fields(ShortcutFields),
    Other,
}

type ShortcutEntries = BTreeMap<String, ShortcutEntry>;

struct BinaryVdfCursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> BinaryVdfCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn is_empty(&self) -> bool {
        self.position >= self.bytes.len()
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        let value = *self
            .bytes
            .get(self.position)
            .ok_or_else(|| "二进制 VDF 意外结束".to_string())?;
        self.position += 1;
        Ok(value)
    }

    fn read_exact<const SIZE: usize>(&mut self) -> Result<[u8; SIZE], String> {
        let end = self
            .position
            .checked_add(SIZE)
            .ok_or_else(|| "二进制 VDF 偏移溢出".to_string())?;
        let bytes = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| "二进制 VDF 意外结束".to_string())?;
        self.position = end;
        bytes
            .try_into()
            .map_err(|_| "二进制 VDF 字段长度无效".to_string())
    }

    fn read_u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.read_exact()?))
    }

    fn read_u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.read_exact()?))
    }

    fn read_cstring(&mut self) -> Result<String, String> {
        let remaining = &self.bytes[self.position..];
        let length = remaining
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| "二进制 VDF 字符串缺少终止符".to_string())?;
        let value = String::from_utf8_lossy(&remaining[..length]).into_owned();
        self.position += length + 1;
        Ok(value)
    }

    fn skip_cstring(&mut self) -> Result<(), String> {
        let remaining = &self.bytes[self.position..];
        let length = remaining
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| "二进制 VDF 字符串缺少终止符".to_string())?;
        self.position += length + 1;
        Ok(())
    }

    fn skip_wstring(&mut self) -> Result<(), String> {
        loop {
            if self.read_exact::<2>()? == [0, 0] {
                return Ok(());
            }
        }
    }

    fn skip(&mut self, length: usize) -> Result<(), String> {
        let end = self
            .position
            .checked_add(length)
            .ok_or_else(|| "二进制 VDF 偏移溢出".to_string())?;
        if end > self.bytes.len() {
            return Err("二进制 VDF 意外结束".to_string());
        }
        self.position = end;
        Ok(())
    }
}

fn ensure_vdf_depth(depth: usize) -> Result<(), String> {
    if depth > MAX_BINARY_VDF_DEPTH {
        Err("二进制 VDF 嵌套层级过深".to_string())
    } else {
        Ok(())
    }
}

fn skip_vdf_value(
    cursor: &mut BinaryVdfCursor<'_>,
    value_type: u8,
    depth: usize,
) -> Result<(), String> {
    match value_type {
        0 => skip_vdf_object(cursor, depth + 1),
        1 => cursor.skip_cstring(),
        2 => cursor.skip(4),
        3 | 4 | 6 => cursor.skip(4),
        5 => cursor.skip_wstring(),
        7 => cursor.read_u64().map(|_| ()),
        10 => cursor.skip(8),
        other => Err(format!("不支持的二进制 VDF 类型: {other}")),
    }
}

fn skip_vdf_object(cursor: &mut BinaryVdfCursor<'_>, depth: usize) -> Result<(), String> {
    ensure_vdf_depth(depth)?;
    loop {
        if cursor.is_empty() {
            return Err("二进制 VDF 对象缺少结束标记".to_string());
        }
        let value_type = cursor.read_u8()?;
        if value_type == 8 {
            return Ok(());
        }
        cursor.skip_cstring()?;
        skip_vdf_value(cursor, value_type, depth)?;
    }
}

#[derive(Clone, Copy)]
enum ShortcutFieldKind {
    AppId,
    Name,
    Executable,
    StartDirectory,
}

impl ShortcutFieldKind {
    fn from_key(key: &str) -> Option<Self> {
        if key.eq_ignore_ascii_case("appid") {
            Some(Self::AppId)
        } else if key.eq_ignore_ascii_case("appname") {
            Some(Self::Name)
        } else if key.eq_ignore_ascii_case("exe") {
            Some(Self::Executable)
        } else if key.eq_ignore_ascii_case("startdir") {
            Some(Self::StartDirectory)
        } else {
            None
        }
    }
}

impl ShortcutFields {
    fn select(field: &mut Option<SelectedShortcutField>, key: String, value: CapturedVdfValue) {
        // Match BTreeMap lookup: the first case-insensitive key wins, while an exact duplicate
        // replaces its previous value.
        let is_preferred = field
            .as_ref()
            .is_none_or(|selected| key.as_str() <= selected.key.as_str());
        if is_preferred {
            *field = Some(SelectedShortcutField { key, value });
        }
    }

    fn insert(&mut self, kind: ShortcutFieldKind, key: String, value: CapturedVdfValue) {
        match kind {
            ShortcutFieldKind::AppId => Self::select(&mut self.app_id, key, value),
            ShortcutFieldKind::Name => Self::select(&mut self.name, key, value),
            ShortcutFieldKind::Executable => Self::select(&mut self.executable, key, value),
            ShortcutFieldKind::StartDirectory => {
                Self::select(&mut self.start_directory, key, value)
            }
        }
    }
}

fn parse_shortcut_fields(
    cursor: &mut BinaryVdfCursor<'_>,
    depth: usize,
) -> Result<ShortcutFields, String> {
    ensure_vdf_depth(depth)?;
    let mut fields = ShortcutFields::default();
    loop {
        if cursor.is_empty() {
            return Err("二进制 VDF 对象缺少结束标记".to_string());
        }
        let value_type = cursor.read_u8()?;
        if value_type == 8 {
            return Ok(fields);
        }

        let key = cursor.read_cstring()?;
        let field_kind = ShortcutFieldKind::from_key(&key);
        match value_type {
            0 => {
                skip_vdf_object(cursor, depth + 1)?;
                if let Some(kind) = field_kind {
                    fields.insert(kind, key, CapturedVdfValue::Other);
                }
            }
            1 => {
                if let Some(kind) = field_kind {
                    fields.insert(kind, key, CapturedVdfValue::String(cursor.read_cstring()?));
                } else {
                    cursor.skip_cstring()?;
                }
            }
            2 => {
                let value = cursor.read_u32()?;
                if let Some(kind) = field_kind {
                    fields.insert(kind, key, CapturedVdfValue::U32(value));
                }
            }
            3 | 4 | 6 => cursor.skip(4)?,
            5 => cursor.skip_wstring()?,
            7 => {
                cursor.read_u64()?;
                if let Some(kind) = field_kind {
                    fields.insert(kind, key, CapturedVdfValue::Other);
                }
            }
            10 => cursor.skip(8)?,
            other => return Err(format!("不支持的二进制 VDF 类型: {other}")),
        }
    }
}

fn parse_shortcut_collection(
    cursor: &mut BinaryVdfCursor<'_>,
    depth: usize,
) -> Result<ShortcutEntries, String> {
    ensure_vdf_depth(depth)?;
    let mut entries = BTreeMap::new();
    loop {
        if cursor.is_empty() {
            return Err("二进制 VDF 对象缺少结束标记".to_string());
        }
        let value_type = cursor.read_u8()?;
        if value_type == 8 {
            return Ok(entries);
        }

        let key = cursor.read_cstring()?;
        let value = match value_type {
            0 => ShortcutEntry::Fields(parse_shortcut_fields(cursor, depth + 1)?),
            1 => {
                cursor.skip_cstring()?;
                ShortcutEntry::Other
            }
            2 => {
                cursor.read_u32()?;
                ShortcutEntry::Other
            }
            3 | 4 | 6 => {
                cursor.skip(4)?;
                continue;
            }
            5 => {
                cursor.skip_wstring()?;
                continue;
            }
            7 => {
                cursor.read_u64()?;
                ShortcutEntry::Other
            }
            10 => {
                cursor.skip(8)?;
                continue;
            }
            other => return Err(format!("不支持的二进制 VDF 类型: {other}")),
        };
        entries.insert(key, value);
    }
}

fn select_shortcuts_root(
    selected: &mut Option<(String, Option<ShortcutEntries>)>,
    key: String,
    entries: Option<ShortcutEntries>,
) {
    // The shortcuts root uses the same case-insensitive, ordered lookup as shortcut fields.
    let is_preferred = selected
        .as_ref()
        .is_none_or(|(selected_key, _)| key.as_str() <= selected_key.as_str());
    if is_preferred {
        *selected = Some((key, entries));
    }
}

fn parse_shortcut_entries(bytes: &[u8]) -> Result<Option<ShortcutEntries>, String> {
    if bytes.is_empty() {
        return Err("shortcuts.vdf 为空".to_string());
    }
    let mut cursor = BinaryVdfCursor::new(bytes);
    let mut selected_shortcuts = None;
    loop {
        if cursor.is_empty() {
            return Err("二进制 VDF 对象缺少结束标记".to_string());
        }
        let value_type = cursor.read_u8()?;
        if value_type == 8 {
            break;
        }
        let key = cursor.read_cstring()?;
        if !key.eq_ignore_ascii_case("shortcuts") {
            skip_vdf_value(&mut cursor, value_type, 0)?;
            continue;
        }

        match value_type {
            0 => {
                let entries = parse_shortcut_collection(&mut cursor, 1)?;
                select_shortcuts_root(&mut selected_shortcuts, key, Some(entries));
            }
            1 => {
                cursor.skip_cstring()?;
                select_shortcuts_root(&mut selected_shortcuts, key, None);
            }
            2 => {
                cursor.read_u32()?;
                select_shortcuts_root(&mut selected_shortcuts, key, None);
            }
            3 | 4 | 6 => cursor.skip(4)?,
            5 => cursor.skip_wstring()?,
            7 => {
                cursor.read_u64()?;
                select_shortcuts_root(&mut selected_shortcuts, key, None);
            }
            10 => cursor.skip(8)?,
            other => return Err(format!("不支持的二进制 VDF 类型: {other}")),
        }
    }
    if !cursor.is_empty() {
        return Err("二进制 VDF 根对象结束后存在多余数据".to_string());
    }
    Ok(selected_shortcuts.and_then(|(_, entries)| entries))
}

pub(super) fn strip_outer_quotes(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value)
        .trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub(super) fn lexical_file_name(path: &str) -> Option<String> {
    path.rsplit(['/', '\\'])
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn lexical_parent(path: &str) -> Option<String> {
    let (index, separator) = path
        .char_indices()
        .rev()
        .find(|(_, character)| matches!(character, '/' | '\\'))?;
    let end = if index == 0
        || index == 2
            && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && path.as_bytes().get(1) == Some(&b':')
    {
        index + separator.len_utf8()
    } else {
        index
    };
    let parent = path[..end].trim_end_matches([' ', '\t']);
    (!parent.is_empty()).then(|| parent.to_string())
}

pub(super) fn shortcut_launch_id(shortcut_app_id: u32) -> String {
    ((u64::from(shortcut_app_id) << 32) | STEAM_SHORTCUT_MARKER).to_string()
}

pub(super) fn parse_shortcuts_vdf(
    path: &Path,
) -> Result<(Vec<SteamLaunchTarget>, Vec<String>), String> {
    let bytes = fs::read(path).map_err(|error| format!("读取 {} 失败: {error}", path.display()))?;
    parse_shortcuts_vdf_contents(&bytes, path)
}

pub(super) fn parse_shortcuts_vdf_contents(
    bytes: &[u8],
    path: &Path,
) -> Result<(Vec<SteamLaunchTarget>, Vec<String>), String> {
    let shortcuts = parse_shortcut_entries(bytes)
        .map_err(|error| format!("解析 {} 失败: {error}", path.display()))?;
    let Some(shortcuts) = shortcuts else {
        return Err(format!("{} 缺少 shortcuts 根节点", path.display()));
    };

    let mut entries = shortcuts.iter().collect::<Vec<_>>();
    entries.sort_by_cached_key(|(index, _)| index.parse::<u64>().unwrap_or(u64::MAX));
    let mut games = Vec::new();
    let mut warnings = Vec::new();
    for (index, value) in entries {
        let ShortcutEntry::Fields(fields) = value else {
            warnings.push(format!("{} 的快捷方式 {index} 不是对象", path.display()));
            continue;
        };
        let shortcut_app_id = match fields.app_id.as_ref().map(|field| &field.value) {
            Some(CapturedVdfValue::U32(app_id)) if *app_id != 0 => *app_id,
            _ => {
                warnings.push(format!(
                    "{} 的快捷方式 {index} 缺少有效 appid",
                    path.display()
                ));
                continue;
            }
        };
        let name = match fields.name.as_ref().and_then(|field| match &field.value {
            CapturedVdfValue::String(name) => Some(name.trim()).filter(|name| !name.is_empty()),
            _ => None,
        }) {
            Some(name) => name.to_string(),
            None => {
                warnings.push(format!(
                    "{} 的快捷方式 {index} 缺少游戏名称",
                    path.display()
                ));
                continue;
            }
        };
        let executable_path = fields
            .executable
            .as_ref()
            .and_then(|field| match &field.value {
                CapturedVdfValue::String(value) => strip_outer_quotes(value),
                _ => None,
            });
        let start_dir = fields
            .start_directory
            .as_ref()
            .and_then(|field| match &field.value {
                CapturedVdfValue::String(value) => strip_outer_quotes(value),
                _ => None,
            });
        let localpath = start_dir.or_else(|| executable_path.as_deref().and_then(lexical_parent));
        let executable = executable_path.as_deref().and_then(lexical_file_name);

        games.push(SteamLaunchTarget {
            steam_launch_id: shortcut_launch_id(shortcut_app_id),
            name,
            localpath,
            executable,
        });
    }
    Ok((games, warnings))
}

pub(super) fn decode_shortcut_text(bytes: &[u8]) -> Result<String, String> {
    if let Some(bytes) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes.to_vec())
            .map_err(|error| format!("快捷方式不是有效 UTF-8: {error}"));
    }
    if let Some(bytes) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        if bytes.len() % 2 != 0 {
            return Err("UTF-16LE 快捷方式字节长度无效".to_string());
        }
        let words = bytes
            .chunks_exact(2)
            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]));
        return char::decode_utf16(words)
            .collect::<Result<String, _>>()
            .map_err(|error| format!("快捷方式不是有效 UTF-16LE: {error}"));
    }
    // Windows 也会生成无 BOM 的系统 ANSI `.url`；URL 键本身是 ASCII，
    // 因此损失替换其它本地化字段不会影响后续严格 URI 校验。
    Ok(String::from_utf8_lossy(bytes).into_owned())
}

pub(super) fn parse_url_launch_id(text: &str) -> Result<String, String> {
    let mut in_internet_shortcut = false;
    let mut shortcut_url = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_internet_shortcut = line[1..line.len() - 1]
                .trim()
                .eq_ignore_ascii_case("InternetShortcut");
            continue;
        }
        if !in_internet_shortcut {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("URL") {
            shortcut_url = Some(value.trim());
            break;
        }
    }
    let shortcut_url = shortcut_url.ok_or_else(|| "快捷方式缺少 URL".to_string())?;
    const PREFIX: &str = "steam://rungameid/";
    let Some(prefix) = shortcut_url.get(..PREFIX.len()) else {
        return Err("仅支持 steam://rungameid/<数字> 快捷方式".to_string());
    };
    if !prefix.eq_ignore_ascii_case(PREFIX) {
        return Err("仅支持 steam://rungameid/<数字> 快捷方式".to_string());
    }
    let id = &shortcut_url[PREFIX.len()..];
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Steam 快捷方式 URL 格式无效".to_string());
    }
    let id = id
        .parse::<u64>()
        .map_err(|_| "Steam 启动 ID 超出 u64 范围".to_string())?;
    if id == 0 {
        return Err("Steam 启动 ID 必须大于 0".to_string());
    }
    Ok(id.to_string())
}
