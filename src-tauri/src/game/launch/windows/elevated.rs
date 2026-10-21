//! Windows 提权进程启动适配器（ShellExecuteExW / runas）。

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::GetProcessId;
use windows::Win32::UI::Shell::{
    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::PCWSTR;

fn to_wide_null(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

fn needs_quotes(s: &str) -> bool {
    s.is_empty() || s.chars().any(|c| c.is_whitespace()) || s.contains('"')
}

fn push_backslashes(target: &mut String, count: usize) {
    for _ in 0..count {
        target.push('\\');
    }
}

/// 按 Windows C 运行库命令行规则编码单个参数。
fn quote_arg(arg: &str) -> String {
    if !needs_quotes(arg) {
        return arg.to_string();
    }

    let mut encoded = String::with_capacity(arg.len().saturating_add(2));
    encoded.push('"');

    let mut backslashes = 0;
    for character in arg.chars() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }

        if character == '"' {
            push_backslashes(&mut encoded, backslashes);
            push_backslashes(&mut encoded, backslashes);
            encoded.push('\\');
            encoded.push('"');
        } else {
            push_backslashes(&mut encoded, backslashes);
            encoded.push(character);
        }

        backslashes = 0;
    }

    // Backslashes before the closing quote must be doubled so the quote remains a delimiter.
    push_backslashes(&mut encoded, backslashes);
    push_backslashes(&mut encoded, backslashes);
    encoded.push('"');
    encoded
}

/// 使用 ShellExecuteExW("runas") 启动进程，并返回进程 PID
pub(super) fn shell_execute_runas(
    path: &str,
    args: Option<&[String]>,
    work_dir: &Path,
) -> Result<u32, String> {
    let params_str = if let Some(a) = args {
        a.iter().map(|s| quote_arg(s)).collect::<Vec<_>>().join(" ")
    } else {
        String::new()
    };

    let w_verb = to_wide_null("runas");
    let w_path = to_wide_null(path);
    let w_params = to_wide_null(&params_str);
    let w_dir = to_wide_null(&work_dir.to_string_lossy());

    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI,
        hwnd: Default::default(),
        lpVerb: PCWSTR(w_verb.as_ptr()),
        lpFile: PCWSTR(w_path.as_ptr()),
        lpParameters: PCWSTR(w_params.as_ptr()),
        lpDirectory: PCWSTR(w_dir.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };

    unsafe { ShellExecuteExW(&mut sei) }
        .map_err(|e| format!("ShellExecuteExW(runAs) failed: {}", e))?;

    // 获取 PID 并关闭句柄以避免句柄泄漏
    let pid = unsafe { GetProcessId(sei.hProcess) };
    unsafe {
        let _ = CloseHandle(sei.hProcess);
    } // 忽略关闭错误

    if pid == 0 {
        return Err("Failed to obtain elevated process id".to_string());
    }
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::quote_arg;

    #[test]
    fn leaves_plain_arguments_unquoted() {
        assert_eq!(quote_arg("--fullscreen"), "--fullscreen");
    }

    #[test]
    fn preserves_empty_arguments() {
        assert_eq!(quote_arg(""), r#""""#);
    }

    #[test]
    fn quotes_whitespace_and_keeps_trailing_backslashes() {
        assert_eq!(quote_arg(r"C:\game folder\"), r#""C:\game folder\\""#);
    }

    #[test]
    fn escapes_embedded_quotes_and_preceding_backslashes() {
        assert_eq!(quote_arg(r#"say"hello"#), r#""say\"hello""#);
        assert_eq!(quote_arg(r#"one\"two"#), r#""one\\\"two""#);
    }
}
