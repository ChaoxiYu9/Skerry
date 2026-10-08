import BookmarkIcon from "@mui/icons-material/Bookmark";
import CategoryIcon from "@mui/icons-material/Category";
import FolderIcon from "@mui/icons-material/Folder";
import Box from "@mui/material/Box";
import Breadcrumbs from "@mui/material/Breadcrumbs";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";

export type CollectionLevel = "groups" | "categories" | "games";

interface CollectionBreadcrumbsProps {
	level: CollectionLevel;
	groupName?: string;
	categoryName?: string;
	onNavigate: (level: "root" | "group") => void;
}

export function CollectionBreadcrumbs({
	level,
	groupName = "",
	categoryName = "",
	onNavigate,
}: CollectionBreadcrumbsProps) {
	const { t } = useTranslation();
	const rootLabel = t("app.NAVIGATION.collection", "收藏夹");

	const linkSx = {
		fontSize: "15px",
		fontWeight: 700,
		color: "text.secondary",
		display: "inline-flex",
		alignItems: "center",
		gap: 0.7,
		px: 1,
		py: 0.4,
		borderRadius: "8px",
		transition: "all 0.15s ease",
		textDecoration: "none !important",
		"&:hover": {
			color: "primary.main",
			bgcolor: "action.hover",
		},
	};

	const currentLeafSx = {
		fontSize: "15px",
		fontWeight: 700,
		color: "text.primary",
		display: "inline-flex",
		alignItems: "center",
		gap: 0.7,
		px: 1,
		py: 0.4,
		borderRadius: "8px",
	};

	return (
		<Box className="collection-breadcrumbs-wrapper">
			<Box className="collection-breadcrumbs-bar">
				<Breadcrumbs
					separator={
						<span
							className="collection-breadcrumb-separator"
							style={{ opacity: 0.38, fontWeight: 500, margin: "0 2px", userSelect: "none" }}
						>
							/
						</span>
					}
					aria-label="breadcrumb"
					sx={{
						fontSize: "15px",
						fontWeight: 700,
						color: "text.secondary",
						"& .MuiBreadcrumbs-li": {
							display: "inline-flex",
							alignItems: "center",
							whiteSpace: "nowrap",
						},
						"& .MuiBreadcrumbs-separator": {
							mx: "4px",
							color: "text.secondary",
						},
					}}
				>
					{/* 1级：根目录 */}
					{level === "groups" ? (
						<Typography sx={currentLeafSx}>
							<CategoryIcon sx={{ fontSize: 18, color: "primary.main" }} />
							{rootLabel}
						</Typography>
					) : (
						<Link
							className="cursor-pointer"
							sx={linkSx}
							onClick={() => onNavigate("root")}
						>
							<CategoryIcon sx={{ fontSize: 18 }} />
							{rootLabel}
						</Link>
					)}

					{/* 2级：分组名 */}
					{groupName && level === "categories" ? (
						<Typography sx={currentLeafSx}>
							<FolderIcon sx={{ fontSize: 18, color: "primary.main" }} />
							{groupName}
						</Typography>
					) : null}

					{groupName && level === "games" ? (
						<Link
							className="cursor-pointer"
							sx={linkSx}
							onClick={() => onNavigate("group")}
						>
							<FolderIcon sx={{ fontSize: 18 }} />
							{groupName}
						</Link>
					) : null}

					{/* 3级：分类名 */}
					{categoryName && level === "games" ? (
						<Typography sx={currentLeafSx}>
							<BookmarkIcon sx={{ fontSize: 18, color: "primary.main" }} />
							{categoryName}
						</Typography>
					) : null}
				</Breadcrumbs>
			</Box>
			<Box className="collection-breadcrumbs-divider" />
		</Box>
	);
}
