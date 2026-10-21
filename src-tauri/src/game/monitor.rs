mod session;

#[cfg(target_os = "windows")]
mod windows;

pub use session::TimeTrackingMode;

#[cfg(target_os = "windows")]
pub use windows::*;
