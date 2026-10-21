//! Domain-oriented Tauri command adapters for database operations.
mod collections;
mod games;
mod savedata;
mod settings;
mod stats;

pub use collections::*;
pub use games::*;
pub use savedata::*;
pub use settings::*;
pub use stats::*;
