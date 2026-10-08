# -*- coding: utf-8 -*-
path = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\PathSettingsModal.tsx"
with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

new_lines = [
    line for line in lines
    if "CheckCircleRoundedIcon" not in line and "FileOpenRoundedIcon" not in line
]

with open(path, "w", encoding="utf-8") as f:
    f.writelines(new_lines)

print("Cleaned unused imports from PathSettingsModal.tsx successfully.")
