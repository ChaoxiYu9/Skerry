import FolderIcon from "@mui/icons-material/Folder";
import Box from "@mui/material/Box";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { memo, type MouseEvent } from "react";

interface EntityCardProps {
	entity: {
		id: string | number;
		name: string;
		count: number;
	};
	onClick: () => void;
	title?: string;
	fillHeight?: boolean;
	titleNoWrap?: boolean;
	onContextMenu: (
		e: MouseEvent,
		id: string | number,
		name: string,
	) => void;
	countLabel: string;
}

export const EntityCard = memo<EntityCardProps>(
	({
		entity,
		onClick,
		title,
		fillHeight = false,
		titleNoWrap = false,
		onContextMenu,
		countLabel,
	}) => {
		const handleContextMenu = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			onContextMenu(e, entity.id, entity.name);
		};

		return (
			<Box
				sx={{
					p: 1,
					position: "relative",
					...(fillHeight && { boxSizing: "border-box", height: "100%" }),
				}}
			>
				<Paper
					component="article"
					variant="outlined"
					elevation={0}
					className="collection-entity-card"
					data-flip-key={entity.id.toString()}
					onContextMenu={handleContextMenu}
					sx={{
						...(fillHeight && { height: "100%" }),
						borderRadius: 2,
						overflow: "hidden",
						backdropFilter: "none",
						transition: "border-color 140ms ease, background-color 140ms ease",
					}}
				>
					<CardActionArea
						disableRipple
						onClick={onClick}
						title={title}
						sx={fillHeight ? { height: "100%" } : undefined}
					>
						<CardContent sx={fillHeight ? { height: "100%" } : undefined}>
							<Box display="flex" alignItems="center" gap={1} mb={1}>
								<FolderIcon color="primary" />
								<Typography
									variant="h6"
									component="div"
									noWrap={titleNoWrap}
									sx={titleNoWrap ? { minWidth: 0 } : undefined}
								>
									{entity.name}
								</Typography>
							</Box>
							<Typography variant="body2" color="text.secondary">
								{entity.count} {countLabel}
							</Typography>
						</CardContent>
					</CardActionArea>
				</Paper>
			</Box>
		);
	},
	(prev, next) =>
		prev.entity.id === next.entity.id &&
		prev.entity.name === next.entity.name &&
		prev.entity.count === next.entity.count &&
		prev.title === next.title &&
		prev.fillHeight === next.fillHeight &&
		prev.titleNoWrap === next.titleNoWrap &&
		prev.countLabel === next.countLabel &&
		prev.onClick === next.onClick &&
		prev.onContextMenu === next.onContextMenu,
);

EntityCard.displayName = "EntityCard";
