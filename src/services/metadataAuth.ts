import { withBgmAuth } from "@/services/oauth/bgmAuthSession";
import { withHikarinagiAuth } from "@/services/oauth/hikarinagiAuthSession";
import type { SourceType } from "@/types";
import { AppError } from "@/utils/errors";

export interface MetadataAuthTokens {
	bgmToken?: string;
	hikarinagiToken?: string;
}

export async function withMetadataAuth<T>(
	sources: readonly SourceType[],
	fn: (tokens: MetadataAuthTokens) => Promise<T>,
	options: {
		requireHikarinagi?: boolean;
		allowBgmPublicFallback?: boolean;
	} = {},
) {
	const sourceSet = new Set(sources);
	const allowBgmPublicFallback = options.allowBgmPublicFallback ?? true;
	const runHikarinagi = (bgmToken?: string) => {
		if (!sourceSet.has("hikarinagi")) {
			return fn({ bgmToken });
		}

		return withHikarinagiAuth(async (hikarinagiToken) => {
			if (options.requireHikarinagi && !hikarinagiToken) {
				throw new AppError({
					code: "hikarinagi_auth_missing",
					message: "未配置 Hikarinagi 登录",
				});
			}

			return fn({ bgmToken, hikarinagiToken });
		});
	};

	if (!sourceSet.has("bgm")) return runHikarinagi();

	try {
		return await withBgmAuth(runHikarinagi);
	} catch (error) {
		if (!allowBgmPublicFallback) throw error;
		return runHikarinagi();
	}
}
