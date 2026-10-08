# -*- coding: utf-8 -*-
import os

filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AddModal\AddModal.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Let's inspect the Single tab stack inside AddModal.tsx
target_dialog_content = '''				<DialogContent
					sx={{ pt: 2, display: activeTab === "single" ? undefined : "none" }}
				>
					{/* single tab 内容：通过 display 控制显隐，避免切换 tab 时卸载 */}
					<Stack spacing={2} sx={{ pt: 1 }}>
						{/* 选择本地可执行文件 */}
						<Stack
							direction={{ xs: "column", sm: "row" }}
							spacing={1.5}
							className="skerry-add-launch-choice-row"
							sx={{
								minWidth: 0,
								"& > .MuiButton-root": {
									minWidth: 0,
									width: "auto",
									flex: { xs: "1 1 100%", sm: "1 1 0" },
								},
							}}
						>
							<Button
								variant={isVirtualGame ? "outlined" : "contained"}
								onClick={() => void handleSelectLaunchFile()}
								startIcon={<FileOpenIcon fontSize="small" />}
								disabled={isBusy}
								className={`rounded-2xl py-2.5 px-4 font-bold text-xs transition-all ${
									!isVirtualGame
										? "bg-gradient-to-r from-[var(--mui-palette-primary-main)] to-[#e06535] text-white shadow-md shadow-[var(--mui-palette-primary-main)]/25 hover:brightness-110"
										: "border border-[var(--mui-palette-divider)] hover:bg-black/5 dark:hover:bg-white/5"
								}`}
							>
								{t("components.AddModal.selectLauncher", "选择启动文件")}
							</Button>
							<Button
								variant={isVirtualGame ? "contained" : "outlined"}
								onClick={handleSelectVirtualGame}
								startIcon={<CloudOffIcon fontSize="small" />}
								disabled={isBusy}
								className={`rounded-2xl py-2.5 px-4 font-bold text-xs transition-all ${
									isVirtualGame
										? "bg-gradient-to-r from-[var(--mui-palette-primary-main)] to-[#e06535] text-white shadow-md shadow-[var(--mui-palette-primary-main)]/25 hover:brightness-110"
										: "border border-[var(--mui-palette-divider)] hover:bg-black/5 dark:hover:bg-white/5"
								}`}
							>
								{t("components.AddModal.virtualGame", "导入虚拟游戏")}
							</Button>
						</Stack>
						<TextField
							fullWidth
							size="small"
							value={
								isVirtualGame
									? t(
											"components.AddModal.virtualGameSelected",
											"虚拟游戏（无本地文件）",
										)
									: launchSelection.kind === "steam"
										? `Steam · ${launchSelection.target.name} · ${formatSteamAppIdWithPath(launchSelection.target.steam_launch_id, launchSelection.target.localpath)}`
										: launchSelection.kind === "local"
											? launchSelection.path
											: ""
							}
							placeholder={t(
								"components.AddModal.dragHint",
								"请选择或拖拽启动文件或文件夹",
							)}
							InputProps={{ readOnly: true }}
						/>
						{/* 添加策略切换 */}
						<Stack spacing={2}>
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
									<Alert severity="info" sx={{ py: 0, px: 1.5 }}>
										{t(
											"components.AddModal.bgmNotLoggedInHint",
											"未登录 Bangumi 账号，部分隐藏条目（如 R18）可能无法被搜索到。",
										)}
									</Alert>
								)}
						</Stack>
						{/* 游戏名称输入框 */}
						<TextField
							required
							size="small"
							id="name"
							name="game-name"
							label={
								addMode === "single"
									? `${t("components.AddModal.gameName", "游戏名称")} / ${t(
											"components.AddModal.gameIDTips",
											"游戏ID",
										)}`
									: t("components.AddModal.gameName", "游戏名称")
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
						/>
					</Stack>
				</DialogContent>'''

new_dialog_content = '''				<DialogContent
					sx={{ pt: 1, display: activeTab === "single" ? undefined : "none" }}
				>
					{/* single tab 内容：Skerry Bento 风格插槽 */}
					<Stack spacing={2.5} sx={{ pt: 1 }}>
						{/* Bento 1: 启动与可执行文件槽 */}
						<Box className="p-3.5 rounded-2xl bg-black/[0.02] dark:bg-white/[0.02] border border-[var(--mui-palette-divider)]/40 flex flex-col gap-3">
							<Box className="flex items-center justify-between">
								<Box className="flex items-center gap-1.5">
									<SportsEsportsRoundedIcon fontSize="small" className="text-[var(--mui-palette-primary-main)] opacity-80" />
									<Typography variant="caption" className="font-bold text-xs text-[var(--mui-palette-text-primary)]">
										{t("components.AddModal.launcherSlotTitle", "启动源与游戏目标")}
									</Typography>
								</Box>
								{isVirtualGame ? (
									<Box className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20">
										<Box className="w-1.5 h-1.5 rounded-full bg-amber-500" />
										{t("components.AddModal.virtualGameSelected", "虚拟游戏")}
									</Box>
								) : launchSelection.kind === "steam" ? (
									<Box className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-sky-500/10 text-sky-500 border border-sky-500/20">
										<Box className="w-1.5 h-1.5 rounded-full bg-sky-500" />
										Steam 关联
									</Box>
								) : launchSelection.kind === "local" ? (
									<Box className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
										<Box className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
										{t("components.AddModal.localConfigured", "已指定本地路径")}
									</Box>
								) : (
									<Box className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-black/5 dark:bg-white/5 text-[var(--mui-palette-text-secondary)] border border-[var(--mui-palette-divider)]/30">
										<Box className="w-1.5 h-1.5 rounded-full bg-[var(--mui-palette-text-secondary)]" />
										{t("components.AddModal.notConfigured", "未选择启动项")}
									</Box>
								)}
							</Box>

							{/* 路径显示条 */}
							<Box className="px-3 py-2 rounded-xl bg-black/[0.04] dark:bg-black/30 border border-[var(--mui-palette-divider)]/30 flex items-center gap-2">
								{isVirtualGame ? (
									<CloudOffIcon fontSize="small" className="text-amber-500 shrink-0" />
								) : (
									<FileOpenIcon fontSize="small" className="text-[var(--mui-palette-text-secondary)] shrink-0" />
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
									className={`flex-1 rounded-xl py-2 px-4 font-bold text-xs transition-all ${
										!isVirtualGame
											? "bg-gradient-to-r from-[var(--mui-palette-primary-main)] to-[#e06535] text-white shadow-md shadow-[var(--mui-palette-primary-main)]/25 hover:brightness-110"
											: "border border-[var(--mui-palette-divider)] hover:bg-black/5 dark:hover:bg-white/5 text-[var(--mui-palette-text-primary)]"
									}`}
								>
									{t("components.AddModal.selectLauncher", "选择启动文件")}
								</Button>
								<Button
									variant={isVirtualGame ? "contained" : "outlined"}
									onClick={handleSelectVirtualGame}
									startIcon={<CloudOffIcon fontSize="small" />}
									disabled={isBusy}
									className={`flex-1 rounded-xl py-2 px-4 font-bold text-xs transition-all ${
										isVirtualGame
											? "bg-gradient-to-r from-[var(--mui-palette-primary-main)] to-[#e06535] text-white shadow-md shadow-[var(--mui-palette-primary-main)]/25 hover:brightness-110"
											: "border border-[var(--mui-palette-divider)] hover:bg-black/5 dark:hover:bg-white/5 text-[var(--mui-palette-text-primary)]"
									}`}
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
									},
								}}
							/>
						</Box>
					</Stack>
				</DialogContent>'''

if target_dialog_content in content:
    content = content.replace(target_dialog_content, new_dialog_content, 1)
    print("AddModal DialogContent successfully replaced.")
else:
    print("Warning: target_dialog_content not found in AddModal.tsx")

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)
print("Finished AddModal.tsx update.")
