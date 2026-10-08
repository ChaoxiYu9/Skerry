# -*- coding: utf-8 -*-
import os

filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AddModal\AddModal.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Let's find DialogTitle and Tab Switcher in AddModal.tsx
old_section = '''				<DialogTitle className="flex items-center justify-between pb-2 px-6 pt-5">
					<Box className="flex items-center gap-2.5">
						<Box className="w-9 h-9 rounded-xl flex items-center justify-center bg-[var(--mui-palette-primary-main)]/10 text-[var(--mui-palette-primary-main)] border border-[var(--mui-palette-primary-main)]/20">
							<SportsEsportsRoundedIcon fontSize="small" />
						</Box>
						<Box>
							<Typography variant="h6" className="font-black text-base tracking-tight leading-tight">
								{t("components.AddModal.addGame", "添加游戏")}
							</Typography>
							<Typography variant="caption" color="text.secondary" className="block text-[11px] font-medium">
								{t("components.AddModal.addGameSubtitle", "支持多源元数据匹配、混合数据源与本地自定义")}
							</Typography>
						</Box>
					</Box>
					<IconButton
						size="small"
						onClick={handleCloseModal}
						disabled={isBusy}
						className="rounded-xl border border-[var(--mui-palette-divider)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
						aria-label="close"
					>
						<CloseRoundedIcon fontSize="small" />
					</IconButton>
				</DialogTitle>

				{/* 现代分段胶囊 Tab 选择器 */}
				<Box className="px-6 pt-1 pb-2">
					<Box className="flex items-center p-1 rounded-2xl bg-black/5 dark:bg-white/[0.04] border border-[var(--mui-palette-divider)]/40 gap-1.5">
						<ButtonBase
							onClick={() => setActiveTab("single")}
							disabled={isBusy}
							className={`flex-1 py-2 px-4 rounded-xl text-xs font-bold transition-all ${
								activeTab === "single"
									? "bg-[var(--mui-palette-primary-main)] text-white shadow-md shadow-[var(--mui-palette-primary-main)]/30 font-black"
									: "text-[var(--mui-palette-text-secondary)] hover:text-[var(--mui-palette-text-primary)] hover:bg-black/5 dark:hover:bg-white/5"
							}`}
						>
							{t("components.AddModal.singleTab", "单个添加")}
						</ButtonBase>
						<ButtonBase
							onClick={() => setActiveTab("bulk")}
							disabled={isBusy}
							className={`flex-1 py-2 px-4 rounded-xl text-xs font-bold transition-all ${
								activeTab === "bulk"
									? "bg-[var(--mui-palette-primary-main)] text-white shadow-md shadow-[var(--mui-palette-primary-main)]/30 font-black"
									: "text-[var(--mui-palette-text-secondary)] hover:text-[var(--mui-palette-text-primary)] hover:bg-black/5 dark:hover:bg-white/5"
							}`}
						>
							{t("components.AddModal.bulkTab", "批量导入")}
						</ButtonBase>
					</Box>
				</Box>'''

new_section = '''				<DialogTitle className="flex items-center justify-between pb-3 px-6 pt-5 border-b border-[var(--mui-palette-divider)]/25">
					<Box className="flex items-center gap-3">
						<Box
							sx={{
								width: 36,
								height: 36,
								borderRadius: "12px",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								backgroundColor: "rgba(224, 82, 32, 0.1)",
								color: "#E05220",
								border: "1px solid rgba(224, 82, 32, 0.2)",
							}}
						>
							<SportsEsportsRoundedIcon fontSize="small" />
						</Box>
						<Box>
							<Typography variant="h6" className="font-black text-base tracking-tight leading-tight text-[var(--mui-palette-text-primary)]">
								{t("components.AddModal.addGame", "添加游戏")}
							</Typography>
							<Typography variant="caption" color="text.secondary" className="block text-[11px] font-medium mt-0.5">
								{t("components.AddModal.addGameSubtitle", "支持多源元数据匹配、混合数据源与本地自定义")}
							</Typography>
						</Box>
					</Box>
					<IconButton
						size="small"
						onClick={handleCloseModal}
						disabled={isBusy}
						className="rounded-xl border border-[var(--mui-palette-divider)]/40 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
						aria-label="close"
					>
						<CloseRoundedIcon fontSize="small" />
					</IconButton>
				</DialogTitle>

				{/* 悬浮滑轨 Tab 选择器 */}
				<Box className="px-6 pt-3 pb-1">
					<Box className="flex items-center p-1 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] border border-[var(--mui-palette-divider)]/30 gap-1.5">
						<ButtonBase
							onClick={() => setActiveTab("single")}
							disabled={isBusy}
							className={`flex-1 py-1.5 px-4 rounded-xl text-xs transition-all ${
								activeTab === "single"
									? "bg-white dark:bg-white/10 text-[#E05220] dark:text-white shadow-sm border border-black/5 dark:border-white/10 font-black"
									: "text-[var(--mui-palette-text-secondary)] hover:text-[var(--mui-palette-text-primary)] font-semibold"
							}`}
						>
							{t("components.AddModal.singleTab", "单个添加")}
						</ButtonBase>
						<ButtonBase
							onClick={() => setActiveTab("bulk")}
							disabled={isBusy}
							className={`flex-1 py-1.5 px-4 rounded-xl text-xs transition-all ${
								activeTab === "bulk"
									? "bg-white dark:bg-white/10 text-[#E05220] dark:text-white shadow-sm border border-black/5 dark:border-white/10 font-black"
									: "text-[var(--mui-palette-text-secondary)] hover:text-[var(--mui-palette-text-primary)] font-semibold"
							}`}
						>
							{t("components.AddModal.bulkTab", "批量导入")}
						</ButtonBase>
					</Box>
				</Box>'''

if old_section in content:
    content = content.replace(old_section, new_section, 1)
    print("AddModal title & tab section updated successfully.")
else:
    print("Warning: old_section not found in AddModal.tsx")

# Now update the Single Tab buttons inside DialogActions
old_dialog_actions = '''				{activeTab === "single" && (
					<DialogActions className="px-6 py-4 flex items-center justify-end gap-3 border-t border-[var(--mui-palette-divider)]/40">
						{/* 取消按钮 */}
						<Button
							variant="outlined"
							onClick={
								metadataSearchFlow.isSearching
									? cancelOngoingRequest
									: handleCloseModal
							}
							disabled={isAddingGame}
							className="rounded-2xl px-6 py-2 font-bold text-xs border border-[var(--mui-palette-divider)] hover:bg-black/5 dark:hover:bg-white/5"
						>
							{t("components.AddModal.cancel", "取消")}
						</Button>
						{/* 确认按钮 */}
						<Button
							variant="contained"
							onClick={handleSubmit}
							disabled={formText === "" || isBusy}
							startIcon={isBusy ? <CircularProgress size={18} color="inherit" /> : null}
							className="rounded-2xl px-8 py-2 font-black text-xs text-white bg-gradient-to-r from-[var(--mui-palette-primary-main)] to-[#e06535] shadow-lg shadow-[var(--mui-palette-primary-main)]/30 hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
						>
							{isBusy
								? t("components.AddModal.processing", "处理中...")
								: t("components.AddModal.confirm", "确认")}
						</Button>
					</DialogActions>
				)}'''

new_dialog_actions = '''				{activeTab === "single" && (
					<DialogActions className="px-6 py-4 flex items-center justify-end gap-3 border-t border-[var(--mui-palette-divider)]/25">
						<Button
							onClick={
								metadataSearchFlow.isSearching
									? cancelOngoingRequest
									: handleCloseModal
							}
							disabled={isAddingGame}
							className="rounded-xl px-5 py-2 font-semibold text-xs border border-[var(--mui-palette-divider)]/60 hover:bg-black/5 dark:hover:bg-white/5 text-[var(--mui-palette-text-secondary)]"
						>
							{t("components.AddModal.cancel", "取消")}
						</Button>
						<Button
							variant="contained"
							onClick={handleSubmit}
							disabled={formText === "" || isBusy}
							startIcon={isBusy ? <CircularProgress size={16} color="inherit" /> : null}
							sx={{
								borderRadius: "12px",
								px: 3.5,
								py: 1,
								fontWeight: 800,
								fontSize: "0.8125rem",
								color: "#ffffff",
								background: "linear-gradient(135deg, #E05220 0%, #F16E36 100%)",
								boxShadow: "0 4px 14px rgba(224, 82, 32, 0.28)",
								textTransform: "none",
								"&:hover": {
									filter: "brightness(1.06)",
								},
								"&:active": {
									transform: "scale(0.98)",
								},
								"&.Mui-disabled": {
									background: "rgba(0, 0, 0, 0.08)",
									color: "rgba(0, 0, 0, 0.26)",
									boxShadow: "none",
								},
							}}
						>
							{isBusy
								? t("components.AddModal.processing", "处理中...")
								: t("components.AddModal.confirm", "确认")}
						</Button>
					</DialogActions>
				)}'''

if old_dialog_actions in content:
    content = content.replace(old_dialog_actions, new_dialog_actions, 1)
    print("AddModal dialog actions updated successfully.")
else:
    print("Warning: old_dialog_actions not found in AddModal.tsx")

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)
print("Finished AddModal.tsx update.")
