# -*- coding: utf-8 -*-
import os

filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\FilterSortModal.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Update FilterSortDialog
old_fs_dialog = '''function FilterSortDialog({
	open,
	onClose,
	onSubmit,
	titleId,
	title,
	icon,
	children,
}: FilterSortDialogProps) {
	const { t } = useTranslation();

	return (
		<Dialog
			open={open}
			onClose={onClose}
			closeAfterTransition={false}
			aria-labelledby={titleId}
			maxWidth={false}
			slotProps={{
				transition: { timeout: 0 },
				paper: {
					component: "form",
					onSubmit,
					className:
						"skerry-filter-sort-dialog w-[390px] min-w-[390px] max-w-[390px] overflow-hidden",
				},
			}}
		>
			<DialogTitle id={titleId} className="flex items-center gap-2 px-5 py-4">
				{icon}
				<span className="text-base font-600">{title}</span>
			</DialogTitle>
			<DialogContent className="overflow-x-hidden px-5 py-4">
				<div className="w-full min-w-0 flex flex-col gap-4">{children}</div>
			</DialogContent>
			<DialogActions className="px-5 py-3">
				<Button onClick={onClose}>
					{t("components.FilterSortModal.cancel", "取消")}
				</Button>
				<Button type="submit" variant="contained">
					{t("components.FilterSortModal.confirm", "确认")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}'''

new_fs_dialog = '''function FilterSortDialog({
	open,
	onClose,
	onSubmit,
	titleId,
	title,
	icon,
	children,
}: FilterSortDialogProps) {
	const { t } = useTranslation();

	return (
		<Dialog
			open={open}
			onClose={onClose}
			closeAfterTransition={false}
			aria-labelledby={titleId}
			maxWidth={false}
			slotProps={{
				transition: { timeout: 0 },
				paper: {
					component: "form",
					onSubmit,
					className:
						"skerry-filter-sort-dialog w-[400px] min-w-[400px] max-w-[400px] overflow-hidden rounded-[24px] border border-[var(--mui-palette-divider)]/40 shadow-2xl",
				},
			}}
		>
			<DialogTitle id={titleId} className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-[var(--mui-palette-divider)]/30">
				<Box className="flex items-center gap-2.5">
					<Box className="w-8 h-8 rounded-xl flex items-center justify-center bg-[var(--mui-palette-primary-main)]/10 text-[var(--mui-palette-primary-main)] border border-[var(--mui-palette-primary-main)]/20">
						{icon}
					</Box>
					<span className="text-base font-black tracking-tight text-[var(--mui-palette-text-primary)]">{title}</span>
				</Box>
				<IconButton
					size="small"
					onClick={onClose}
					className="rounded-xl border border-[var(--mui-palette-divider)]/40 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
					aria-label="close"
				>
					<CloseIcon fontSize="small" />
				</IconButton>
			</DialogTitle>
			<DialogContent className="overflow-x-hidden px-6 py-4">
				<div className="w-full min-w-0 flex flex-col gap-4">{children}</div>
			</DialogContent>
			<DialogActions className="px-6 py-4 border-t border-[var(--mui-palette-divider)]/30 gap-2.5">
				<Button
					onClick={onClose}
					className="rounded-xl px-5 py-2 font-bold text-xs border border-[var(--mui-palette-divider)]/50 hover:bg-black/5 dark:hover:bg-white/5"
				>
					{t("components.FilterSortModal.cancel", "取消")}
				</Button>
				<Button
					type="submit"
					variant="contained"
					className="rounded-xl px-6 py-2 font-black text-xs text-white bg-gradient-to-r from-[var(--mui-palette-primary-main)] to-[#e06535] shadow-lg shadow-[var(--mui-palette-primary-main)]/25 hover:brightness-110 active:scale-95 transition-all"
				>
					{t("components.FilterSortModal.confirm", "确认")}
				</Button>
			</DialogActions>
		</Dialog>
	);
}'''

if old_fs_dialog in content:
    content = content.replace(old_fs_dialog, new_fs_dialog, 1)
    print("FilterSortDialog replaced successfully.")
else:
    print("Warning: old_fs_dialog not found in FilterSortModal.tsx")

# 2. Fix multi-select button dimensions so that switching doesn't jump
old_switch = '''								<button
									type="button"
									role="switch"
									aria-checked={isMultiStatus}
									className="ml-auto h-5 flex items-center gap-1 border-0 bg-transparent p-0 text-12px text-[var(--mui-palette-text-secondary)] cursor-pointer hover:text-[var(--mui-palette-primary-main)]"
									onClick={() =>
										setLocalPlayStatusFilter((prev) =>
											Array.isArray(prev) ? "all" : []
										)
									}
								>
									<span>{t("components.FilterSortModal.multiSelect", "多选")}</span>
									<span
										className={`inline-block w-7.5 h-4 rounded-full transition-colors relative ${
											isMultiStatus
												? "bg-[var(--mui-palette-primary-main)]"
												: "bg-[var(--mui-palette-action-disabledBackground)]"
										}`}
									>
										<span
											className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
												isMultiStatus ? "translate-x-3.5" : ""
											}`}
										/>
									</span>
								</button>'''

new_switch = '''								<button
									type="button"
									role="switch"
									aria-checked={isMultiStatus}
									className="ml-auto h-5 shrink-0 select-none flex items-center gap-1.5 border-0 bg-transparent p-0 text-12px font-medium text-[var(--mui-palette-text-secondary)] cursor-pointer hover:text-[var(--mui-palette-primary-main)] transition-colors"
									onClick={() =>
										setLocalPlayStatusFilter((prev) =>
											Array.isArray(prev) ? "all" : []
										)
									}
								>
									<span className="font-semibold">{t("components.FilterSortModal.multiSelect", "多选")}</span>
									<span
										className={`inline-block w-8 h-4.5 rounded-full transition-colors relative shrink-0 ${
											isMultiStatus
												? "bg-[var(--mui-palette-primary-main)]"
												: "bg-[var(--mui-palette-action-disabledBackground)]"
										}`}
									>
										<span
											className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${
												isMultiStatus ? "translate-x-3.5" : ""
											}`}
										/>
									</span>
								</button>'''

if old_switch in content:
    content = content.replace(old_switch, new_switch, 1)
    print("Multi-select switch updated successfully.")
else:
    print("Warning: old_switch not found in FilterSortModal.tsx")

with open(filepath, "w", encoding="utf-8") as f:
    f.write(content)
print("Finished FilterSortModal.tsx update.")
