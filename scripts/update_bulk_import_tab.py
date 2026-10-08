# -*- coding: utf-8 -*-
import os

filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AddModal\BulkImportTab.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Update Scan Steam and Select Folder buttons
old_steam_btn = 'className="rounded-xl px-4 py-2 text-xs font-bold text-white bg-gradient-to-r from-[var(--mui-palette-primary-main)] to-[#e06535] shadow-md shadow-[var(--mui-palette-primary-main)]/25 hover:brightness-110"'
new_primary_btn_sx = '''sx={{
										borderRadius: "12px",
										px: 2.5,
										py: 0.8,
										fontSize: "0.75rem",
										fontWeight: 700,
										color: "#ffffff",
										background: "linear-gradient(135deg, #E05220 0%, #F16E36 100%)",
										boxShadow: "0 2px 8px rgba(224, 82, 32, 0.25)",
										textTransform: "none",
										"&:hover": { filter: "brightness(1.06)" },
									}}'''

if old_steam_btn in content:
    content = content.replace(old_steam_btn, new_primary_btn_sx, 1)
    print("Replaced steam btn.")

old_folder_btn = 'className="shrink-0 rounded-xl px-4 py-2 text-xs font-bold text-white bg-gradient-to-r from-[var(--mui-palette-primary-main)] to-[#e06535] shadow-md shadow-[var(--mui-palette-primary-main)]/25 hover:brightness-110"'
if old_folder_btn in content:
    content = content.replace(old_folder_btn, new_primary_btn_sx, 1)
    print("Replaced folder btn.")

# 2. Update import matched button
old_import_matched = '''						className="rounded-2xl px-6 py-2 font-black text-xs text-white bg-gradient-to-r from-[var(--mui-palette-primary-main)] to-[#e06535] shadow-lg shadow-[var(--mui-palette-primary-main)]/30 hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"'''
new_import_matched = '''						sx={{
							borderRadius: "12px",
							px: 3,
							py: 1,
							fontSize: "0.8125rem",
							fontWeight: 800,
							color: "#ffffff",
							background: "linear-gradient(135deg, #E05220 0%, #F16E36 100%)",
							boxShadow: "0 4px 14px rgba(224, 82, 32, 0.28)",
							textTransform: "none",
							"&:hover": { filter: "brightness(1.06)" },
							"&:active": { transform: "scale(0.98)" },
							"&.Mui-disabled": {
								background: "rgba(0, 0, 0, 0.08)",
								color: "rgba(0, 0, 0, 0.26)",
								boxShadow: "none",
							},
						}}'''

if old_import_matched in content:
    content = content.replace(old_import_matched, new_import_matched, 1)
    print("Replaced import matched btn.")

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)

print("Finished updating BulkImportTab.tsx")
