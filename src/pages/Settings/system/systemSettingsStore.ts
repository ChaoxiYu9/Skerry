import { load } from "@tauri-apps/plugin-store";

const SETTINGS_STORE_PATH = "settings.json";
export const SILENT_STARTUP_STORE_KEY = "silent_startup";
export const GPU_ACCELERATION_STORE_KEY = "gpu_acceleration";

export const loadSystemSettingsStore = () =>
	load(SETTINGS_STORE_PATH, {
		autoSave: false,
		defaults: {
			[SILENT_STARTUP_STORE_KEY]: false,
		},
	});
