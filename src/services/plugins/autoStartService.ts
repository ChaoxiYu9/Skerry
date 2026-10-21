import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

type AutostartAdapter = {
	isEnabled: typeof isEnabled;
	enable: typeof enable;
	disable: typeof disable;
};

const plugin: AutostartAdapter = { isEnabled, enable, disable };

export function getAutostartEnabled(adapter: AutostartAdapter = plugin) {
	return adapter.isEnabled();
}

export async function setAutostartEnabled(
	enabled: boolean,
	adapter: AutostartAdapter = plugin,
): Promise<boolean> {
	const current = await adapter.isEnabled();
	if (current === enabled) {
		return current;
	}

	if (enabled) {
		await adapter.enable();
	} else {
		await adapter.disable();
	}

	return enabled;
}
