import type { UpdateKunUserWorkRecordPayload } from "@/metadata/api/kun";

type KunWorkState = NonNullable<
	UpdateKunUserWorkRecordPayload["work_state"]
>["state"];
type KunRatingPayload = NonNullable<
	UpdateKunUserWorkRecordPayload["rating"]
>;

export interface KunWorkRecordPayloadInput {
	normalizedRating: number;
	reviewText: string;
	workState?: KunWorkState;
	playtimeMinutes?: number;
}

function mapRatingToKunRecommend(
	rating: number,
): NonNullable<KunRatingPayload["recommend"]> {
	if (rating >= 9) return "strong_yes";
	if (rating >= 7) return "yes";
	if (rating >= 5) return "neutral";
	if (rating >= 3) return "no";
	return "strong_no";
}

export function buildKunUserWorkRecordPayload(
	input: KunWorkRecordPayloadInput,
): UpdateKunUserWorkRecordPayload {
	const { normalizedRating, reviewText, workState, playtimeMinutes } = input;
	const hasRatingOrReview = normalizedRating > 0 || Boolean(reviewText);

	const rating: KunRatingPayload | undefined = hasRatingOrReview
		? {
				...(normalizedRating > 0
					? {
							overall: Math.round(normalizedRating),
							recommend: mapRatingToKunRecommend(normalizedRating),
						}
					: {}),
				...(reviewText ? { short_summary: reviewText } : {}),
				spoiler_level: "none",
			}
		: undefined;

	return {
		...(workState ? { work_state: { state: workState } } : {}),
		...(rating ? { rating } : {}),
		...(playtimeMinutes !== undefined
			? { playtime: { minutes: playtimeMinutes } }
			: {}),
	};
}
