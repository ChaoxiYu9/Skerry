pub mod cover;

pub(crate) mod import_path_index;

#[cfg(feature = "tauri-app")]
pub mod files;

#[cfg(feature = "tauri-app")]
pub mod launch;

#[cfg(feature = "tauri-app")]
pub mod monitor;
pub mod scan;

#[cfg(feature = "tauri-app")]
pub mod steam;
