# -*- coding: utf-8 -*-
import os

# 1. Patch InputDialog.tsx
input_dialog_path = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\InputDialog.tsx"
with open(input_dialog_path, "r", encoding="utf-8") as f:
    c = f.read()

old_id = '<Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>'
new_id = '''<Dialog
			open={open}
			onClose={handleClose}
			maxWidth="xs"
			fullWidth
			slotProps={{
				paper: {
					className: "rounded-[28px] border border-[var(--mui-palette-divider)]/40 shadow-2xl overflow-hidden backdrop-blur-2xl",
				},
			}}
		>'''
if old_id in c:
    c = c.replace(old_id, new_id, 1)
    with open(input_dialog_path, "w", encoding="utf-8") as f:
        f.write(c)
    print("InputDialog.tsx updated.")
else:
    print("Warning: old_id not found in InputDialog.tsx")

# 2. Patch AlertBox.tsx
alert_box_path = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AlertBox.tsx"
with open(alert_box_path, "r", encoding="utf-8") as f:
    c = f.read()

old_ab = '''		<Dialog
			open={open}
			onClose={handleClose}
			className={dialogClassName}
			aria-labelledby="alert-dialog-title"
			aria-describedby="alert-dialog-description"
		>'''

new_ab = '''		<Dialog
			open={open}
			onClose={handleClose}
			className={dialogClassName}
			aria-labelledby="alert-dialog-title"
			aria-describedby="alert-dialog-description"
			slotProps={{
				paper: {
					className: "rounded-[28px] border border-[var(--mui-palette-divider)]/40 shadow-2xl overflow-hidden backdrop-blur-2xl p-1.5",
				},
			}}
		>'''

if old_ab in c:
    c = c.replace(old_ab, new_ab, 1)
    with open(alert_box_path, "w", encoding="utf-8") as f:
        f.write(c)
    print("AlertBox.tsx updated.")
else:
    print("Warning: old_ab not found in AlertBox.tsx")

# 3. Patch GameSelectDialog.tsx
gs_path = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AddModal\GameSelectDialog.tsx"
with open(gs_path, "r", encoding="utf-8") as f:
    c = f.read()

old_gs = '''		<Dialog
			open={open}
			onClose={onClose}
			maxWidth="md"
			fullWidth
			aria-labelledby="game-select-dialog-title"
		>'''

new_gs = '''		<Dialog
			open={open}
			onClose={onClose}
			maxWidth="md"
			fullWidth
			aria-labelledby="game-select-dialog-title"
			slotProps={{
				paper: {
					className: "rounded-[28px] border border-[var(--mui-palette-divider)]/40 shadow-2xl overflow-hidden backdrop-blur-2xl",
				},
			}}
		>'''

if old_gs in c:
    c = c.replace(old_gs, new_gs, 1)
    with open(gs_path, "w", encoding="utf-8") as f:
        f.write(c)
    print("GameSelectDialog.tsx updated.")
else:
    print("Warning: old_gs not found in GameSelectDialog.tsx")

# 4. Patch MixedSourceConfirmDialog.tsx
ms_path = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AddModal\MixedSourceConfirmDialog.tsx"
with open(ms_path, "r", encoding="utf-8") as f:
    c = f.read()

old_ms = '''		<Dialog
			open={open}
			onClose={onClose}
			maxWidth={dialogMaxWidth}
			fullWidth
			aria-labelledby="mixed-source-confirm-dialog-title"
		>'''

new_ms = '''		<Dialog
			open={open}
			onClose={onClose}
			maxWidth={dialogMaxWidth}
			fullWidth
			aria-labelledby="mixed-source-confirm-dialog-title"
			slotProps={{
				paper: {
					className: "rounded-[28px] border border-[var(--mui-palette-divider)]/40 shadow-2xl overflow-hidden backdrop-blur-2xl",
				},
			}}
		>'''

if old_ms in c:
    c = c.replace(old_ms, new_ms, 1)
    with open(ms_path, "w", encoding="utf-8") as f:
        f.write(c)
    print("MixedSourceConfirmDialog.tsx updated.")
else:
    print("Warning: old_ms not found in MixedSourceConfirmDialog.tsx")
