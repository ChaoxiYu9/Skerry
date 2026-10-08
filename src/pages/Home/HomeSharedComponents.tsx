import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { RevealImage } from "@/components/motion/RevealImage";
import type { NextUpVirtualGame } from "@/store/appStore";
import type { GameData } from "@/types";
import { getGameBannerObjectPosition } from "@/utils/game";
import {
	type ActivityFilter,
	getVisibleCover,
	getVisibleGameCover,
} from "./homeData";
import { getNextUpAssetUrl } from "./nextUpAssets";

export type HomeGame = GameData | NextUpVirtualGame;

export const isVirtualPlanGame = (game: HomeGame): game is NextUpVirtualGame =>
	game.id < 0;

export function formatCompactPlayTime(minutes: number): string {
	if (!minutes) return "0m";
	const hours = Math.floor(minutes / 60);
	const mins = Math.round(minutes % 60);
	if (hours >= 100) return String(Math.floor((minutes / 60) * 10) / 10) + "h";
	if (hours > 0) return mins > 0 ? hours + "h " + mins + "m" : hours + "h";
	return mins + "m";
}

export function SectionHeading({
	code,
	title,
	icon,
}: {
	code?: string;
	title: string;
	icon?: ReactNode;
}) {
	return (
		<Box className="atlas-section-heading">
			{icon}
			<Box>
				{code ? <Typography className="atlas-code">{code}</Typography> : null}
				<Typography className="atlas-section-title">{title}</Typography>
			</Box>
		</Box>
	);
}

export function ActivityGlyph({
	type,
	className,
}: {
	type: ActivityFilter;
	className?: string;
}) {
	return (
		<span
			className={["atlas-activity-glyph", "is-" + type, className]
				.filter(Boolean)
				.join(" ")}
			aria-hidden="true"
		>
			<span />
		</span>
	);
}

export function GameImage({
	game,
	replaceNsfwCover,
	className,
	preferBanner = false,
	focusBanner = false,
	loading,
	revealMotion = true,
}: {
	game: HomeGame;
	replaceNsfwCover: boolean;
	className?: string;
	preferBanner?: boolean;
	focusBanner?: boolean;
	loading?: "eager" | "lazy";
	revealMotion?: boolean;
}) {
	const source =
		"sourceKey" in game
			? getNextUpAssetUrl(game, "cover") || game.image || "/images/skerry.png"
			: preferBanner
				? getVisibleCover(game, replaceNsfwCover)
				: getVisibleGameCover(game, replaceNsfwCover);
	const bannerPosition =
		!("sourceKey" in game) && focusBanner && game.custom_data?.banner
			? getGameBannerObjectPosition(game)
			: undefined;
	return (
		<RevealImage
			src={source}
			alt=""
			loading={loading}
			revealMotion={revealMotion}
			className={className}
			style={bannerPosition ? { objectPosition: bannerPosition } : undefined}
		/>
	);
}