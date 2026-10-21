pub mod common;

#[cfg(target_os = "windows")]
mod magpie;

#[cfg(target_os = "windows")]
mod windows;

pub use common::*;

#[cfg(target_os = "windows")]
pub use windows::*;
