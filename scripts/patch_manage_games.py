# -*- coding: utf-8 -*-
import os

filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\Collection\ManageGamesDialog.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

old_dialog = '<Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>'
new_dialog = '''<Dialog
			open={open}
			onClose={onClose}
			maxWidth="lg"
			fullWidth
			slotProps={{
				paper: {
					className: "rounded-[28px] border border-[var(--mui-palette-divider)]/40 shadow-2xl overflow-hidden backdrop-blur-2xl",
				},
			}}
		>'''

if old_dialog in content:
    content = content.replace(old_dialog, new_dialog, 1)
    print("ManageGamesDialog Dialog replaced.")
else:
    print("Warning: old_dialog not found in ManageGamesDialog.tsx")

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)
print("Finished ManageGamesDialog.tsx update.")
