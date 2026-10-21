import { useQuery } from "@tanstack/react-query";
import { fetchBgmStaffById } from "@/metadata/api/bgm";
import { remoteQueryOptions } from "@/providers/queryClient";
import { getNetworkRequestContext } from "@/services/requestContext";

export const gameStaffKeys = {
	all: ["gameStaff"] as const,
	byBgmId: (bgmId: string) => [...gameStaffKeys.all, bgmId] as const,
};

/** 仅在调用方明确要求时读取远程制作人员；详情展示默认只读本地数据。 */
export function useGameStaff(
	bgmId?: string,
	options: { enabled?: boolean } = { enabled: false },
) {
	return useQuery({
		queryKey: bgmId ? gameStaffKeys.byBgmId(bgmId) : gameStaffKeys.all,
		queryFn: () =>
			fetchBgmStaffById(bgmId as string, getNetworkRequestContext()),
		enabled: Boolean(bgmId) && (options.enabled ?? true),
		...remoteQueryOptions,
	});
}
