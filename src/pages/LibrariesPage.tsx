import AddRoundedIcon from "@mui/icons-material/AddRounded";
import UpdateRoundedIcon from "@mui/icons-material/UpdateRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SortableCardsGrid } from "@/components/Cards";
import { FilterSortModal } from "@/components/FilterSortModal";
import { GameListStateView } from "@/components/GameListStateView";
import { LaunchModal } from "@/components/LaunchModal";
import { SearchBox } from "@/components/SearchBox";
import { useGameListFacade } from "@/hooks/features/games/useGameListFacade";
import { snackbar } from "@/providers/snackBar";
import { isBgmAuthExpiredError } from "@/services/oauth/bgmAuthSession";
import { useStore } from "@/store/appStore";
import { getUserErrorMessage } from "@/utils/errors";

interface LibraryControlsProps {
	showDataSourceSync?: boolean;
	batchControl?: React.ReactNode;
}

function LibraryDataSourceSyncButton() {
	const { t } = useTranslation();
	const [syncing, setSyncing] = useState(false);

	const handleSync = async () => {
		if (syncing) return;
		setSyncing(true);
		snackbar.info(
			t(
				"pages.Libraries.batchSync.started",
				"\u6b63\u5728\u6279\u91cf\u540c\u6b65\u6e38\u620f\u6570\u636e\u6e90...",
			),
		);

		const summaries: string[] = [];
		let hasWarning = false;

		try {
			const { batchUpdateBgmData, batchUpdateVndbData } = await import(
				"@/metadata/data/metadataBatchUpdate"
			);

			try {
				const bgmResult = await batchUpdateBgmData();
				summaries.push(
					"BGM " +
						bgmResult.success +
						"/" +
						bgmResult.total +
						"（刷新 " +
						bgmResult.refreshed +
						"，失败 " +
						bgmResult.failed +
						"）",
				);
				if (bgmResult.failed > 0) hasWarning = true;
			} catch (error) {
				if (!isBgmAuthExpiredError(error)) {
					hasWarning = true;
					snackbar.error(
						t("pages.Libraries.batchSync.bgmFailed", {
							message: getUserErrorMessage(error, t),
							defaultValue:
								"BGM \u6570\u636e\u540c\u6b65\u5931\u8d25\uff1a{{message}}",
						}),
					);
				}
			}

			try {
				const vndbResult = await batchUpdateVndbData();
				summaries.push(
					"VNDB " +
						vndbResult.success +
						"/" +
						vndbResult.total +
						"（刷新 " +
						vndbResult.refreshed +
						"，失败 " +
						vndbResult.failed +
						"）",
				);
				if (vndbResult.failed > 0) hasWarning = true;
			} catch (error) {
				hasWarning = true;
				snackbar.error(
					t("pages.Libraries.batchSync.vndbFailed", {
						message: getUserErrorMessage(error, t),
						defaultValue:
							"VNDB \u6570\u636e\u540c\u6b65\u5931\u8d25\uff1a{{message}}",
					}),
				);
			}

			if (summaries.length === 0) return;
			const doneMessage = t("pages.Libraries.batchSync.completed", {
				summary: summaries.join("\uff0c"),
				defaultValue:
					"\u6570\u636e\u6e90\u540c\u6b65\u5b8c\u6210\uff1a{{summary}}",
			});
			if (hasWarning) snackbar.warning(doneMessage);
			else snackbar.success(doneMessage);
		} catch (error) {
			snackbar.error(getUserErrorMessage(error, t));
		} finally {
			setSyncing(false);
		}
	};

	return (
		<Button
			className="library-action-button library-action-secondary library-sync-source-button"
			variant="outlined"
			startIcon={
				syncing ? (
					<CircularProgress size={16} color="inherit" />
				) : (
					<UpdateRoundedIcon />
				)
			}
			onClick={() => void handleSync()}
			disabled={syncing}
		>
			{syncing
				? t(
						"pages.Libraries.batchSync.syncing",
						"\u540c\u6b65\u4e2d...",
					)
				: t(
						"pages.Libraries.batchSync.button",
						"\u540c\u6b65\u6570\u636e\u6e90",
					)}
		</Button>
	);
}

export function LibraryControls({
	showDataSourceSync = false,
	batchControl,
}: LibraryControlsProps) {
	const { t } = useTranslation();
	const openAddModal = useStore((state) => state.openAddModal);

	return (
		<Box className="library-controls-pack">
			<Box className="library-workbench-search">
				<SearchBox />
			</Box>
			<Stack className="library-workbench-actions" direction="row" spacing={0.75}>
				<Box className="library-launch-action">
					<LaunchModal />
				</Box>
				<Button
					className="library-action-button library-action-primary"
					variant="contained"
					startIcon={<AddRoundedIcon />}
					onClick={() => openAddModal("")}
				>
					{t("components.AddModal.addGame", "\u6dfb\u52a0\u6e38\u620f")}
				</Button>
				<Box className="library-filter-action">
					<FilterSortModal />
				</Box>
				{showDataSourceSync ? <LibraryDataSourceSyncButton /> : null}
				{batchControl}
			</Stack>
		</Box>
	);
}

export const Libraries: React.FC = () => {
	const { t } = useTranslation();
	const { gameIds, displayById, isLoading, isError, error } =
		useGameListFacade();

	return (
		<Box className="library-page-shell">
			<Box className="library-card-stage">
				<GameListStateView
					loading={isLoading}
					error={isError ? error : null}
					empty={gameIds.length === 0}
						emptyMessage={t(
						"pages.Libraries.empty",
						"\u6ca1\u6709\u627e\u5230\u7b26\u5408\u6761\u4ef6\u7684\u6e38\u620f",
					)}
					keepChildrenWhenEmpty
				>
					<SortableCardsGrid
						gameIds={gameIds}
						displayById={displayById}
						accessory={<LibraryControls showDataSourceSync />}
						enableBatchMode
						enableSortFieldOverlay
						scrollRestoreKey="/libraries"
						dragSortEnabled={false}
					/>
				</GameListStateView>
			</Box>
		</Box>
	);
};
