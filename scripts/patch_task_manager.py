# -*- coding: utf-8 -*-
import os

filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\TaskManagerDialog.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Let's inspect Dialog and Paper rendering in TaskManagerDialog.tsx
old_dialog_start = '''		<Dialog
			open={open}
			onClose={onClose}
			fullWidth
			maxWidth="md"
			PaperProps={{
				sx: { maxHeight: "80vh" },
			}}
		>'''

new_dialog_start = '''		<Dialog
			open={open}
			onClose={onClose}
			fullWidth
			maxWidth="md"
			slotProps={{
				paper: {
					className: "rounded-[28px] border border-[var(--mui-palette-divider)]/40 shadow-2xl overflow-hidden backdrop-blur-2xl",
					sx: { maxHeight: "82vh" },
				},
			}}
		>'''

if old_dialog_start in content:
    content = content.replace(old_dialog_start, new_dialog_start, 1)
    print("TaskManagerDialog Dialog replaced.")
else:
    print("Warning: old_dialog_start not found in TaskManagerDialog.tsx")

# Let's upgrade the task card Paper
old_task_paper = '''											<Paper
												key={task.id}
												variant="outlined"
												className="rounded-xl p-4"
											>'''

new_task_paper = '''											<Paper
												key={task.id}
												variant="outlined"
												className="rounded-2xl p-4 border border-[var(--mui-palette-divider)]/40 bg-black/[0.02] dark:bg-white/[0.02] hover:border-[var(--mui-palette-primary-main)]/40 transition-all shadow-sm"
											>'''

if old_task_paper in content:
    content = content.replace(old_task_paper, new_task_paper, 1)
    print("TaskManagerDialog task paper replaced.")
else:
    print("Warning: old_task_paper not found in TaskManagerDialog.tsx")

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)
print("Finished TaskManagerDialog.tsx update.")
