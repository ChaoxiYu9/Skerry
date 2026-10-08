# -*- coding: utf-8 -*-
import os

filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\Collection\CollectionPickerDialog.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

old_dialog = '''		<Dialog
			open={open}
			onClose={handleClose}
			closeAfterTransition={false}
			fullWidth
			maxWidth="xs"
			aria-labelledby="collection-picker-dialog-title"
		>'''

new_dialog = '''		<Dialog
			open={open}
			onClose={handleClose}
			closeAfterTransition={false}
			fullWidth
			maxWidth="xs"
			aria-labelledby="collection-picker-dialog-title"
			slotProps={{
				paper: {
					className: "rounded-[28px] border border-[var(--mui-palette-divider)]/40 shadow-2xl overflow-hidden backdrop-blur-2xl",
				},
			}}
		>'''

if old_dialog in content:
    content = content.replace(old_dialog, new_dialog, 1)
    print("CollectionPickerDialog Dialog replaced.")
else:
    print("Warning: old_dialog not found in CollectionPickerDialog.tsx")

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)
print("Finished CollectionPickerDialog.tsx update.")
