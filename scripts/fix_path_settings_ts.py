# -*- coding: utf-8 -*-
filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\PathSettingsModal.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# 1. inSettingsPage
content = content.replace("inSettingsPage = true,", "_inSettingsPage = true,")

# 2. settings.save_path -> settings.save_root_path
content = content.replace("savePath: settings.save_path || \"\",", "savePath: settings.save_root_path || \"\",")

# 3. fileService.openPath(dirname(path)) -> fileService.openDirectory(dirname(path))
content = content.replace("await fileService.openPath(dirname(path));", "await fileService.openDirectory(dirname(path));")

# 4. payloadKeyMap in handleCommitPath
old_key_map = '''			const payloadKeyMap: Record<PathSettingsStringKey, string> = {
				installRootPath: "install_root_path",
				savePath: "save_path",
				lePath: "le_path",
				magpiePath: "magpie_path",
				dbBackupPath: "db_backup_path",
				detailBackdropPath: "detail_backdrop_path",
			};'''

new_key_map = '''			const payloadKeyMap: Record<PathSettingsStringKey, keyof import("@/types").UpdateSettingsParams> = {
				installRootPath: "installRootPath",
				savePath: "saveRootPath",
				lePath: "lePath",
				magpiePath: "magpiePath",
				dbBackupPath: "dbBackupPath",
				detailBackdropPath: "detailBackdropPath",
			};'''

content = content.replace(old_key_map, new_key_map)

# 5. handleToggleTool payloadKey
old_toggle = 'const payloadKey = key === "defaultLeLaunch" ? "default_le_launch" : "default_magpie";'
new_toggle = 'const payloadKey = key === "defaultLeLaunch" ? "defaultLeLaunch" : "defaultMagpie";'
content = content.replace(old_toggle, new_toggle)

# 6. handleSaveAll keys
old_save_all = '''			await updateSettingsMutation.mutateAsync({
				install_root_path: draft.installRootPath.trim() || null,
				save_path: draft.savePath.trim() || null,
				le_path: draft.lePath.trim() || null,
				magpie_path: draft.magpiePath.trim() || null,
				db_backup_path: draft.dbBackupPath.trim() || null,
				detail_backdrop_path: draft.detailBackdropPath.trim() || null,
				default_le_launch: draft.defaultLeLaunch,
				default_magpie: draft.defaultMagpie,
			});'''

new_save_all = '''			await updateSettingsMutation.mutateAsync({
				installRootPath: draft.installRootPath.trim() || null,
				saveRootPath: draft.savePath.trim() || null,
				lePath: draft.lePath.trim() || null,
				magpiePath: draft.magpiePath.trim() || null,
				dbBackupPath: draft.dbBackupPath.trim() || null,
				detailBackdropPath: draft.detailBackdropPath.trim() || null,
				defaultLeLaunch: draft.defaultLeLaunch,
				defaultMagpie: draft.defaultMagpie,
			});'''

content = content.replace(old_save_all, new_save_all)

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)

print("Updated PathSettingsModal.tsx successfully.")
