import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import PauseCircleIcon from "@mui/icons-material/PauseCircle";
import PlayCircleIcon from "@mui/icons-material/PlayCircle";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import type { SvgIconProps } from "@mui/material/SvgIcon";
import { PlayStatus } from "@/types/collection";

interface PlayStatusIconProps {
	fontSize?: SvgIconProps["fontSize"];
	status: PlayStatus;
}

export function PlayStatusIcon({
	fontSize = "small",
	status,
}: PlayStatusIconProps) {
	switch (status) {
		case PlayStatus.WISH:
			return (
				<StarBorderIcon
					fontSize={fontSize}
					className="block shrink-0 play-status-icon-wish"
				/>
			);
		case PlayStatus.PLAYING:
			return (
				<PlayCircleIcon
					fontSize={fontSize}
					className="block shrink-0 play-status-icon-playing"
				/>
			);
		case PlayStatus.PLAYED:
			return (
				<CheckCircleIcon
					fontSize={fontSize}
					className="block shrink-0 play-status-icon-played"
				/>
			);
		case PlayStatus.ON_HOLD:
			return (
				<PauseCircleIcon
					fontSize={fontSize}
					className="block shrink-0 play-status-icon-hold"
				/>
			);
		case PlayStatus.DROPPED:
			return (
				<CancelIcon
					fontSize={fontSize}
					className="block shrink-0 play-status-icon-dropped"
				/>
			);
		default:
			return null;
	}
}
