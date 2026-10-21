import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { gameKeys } from "@/hooks/queries/useGames";
import {
	getAllGameLastPlayed,
	getAllGameStatistics,
	getFormattedGameStats,
	getRecentSessionsForGames,
} from "@/services/game/gameStats";
import {
	buildPlayTimeSummary,
	type PlayTimeSummary,
} from "@/services/game/playTimeSummary";
import { statsService } from "@/services/invoke";

export const statsKeys = {
	all: ["stats"] as const,
	gameStats: (gameId: number) => [...statsKeys.all, "game", gameId] as const,
	sessions: (gameId: number, limit: number) =>
		[...statsKeys.all, "sessions", gameId, limit] as const,
	allGameLastPlayed: () => [...statsKeys.all, "allGameLastPlayed"] as const,
	recentSessionsForGames: (gameIds: number[], limit: number) =>
		[...statsKeys.all, "recentSessionsForGames", gameIds, limit] as const,
	playTimeSummary: () => [...statsKeys.all, "playTimeSummary"] as const,
	totalPlayTime: () => [...statsKeys.all, "totalPlayTime"] as const,
	weekPlayTime: () => [...statsKeys.all, "weekPlayTime"] as const,
	todayPlayTime: () => [...statsKeys.all, "todayPlayTime"] as const,
};

export async function getPlayTimeSummary(): Promise<PlayTimeSummary> {
	const statsMap = await getAllGameStatistics();
	return buildPlayTimeSummary(statsMap.values());
}

function usePlayTimeSummaryQuery() {
	return useQuery({
		queryKey: statsKeys.playTimeSummary(),
		queryFn: getPlayTimeSummary,
	});
}

function useGameStats(gameId: number | null) {
	return useQuery({
		queryKey: statsKeys.gameStats(gameId ?? 0),
		queryFn: async () => {
			if (!gameId) {
				return null;
			}

			return getFormattedGameStats(gameId);
		},
		enabled: gameId !== null,
	});
}

function useGameSessions(gameId: number | null, limit = 10) {
	return useQuery({
		queryKey: statsKeys.sessions(gameId ?? 0, limit),
		queryFn: async () => {
			if (!gameId) {
				return [];
			}

			return statsService.getGameSessions(gameId, limit);
		},
		enabled: gameId !== null,
		placeholderData: keepPreviousData,
	});
}

function useAllGameLastPlayedMap({ enabled }: { enabled: boolean }) {
	return useQuery({
		queryKey: statsKeys.allGameLastPlayed(),
		queryFn: getAllGameLastPlayed,
		enabled,
	});
}

function useRecentSessionsForGames(gameIds: number[], limit = 10) {
	return useQuery({
		queryKey: statsKeys.recentSessionsForGames(gameIds, limit),
		queryFn: () => getRecentSessionsForGames(gameIds, limit),
		enabled: gameIds.length > 0,
	});
}

function useCreateManualGameSession() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			gameId,
			startTime,
			duration,
		}: {
			gameId: number;
			startTime: number;
			duration: number;
		}) => statsService.createManualGameSession(gameId, startTime, duration),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: statsKeys.all }),
				queryClient.invalidateQueries({ queryKey: gameKeys.idLists() }),
			]);
		},
	});
}

function useDeleteGameSession() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (sessionId: number) =>
			statsService.deleteGameSession(sessionId),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: statsKeys.all }),
				queryClient.invalidateQueries({ queryKey: gameKeys.idLists() }),
			]);
		},
	});
}

function useTotalPlayTime() {
	const playTimeSummaryQuery = usePlayTimeSummaryQuery();

	return useMemo(
		() => ({
			...playTimeSummaryQuery,
			data: playTimeSummaryQuery.data?.totalPlayTime ?? 0,
		}),
		[playTimeSummaryQuery],
	);
}

function useWeekPlayTime() {
	const playTimeSummaryQuery = usePlayTimeSummaryQuery();

	return useMemo(
		() => ({
			...playTimeSummaryQuery,
			data: playTimeSummaryQuery.data?.weekPlayTime ?? 0,
		}),
		[playTimeSummaryQuery],
	);
}

function useTodayPlayTime() {
	const playTimeSummaryQuery = usePlayTimeSummaryQuery();

	return useMemo(
		() => ({
			...playTimeSummaryQuery,
			data: playTimeSummaryQuery.data?.todayPlayTime ?? 0,
		}),
		[playTimeSummaryQuery],
	);
}

function usePlayTimeSummary() {
	const playTimeSummaryQuery = usePlayTimeSummaryQuery();

	const summary = useMemo(
		() => ({
			totalPlayTime: playTimeSummaryQuery.data?.totalPlayTime ?? 0,
			weekPlayTime: playTimeSummaryQuery.data?.weekPlayTime ?? 0,
			monthPlayTime: playTimeSummaryQuery.data?.monthPlayTime ?? 0,
			todayPlayTime: playTimeSummaryQuery.data?.todayPlayTime ?? 0,
			monthlyDailyPlayTime:
				playTimeSummaryQuery.data?.monthlyDailyPlayTime ?? {},
			dailyPlayTime: playTimeSummaryQuery.data?.dailyPlayTime ?? {},
			isLoading: playTimeSummaryQuery.isLoading,
		}),
		[playTimeSummaryQuery.data, playTimeSummaryQuery.isLoading],
	);

	return summary;
}

export {
	useAllGameLastPlayedMap,
	useCreateManualGameSession,
	useDeleteGameSession,
	useGameSessions,
	useGameStats,
	usePlayTimeSummary,
	useRecentSessionsForGames,
	useTodayPlayTime,
	useTotalPlayTime,
	useWeekPlayTime,
};
