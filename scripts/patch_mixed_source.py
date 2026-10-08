# -*- coding: utf-8 -*-
filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AddModal\MixedSourceConfirmDialog.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

old_dialog = '''			<Dialog
				open={open}
				onClose={loading ? undefined : onClose}
				maxWidth={getDialogMaxWidth(availableSources.length)}
				fullWidth
				aria-labelledby="mixed-source-confirm-dialog-title"
			>'''

new_dialog = '''			<Dialog
				open={open}
				onClose={loading ? undefined : onClose}
				maxWidth={getDialogMaxWidth(availableSources.length)}
				fullWidth
				aria-labelledby="mixed-source-confirm-dialog-title"
				slotProps={{
					paper: {
						className: "rounded-[28px] border border-[var(--mui-palette-divider)]/40 shadow-2xl overflow-hidden backdrop-blur-2xl",
					},
				}}
			>'''

if old_dialog in content:
    content = content.replace(old_dialog, new_dialog, 1)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    print("MixedSourceConfirmDialog.tsx updated successfully.")
else:
    print("Warning: old_dialog not found in MixedSourceConfirmDialog.tsx")
