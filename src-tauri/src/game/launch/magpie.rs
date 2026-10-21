use crate::utils::command_ext::CommandGuiExt;
use std::process::Command;
use std::time::Duration;

use log::debug;
use windows::{
    Win32::{
        Foundation::{CloseHandle, ERROR_NO_MORE_FILES, HWND, LPARAM, WPARAM},
        System::Diagnostics::ToolHelp::{
            CREATE_TOOLHELP_SNAPSHOT_FLAGS, CreateToolhelp32Snapshot, PROCESSENTRY32W,
            Process32FirstW, Process32NextW,
        },
        UI::WindowsAndMessaging::{FindWindowExW, HWND_MESSAGE, PostMessageW, WM_HOTKEY},
    },
    core::{HRESULT, PCWSTR, w},
};

const MAGPIE_FULLSCREEN_SCALE_ACTION: usize = 0;
const HOTKEY_WINDOW_POLL_INTERVAL: Duration = Duration::from_millis(100);

struct MagpieReadinessSchedule {
    started_at: std::time::Instant,
    timeout: Duration,
}

impl MagpieReadinessSchedule {
    fn start(timeout: Duration) -> Self {
        Self {
            started_at: std::time::Instant::now(),
            timeout,
        }
    }

    fn next_poll_delay(&self, observed_at: std::time::Instant) -> Option<Duration> {
        let elapsed = observed_at.saturating_duration_since(self.started_at);
        let remaining = self.timeout.saturating_sub(elapsed);
        (!remaining.is_zero()).then(|| remaining.min(HOTKEY_WINDOW_POLL_INTERVAL))
    }
}

pub fn ensure_running(magpie_path: &str) -> Result<bool, String> {
    ensure_running_with(is_magpie_running, || {
        let mut command = Command::new(magpie_path);
        command.arg("-t");
        command
            .gui_safe()
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("启动 Magpie 失败: {error}"))
    })
}

fn ensure_running_with(
    query_running: impl FnOnce() -> Result<bool, String>,
    start: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    if query_running()? {
        return Ok(true);
    }

    start()?;
    Ok(false)
}

pub async fn wait_until_ready(timeout: Duration) -> Result<(), String> {
    let schedule = MagpieReadinessSchedule::start(timeout);

    loop {
        if find_hotkey_window().is_ok() {
            debug!("Magpie_Hotkey 已就绪");
            return Ok(());
        }

        match schedule.next_poll_delay(std::time::Instant::now()) {
            Some(delay) => tokio::time::sleep(delay).await,
            None => return Err("等待 Magpie_Hotkey 创建超时".to_string()),
        }
    }
}

pub fn trigger_fullscreen_scaling() -> Result<(), String> {
    let hwnd = find_hotkey_window()?;

    unsafe {
        PostMessageW(
            Some(hwnd),
            WM_HOTKEY,
            WPARAM(MAGPIE_FULLSCREEN_SCALE_ACTION),
            LPARAM(0),
        )
    }
    .map_err(|e| format!("发送 Magpie 全屏缩放消息失败: {e}"))?;

    debug!("已发送 Magpie 全屏缩放 WM_HOTKEY");
    Ok(())
}

fn find_hotkey_window() -> Result<HWND, String> {
    unsafe {
        FindWindowExW(
            Some(HWND_MESSAGE),
            None,
            w!("Magpie_Hotkey"),
            PCWSTR::null(),
        )
    }
    .map_err(|e| format!("未找到 Magpie_Hotkey: {e}"))
}

fn is_magpie_running() -> Result<bool, String> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(CREATE_TOOLHELP_SNAPSHOT_FLAGS(0x0000_0002), 0)
            .map_err(|error| format!("创建 Magpie 进程快照失败: {error}"))?;
        if snapshot.is_invalid() {
            return Err("创建 Magpie 进程快照返回无效句柄".to_string());
        }

        let mut entry = PROCESSENTRY32W {
            dwSize: u32::try_from(std::mem::size_of::<PROCESSENTRY32W>())
                .expect("PROCESSENTRY32W size must fit in Win32 DWORD"),
            ..Default::default()
        };

        let mut first_process = true;
        let result = find_process_match(|| {
            let enumeration_result = if first_process {
                first_process = false;
                Process32FirstW(snapshot, &mut entry)
            } else {
                Process32NextW(snapshot, &mut entry)
            };

            match enumeration_result {
                Ok(()) => Ok(Some(matches_process_name_ascii_case_insensitive(
                    &entry.szExeFile,
                    "Magpie.exe",
                ))),
                Err(error) if error.code() == HRESULT::from_win32(ERROR_NO_MORE_FILES.0) => {
                    Ok(None)
                }
                Err(error) => Err(format!("读取 Magpie 进程快照失败: {error}")),
            }
        });

        let _ = CloseHandle(snapshot);
        result
    }
}

fn find_process_match(
    mut next_process_matches: impl FnMut() -> Result<Option<bool>, String>,
) -> Result<bool, String> {
    loop {
        match next_process_matches()? {
            Some(true) => return Ok(true),
            Some(false) => continue,
            None => return Ok(false),
        }
    }
}

fn matches_process_name_ascii_case_insensitive(process_name: &[u16], expected: &str) -> bool {
    let name_end = process_name
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(process_name.len());
    let mut actual_units = process_name[..name_end].iter().copied();
    let mut expected_units = expected.encode_utf16();

    loop {
        match (actual_units.next(), expected_units.next()) {
            (Some(actual), Some(expected))
                if fold_ascii_case(actual) == fold_ascii_case(expected) => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

fn fold_ascii_case(unit: u16) -> u16 {
    let uppercase_a = u16::from(b'A');
    let uppercase_z = u16::from(b'Z');
    if (uppercase_a..=uppercase_z).contains(&unit) {
        unit + u16::from(b'a' - b'A')
    } else {
        unit
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MagpieReadinessSchedule, ensure_running_with, find_process_match,
        matches_process_name_ascii_case_insensitive,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn readiness_polling_caps_each_wait_at_the_remaining_deadline() {
        let started_at = Instant::now();
        let schedule = MagpieReadinessSchedule {
            started_at,
            timeout: Duration::from_millis(250),
        };

        assert_eq!(
            schedule.next_poll_delay(started_at),
            Some(Duration::from_millis(100))
        );
        assert_eq!(
            schedule.next_poll_delay(started_at + Duration::from_millis(100)),
            Some(Duration::from_millis(100))
        );
        assert_eq!(
            schedule.next_poll_delay(started_at + Duration::from_millis(200)),
            Some(Duration::from_millis(50))
        );
        assert_eq!(
            schedule.next_poll_delay(started_at + Duration::from_millis(250)),
            None
        );
    }

    #[test]
    fn zero_timeout_schedule_has_no_followup_poll() {
        let started_at = Instant::now();
        let schedule = MagpieReadinessSchedule {
            started_at,
            timeout: Duration::ZERO,
        };

        assert_eq!(schedule.next_poll_delay(started_at), None);
    }

    fn utf16_name(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    #[test]
    fn magpie_process_match_ignores_ascii_case_and_stops_at_the_terminator() {
        assert!(matches_process_name_ascii_case_insensitive(
            &utf16_name("Magpie.exe"),
            "Magpie.exe"
        ));
        assert!(matches_process_name_ascii_case_insensitive(
            &utf16_name("MAGPIE.EXE"),
            "Magpie.exe"
        ));

        let mut name_with_trailing_units = utf16_name("Magpie.exe");
        name_with_trailing_units.extend("other.exe".encode_utf16());
        assert!(matches_process_name_ascii_case_insensitive(
            &name_with_trailing_units,
            "Magpie.exe"
        ));
    }

    #[test]
    fn magpie_process_match_rejects_prefix_suffix_and_non_ascii_substitutions() {
        for name in ["Other.exe", "Magpie.exe.extra", "Magpie.ex", "Magpié.exe"] {
            assert!(!matches_process_name_ascii_case_insensitive(
                &utf16_name(name),
                "Magpie.exe"
            ));
        }
    }

    #[test]
    fn process_snapshot_errors_are_not_treated_as_magpie_absence() {
        let mut observations =
            [Ok(Some(false)), Err("snapshot read failed".to_string())].into_iter();
        assert_eq!(
            find_process_match(|| observations.next().unwrap()),
            Err("snapshot read failed".to_string())
        );

        let mut checked_running_state = false;
        let mut started = false;
        let result = ensure_running_with(
            || {
                checked_running_state = true;
                Err("process state unavailable".to_string())
            },
            || {
                started = true;
                Ok(())
            },
        );

        assert_eq!(result, Err("process state unavailable".to_string()));
        assert!(checked_running_state);
        assert!(!started);
    }

    #[test]
    fn magpie_starts_only_after_a_complete_snapshot_confirms_absence() {
        let mut observations = [Ok(Some(false)), Ok(None)].into_iter();
        let mut started = false;
        let was_running = ensure_running_with(
            || find_process_match(|| observations.next().unwrap()),
            || {
                started = true;
                Ok(())
            },
        )
        .expect("complete empty snapshot should allow startup");

        assert!(!was_running);
        assert!(started);
    }
}
