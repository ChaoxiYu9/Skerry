use crate::utils::command_ext::CommandGuiExt;
use std::process::Command;
use std::time::Duration;

use log::debug;
use windows::{
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM, WPARAM},
        System::Diagnostics::ToolHelp::{
            CREATE_TOOLHELP_SNAPSHOT_FLAGS, CreateToolhelp32Snapshot, PROCESSENTRY32W,
            Process32FirstW, Process32NextW,
        },
        UI::WindowsAndMessaging::{FindWindowExW, HWND_MESSAGE, PostMessageW, WM_HOTKEY},
    },
    core::{PCWSTR, w},
};

const MAGPIE_FULLSCREEN_SCALE_ACTION: usize = 0;

pub fn ensure_running(magpie_path: &str) -> Result<bool, String> {
    let was_running = is_process_running("Magpie.exe");
    if was_running {
        return Ok(true);
    }

    let mut command = Command::new(magpie_path);
    command.arg("-t");
    command
        .gui_safe()
        .spawn()
        .map_err(|e| format!("启动 Magpie 失败: {e}"))?;

    Ok(false)
}

pub async fn wait_until_ready(timeout: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;

    loop {
        if find_hotkey_window().is_ok() {
            debug!("Magpie_Hotkey 已就绪");
            return Ok(());
        }

        if std::time::Instant::now() >= deadline {
            return Err("等待 Magpie_Hotkey 创建超时".to_string());
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
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

fn is_process_running(process_name: &str) -> bool {
    unsafe {
        let snapshot =
            match CreateToolhelp32Snapshot(CREATE_TOOLHELP_SNAPSHOT_FLAGS(0x0000_0002), 0) {
                Ok(handle) if !handle.is_invalid() => handle,
                _ => return false,
            };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        let mut found = false;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name_end = entry
                    .szExeFile
                    .iter()
                    .position(|&character| character == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_end]);
                if name.eq_ignore_ascii_case(process_name) {
                    found = true;
                    break;
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
        found
    }
}
