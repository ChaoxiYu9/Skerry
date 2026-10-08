import { useQuery } from "@tanstack/react-query";
import { fetchBgmStaffById } from "@/metadata/api/bgm";
import { remoteQueryOptions } from "@/providers/queryClient";
import { getNetworkRequestContext } from "@/services/requestContext";

export const gameStaffKeys = {
	all: ["gameStaff"] as const,
	byBgmId: (bgmId: string) => [...gameStaffKeys.all, bgmId] as const,
};

/** 仅在当前游戏存在 Bangumi ID 时按需读取制作人员。 */
export function useGameStaff(bgmId?: string) {
	return useQuery({
		queryKey: bgmId ? gameStaffKeys.byBgmId(bgmId) : gameStaffKeys.all,
		queryFn: () =>
			fetchBgmStaffById(bgmId as string, getNetworkRequestContext()),
		enabled: Boolean(bgmId),
		...remoteQueryOptions,
	});
}
