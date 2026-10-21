import AddRoundedIcon from "@mui/icons-material/AddRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FilterSortModal } from "@/components/FilterSortModal";
import { LaunchModal } from "@/components/LaunchModal";
import { SearchBox } from "@/components/SearchBox";
import { useStore } from "@/store/appStore";

interface GameListControlsProps {
	dataSourceSyncAction?: ReactNode;
	batchControl?: ReactNode;
	manageGamesAction?: ReactNode;
}

export function GameListControls({
	dataSourceSyncAction,
	batchControl,
	manageGamesAction,
}: GameListControlsProps) {
	const { t } = useTranslation();
	const openAddModal = useStore((state) => state.openAddModal);

	return (
		<Box className="library-controls-pack">
			<Box className="library-workbench-search">
				<SearchBox />
			</Box>
			<Box
				className={
					manageGamesAction
						? "library-workbench-actions library-workbench-actions--with-manage"
						: "library-workbench-actions"
				}
			>
				<Box className="library-launch-action">
					<LaunchModal />
				</Box>
				<Button
					className="library-action-button library-action-primary skerry-button-level-a skerry-button-level-a-gradient"
					variant="contained"
					startIcon={<AddRoundedIcon />}
					onClick={() => openAddModal("")}
				>
					{t("components.AddModal.addGame", "\u6dfb\u52a0\u6e38\u620f")}
				</Button>
				<Box className="library-filter-action">
					<FilterSortModal />
				</Box>
				{dataSourceSyncAction}
				{batchControl}
				{manageGamesAction}
			</Box>
		</Box>
	);
}
