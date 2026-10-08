# -*- coding: utf-8 -*-
import os

filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AddModal\AddModal.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Let's replace the single tab content in AddModal.tsx
target_start = '''				<DialogContent
					sx={{ pt: 1, display: activeTab === "single" ? undefined : "none" }}
				>'''

target_end = '''				{/* bulk tab：始终挂载，通过 hidden prop 控制显隐，保持状态在 tab 切换时不丢失 */}'''

idx_start = content.find(target_start)
idx_end = content.find(target_end)

if idx_start != -1 and idx_end != -1:
    new_content_block = '''				<DialogContent
					sx={{ pt: 2, display: activeTab === "single" ? undefined : "none" }}
				>
					{/* single tab 内容：Skerry Bento 风格插槽 */}
					<Stack spacing={2} sx={{ pt: 0.5 }}>
						{/* Bento 1: 启动源与游戏目标 */}
						<Box className="p-3.5 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] border border-[var(--mui-palette-divider)]/40 flex flex-col gap-3">
							<Box className="flex items-center justify-between">
								<Box className="flex items-center gap-1.5">
									<SportsEsportsRoundedIcon sx={{ fontSize: 18, color: "#E05220" }} />
									<Typography variant="caption" className="font-bold text-xs text-[var(--mui-palette-text-primary)]">
										{t("components.AddModal.launcherSlotTitle", "启动源与游戏目标")}
									</Typography>
								</Box>
								{isVirtualGame ? (
									<Box className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
										<Box className="w-1.5 h-1.5 rounded-full bg-amber-500" />
										{t("components.AddModal.virtualGameSelected", "虚拟游戏")}
									</Box>
								) : launchSelection.kind === "steam" ? (
									<Box className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
										<Box className="w-1.5 h-1.5 rounded-full bg-sky-500" />
										Steam 关联
									</Box>
								) : launchSelection.kind === "local" ? (
									<Box className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
										<Box className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
										{t("components.AddModal.localConfigured", "已指定本地路径")}
									</Box>
								) : (
									<Box className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-neutral-500/10 text-neutral-500 dark:text-neutral-400 border border-neutral-500/20">
										<Box className="w-1.5 h-1.5 rounded-full bg-neutral-400" />
										{t("components.AddModal.notConfigured", "未选择启动项")}
									</Box>
								)}
							</Box>

							{/* 路径显示条 */}
							<Box className="px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-black/30 border border-[var(--mui-palette-divider)]/40 flex items-center gap-2">
								{isVirtualGame ? (
									<CloudOffIcon sx={{ fontSize: 18, color: "#F59E0B", shrink: 0 }} />
								) : (
									<FileOpenIcon sx={{ fontSize: 18, color: "text.secondary", opacity: 0.8, shrink: 0 }} />
								)}
								<Typography
									variant="body2"
									className="font-mono text-xs truncate flex-1 text-[var(--mui-palette-text-primary)]"
								>
									{isVirtualGame
										? t("components.AddModal.virtualGameSelected", "虚拟游戏（无本地文件）")
										: launchSelection.kind === "steam"
											? `Steam · ${launchSelection.target.name} · ${formatSteamAppIdWithPath(launchSelection.target.steam_launch_id, launchSelection.target.localpath)}`
											: launchSelection.kind === "local"
												? launchSelection.path
												: t("components.AddModal.dragHint", "请选择启动程序或直接拖拽文件/文件夹到此窗口")}
								</Typography>
							</Box>

							{/* 操作按键列 */}
							<Stack direction="row" spacing={1.5}>
								<Button
									variant={!isVirtualGame ? "contained" : "outlined"}
									onClick={() => void handleSelectLaunchFile()}
									startIcon={<FileOpenIcon fontSize="small" />}
									disabled={isBusy}
									sx={{
										flex: 1,
										borderRadius: "12px",
										py: 1,
										px: 2,
										fontSize: "0.75rem",
										fontWeight: 700,
										textTransform: "none",
										...(!isVirtualGame
											? {
													color: "#ffffff",
													background: "linear-gradient(135deg, #E05220 0%, #F16E36 100%)",
													boxShadow: "0 2px 8px rgba(224, 82, 32, 0.25)",
													"&:hover": { filter: "brightness(1.06)" },
												}
											: {
													borderColor: "var(--mui-palette-divider)",
													color: "var(--mui-palette-text-primary)",
													"&:hover": { backgroundColor: "rgba(0, 0, 0, 0.04)" },
												}),
									}}
								>
									{t("components.AddModal.selectLauncher", "选择启动文件")}
								</Button>
								<Button
									variant={isVirtualGame ? "contained" : "outlined"}
									onClick={handleSelectVirtualGame}
									startIcon={<CloudOffIcon fontSize="small" />}
									disabled={isBusy}
									sx={{
										flex: 1,
										borderRadius: "12px",
										py: 1,
										px: 2,
										fontSize: "0.75rem",
										fontWeight: 700,
										textTransform: "none",
										...(isVirtualGame
											? {
													color: "#ffffff",
													background: "linear-gradient(135deg, #E05220 0%, #F16E36 100%)",
													boxShadow: "0 2px 8px rgba(224, 82, 32, 0.25)",
													"&:hover": { filter: "brightness(1.06)" },
												}
											: {
													borderColor: "var(--mui-palette-divider)",
													color: "var(--mui-palette-text-primary)",
													"&:hover": { backgroundColor: "rgba(0, 0, 0, 0.04)" },
												}),
									}}
								>
									{t("components.AddModal.virtualGame", "导入虚拟游戏")}
								</Button>
							</Stack>
						</Box>

						{/* Bento 2: 元数据检索策略槽 */}
						<Box className="p-3.5 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] border border-[var(--mui-palette-divider)]/40 flex flex-col gap-2.5">
							<Typography variant="caption" className="font-bold text-xs text-[var(--mui-palette-text-primary)]">
								{t("components.AddModal.metadataStrategyTitle", "元数据与抓取模式")}
							</Typography>
							<AddGameModeToggleGroup
								value={addMode}
								onChange={setAddMode}
								disabled={isBusy}
								sx={{ width: "100%" }}
							/>
							{addMode === "single" && (
								<SingleSourceSelect
									value={apiSource}
									onChange={setApiSource}
									disabled={isBusy}
								/>
							)}
							{!hasBgmAuth &&
								((addMode === "single" && apiSource === "bgm") ||
									(addMode === "mixed" &&
										mixedEnabledSources.includes("bgm"))) && (
									<Alert severity="info" sx={{ py: 0.5, px: 1.5, borderRadius: "12px" }}>
										{t(
											"components.AddModal.bgmNotLoggedInHint",
											"未登录 Bangumi 账号，部分隐藏条目（如 R18）可能无法被搜索到。",
										)}
									</Alert>
								)}
						</Box>

						{/* Bento 3: 游戏名称检索输入框 */}
						<Box className="p-3.5 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] border border-[var(--mui-palette-divider)]/40 flex flex-col gap-2">
							<Typography variant="caption" className="font-bold text-xs text-[var(--mui-palette-text-primary)]">
								{addMode === "single"
									? `${t("components.AddModal.gameName", "游戏名称")} / ${t("components.AddModal.gameIDTips", "游戏ID")}`
									: t("components.AddModal.gameName", "游戏名称")}
							</Typography>
							<TextField
								required
								size="small"
								id="name"
								name="game-name"
								placeholder={
									addMode === "single"
										? "输入游戏名称或数字ID，按回车快速搜索"
										: "输入游戏名称进行智能匹配，按回车开始"
								}
								type="text"
								fullWidth
								variant="outlined"
								autoComplete="off"
								value={formText}
								onChange={(event) => setFormText(event.target.value)}
								onKeyDown={(event) => {
									if (
										event.key !== "Enter" ||
										event.nativeEvent.isComposing ||
										formText === "" ||
										isBusy
									) {
										return;
									}

									event.preventDefault();
									void handleSubmit();
								}}
								sx={{
									"& .MuiOutlinedInput-root": {
										borderRadius: "14px",
										backgroundColor: "rgba(0, 0, 0, 0.02)",
										"&:hover": {
											backgroundColor: "rgba(0, 0, 0, 0.03)",
										},
									},
								}}
							/>
						</Box>
					</Stack>
				</DialogContent>
'''
    content = content[:idx_start] + new_content_block + content[idx_end:]
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    print("AddModal Single tab block replaced successfully.")
else:
    print("Target boundaries not found in AddModal.tsx")
