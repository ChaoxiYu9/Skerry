import BookmarkAddIcon from "@mui/icons-material/BookmarkAdd";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import DeleteIcon from "@mui/icons-material/Delete";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertConfirmBox } from "@/components/AlertBox";
import { CollectionPickerDialog } from "@/components/Collection";
import { useDeleteGames } from "@/hooks/queries/useGames";
import { snackbar } from "@/providers/snackBar";

function handleBatchModeChange(
	enabled: boolean,
	onBatchModeChange: (enabled: boolean) => void,
	onSelectionClear: () => void,
) {
	onBatchModeChange(enabled);
	if (!enabled) onSelectionClear();
}

interface CardsBatchBarProps {
	batchMode: boolean;
	selectedBatchGameIds: number[];
	gameIds: number[];
	categoryId?: number;
	onBatchModeChange: (enabled: boolean) => void;
	onSelectionChange: (gameIds: number[]) => void;
	onSelectionClear: () => void;
	onDeleteSuccess: () => void;
	onRemoveFromCategory: (gameIds: number[]) => Promise<void>;
	collectionContext?: boolean;
	accessory?: ReactNode;
}

export const CardsBatchBar: React.FC<CardsBatchBarProps> = ({
	batchMode,
	selectedBatchGameIds,
	gameIds,
	categoryId,
	onBatchModeChange,
	onSelectionChange,
	onSelectionClear,
	onDeleteSuccess,
	onRemoveFromCategory,
	collectionContext = false,
	accessory,
}) => {
	const { t } = useTranslation();
	const deleteGamesMutation = useDeleteGames();
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [collectionDialogOpen, setCollectionDialogOpen] = useState(false);
	const isCollectionCategory = typeof categoryId === "number" && categoryId > 0;
	const gameIdSet = useMemo(() => new Set(gameIds), [gameIds]);
	const selectedVisibleGameIds = useMemo(
		() => selectedBatchGameIds.filter((id) => gameIdSet.has(id)),
		[selectedBatchGameIds, gameIdSet],
	);
	const selectedCount = selectedVisibleGameIds.length;
	const isMutating = deleteGamesMutation.isPending;
	const allVisibleSelected = gameIds.length > 0 && selectedCount === gameIds.length;

	const handleSelectAll = () => onSelectionChange(gameIds);
	const handleToggleSelectAll = () => {
		if (allVisibleSelected) onSelectionClear();
		else handleSelectAll();
	};

	const batchControl = (
		<Box className="cards-batch-switch">
			<Typography variant="body2">
				{t("components.Toolbar.Batch.start", "\u6279\u91cf\u64cd\u4f5c")}
			</Typography>
			<Switch
				checked={batchMode}
				onChange={(event) =>
					handleBatchModeChange(
						event.target.checked,
						onBatchModeChange,
						onSelectionClear,
					)
				}
				slotProps={{
					input: {
						"aria-label": t(
							"components.Toolbar.Batch.start",
							"\u6279\u91cf\u64cd\u4f5c",
						),
					},
				}}
			/>
		</Box>
	);

	const accessoryWithBatchControl = isValidElement(accessory)
		? cloneElement(accessory, { batchControl })
		: accessory;

	const handleDeleteGames = async () => {
		if (selectedCount === 0) return;
		try {
			await deleteGamesMutation.mutateAsync(selectedVisibleGameIds);
			onDeleteSuccess();
			handleBatchModeChange(false, onBatchModeChange, onSelectionClear);
			setDeleteDialogOpen(false);
			snackbar.success(
				t("components.Toolbar.Batch.deleteSuccess", {
					count: selectedCount,
					defaultValue: "\u5df2\u5220\u9664 {{count}} \u4e2a\u6e38\u620f",
				}),
			);
		} catch (error) {
			console.error("Batch delete games failed:", error);
			snackbar.error(
				t(
					"components.Toolbar.Batch.deleteFailed",
					"\u6279\u91cf\u5220\u9664\u6e38\u620f\u5931\u8d25",
				),
			);
		}
	};

	const handleRemoveFromCategory = async () => {
		if (!isCollectionCategory || selectedCount === 0) return;
		try {
			await onRemoveFromCategory(selectedVisibleGameIds);
			handleBatchModeChange(false, onBatchModeChange, onSelectionClear);
			snackbar.success(
				t("components.Toolbar.Batch.removeFromCategorySuccess", {
					count: selectedCount,
					defaultValue:
						"已从收藏夹移除 {{count}} 个游戏",
				}),
			);
		} catch (error) {
			console.error("Remove games from category failed:", error);
			snackbar.error(
				t(
					"components.Toolbar.Batch.removeFromCategoryFailed",
					"移除出收藏夹失败",
				),
			);
		}
	};

	return (
		<>
			<Box className={batchMode ? "cards-control-bar is-batch-mode" : "cards-control-bar"}>
				<Box className="cards-control-main">
					{accessoryWithBatchControl ? (
						<Box className="cards-control-accessory">
							{accessoryWithBatchControl}
						</Box>
					) : null}
				</Box>

				{batchMode ? (
					<Box className="cards-batch-actions">
						<Button
							className={
								allVisibleSelected
									? "cards-batch-toggle-selection is-selected"
									: "cards-batch-toggle-selection"
							}
							startIcon={
								allVisibleSelected ? <CheckBoxIcon /> : <CheckBoxOutlineBlankIcon />
							}
							onClick={handleToggleSelectAll}
							disabled={gameIds.length === 0 || isMutating}
						>
							{t("components.Toolbar.Batch.selectAll", "\u5168\u9009")}
						</Button>
						<Typography
							className="cards-batch-selected-count"
							variant="body2"
							color="text.secondary"
						>
							{selectedCount}/{gameIds.length}
						</Typography>
						{isCollectionCategory ? (
							<Button
								className="cards-batch-remove-category"
								startIcon={<RemoveCircleOutlineIcon />}
								onClick={handleRemoveFromCategory}
								disabled={selectedCount === 0 || isMutating}
							>
								{t(
									"components.Toolbar.Batch.removeFromCategory",
									"移除出收藏夹",
								)}
							</Button>
						) : !collectionContext ? (
							<Button
								className="cards-batch-collection"
								startIcon={<BookmarkAddIcon />}
								onClick={() => setCollectionDialogOpen(true)}
								disabled={selectedCount === 0 || isMutating}
							>
								{t(
									"components.Toolbar.Batch.addToCollection",
									"加入收藏",
								)}
							</Button>
						) : null}
						{!collectionContext && <Button
							className="cards-batch-danger"
							startIcon={<DeleteIcon />}
							color="error"
							onClick={() => setDeleteDialogOpen(true)}
							disabled={selectedCount === 0 || isMutating}
						>
							{t(
								"components.Toolbar.Batch.deleteSelected",
								"\u5220\u9664\u6240\u9009",
							)}
						</Button>}
					</Box>
					) : (
					<Typography className="cards-total-count" variant="body2" color="text.secondary">
						{t("components.Toolbar.Batch.totalCount", {
							count: gameIds.length,
							defaultValue: "\u5171 {{count}} \u4e2a\u6e38\u620f",
						})}
					</Typography>
					)}
			</Box>

			<AlertConfirmBox
				open={deleteDialogOpen}
				setOpen={setDeleteDialogOpen}
				onConfirm={handleDeleteGames}
				isLoading={deleteGamesMutation.isPending}
				title={t(
					"components.Toolbar.Batch.deleteTitle",
					"\u6279\u91cf\u5220\u9664\u6e38\u620f",
				)}
				message={t("components.Toolbar.Batch.deleteMessage", {
					count: selectedCount,
					defaultValue:
						"\u786e\u5b9a\u8981\u5220\u9664\u9009\u4e2d\u7684 {{count}} \u4e2a\u6e38\u620f\u5417\uff1f\u6b64\u64cd\u4f5c\u65e0\u6cd5\u64a4\u9500\u3002",
				})}
			/>

			<CollectionPickerDialog
				open={collectionDialogOpen}
				mode="add"
				gameIds={selectedVisibleGameIds}
				onClose={() => setCollectionDialogOpen(false)}
				onSaved={() =>
					handleBatchModeChange(false, onBatchModeChange, onSelectionClear)
				}
			/>
		</>
	);
};
