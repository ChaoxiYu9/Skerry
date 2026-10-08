import DeleteIcon from "@mui/icons-material/Delete";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import EditIcon from "@mui/icons-material/Edit";
import { ListItemIcon, ListItemText, MenuItem, MenuList } from "@mui/material";
import { useTranslation } from "react-i18next";
import { BaseRightMenu } from "./BaseRightMenu";

type CollectionRightMenuTarget =
	| { type: "group"; id: string }
	| { type: "category"; id: number };

interface CollectionRightMenuProps {
	anchorPosition: { top: number; left: number };
	onClose: () => void;
	target: CollectionRightMenuTarget;
	onOpenRename: () => void;
	onOpenManageGames?: () => void;
	onOpenDelete: () => void;
}

export const CollectionRightMenu: React.FC<CollectionRightMenuProps> = ({
	anchorPosition,
	onClose,
	target,
	onOpenRename,
	onOpenManageGames,
	onOpenDelete,
}) => {
	const { t } = useTranslation();

	return (
		<BaseRightMenu
			isopen
			anchorPosition={anchorPosition}
			onClose={onClose}
			ariaLabel={
				target.type === "group"
					? t("components.RightMenu.Collection.groupMenu", "分组菜单")
					: t("components.RightMenu.Collection.categoryMenu", "分类菜单")
			}
		>
			<MenuList
				dense
				className="skerry-detail-more-menu-list skerry-right-menu-list"
			>
				{target.type === "category" && (
					<MenuItem onClick={onOpenManageGames}>
						<ListItemIcon>
							<EditIcon fontSize="small" />
						</ListItemIcon>
						<ListItemText
							primary={t(
								"components.RightMenu.Collection.manageGames",
								"管理游戏",
							)}
						/>
					</MenuItem>
				)}

				<MenuItem onClick={onOpenRename}>
					<ListItemIcon>
						<DriveFileRenameOutlineIcon fontSize="small" />
					</ListItemIcon>
					<ListItemText
						primary={
							target.type === "group"
								? t("components.RightMenu.Collection.renameGroup", "重命名分组")
								: t("components.RightMenu.Collection.renameCategory", "重命名分类")
						}
					/>
				</MenuItem>

				<MenuItem className="skerry-context-menu-danger-item" onClick={onOpenDelete}>
					<ListItemIcon className="skerry-context-menu-danger-icon">
						<DeleteIcon fontSize="small" />
					</ListItemIcon>
					<ListItemText
						primary={
							target.type === "group"
								? t("components.RightMenu.Collection.deleteGroup", "删除分组")
								: t("components.RightMenu.Collection.deleteCategory", "删除分类")
						}
					/>
				</MenuItem>
			</MenuList>
		</BaseRightMenu>
	);
};
