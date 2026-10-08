import SaveIcon from "@mui/icons-material/Save";
import {
	Button,
	CardContent,
	CircularProgress,
	Stack,
	TextField,
	Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { snackbar } from "@/providers/snackBar";
import { hasUserRating, normalizeUserRating } from "@/services/cloudUserReview";
import { GlassSurface } from "@/components/ui/GlassSurface";

export interface ParsedRating {
	value: number;
	error?: "invalid" | "range";
}

export function formatRating(value: number | null | undefined) {
	return hasUserRating(value) ? normalizeUserRating(value).toFixed(1) : "0";
}

export function parseRatingInput(input: string): ParsedRating {
	const trimmed = input.trim();
	if (!trimmed) return { value: 0 };

	const value = Number(trimmed);
	if (!Number.isFinite(value)) return { value: 0, error: "invalid" };
	if (value === 0) return { value: 0 };
	if (value < 1 || value > 10) return { value: 0, error: "range" };
	return { value: normalizeUserRating(value) };
}

function isSameReviewState(
	initialRating: number | null | undefined,
	initialReview: string | null | undefined,
	rating: number,
	review: string,
) {
	return (
		normalizeUserRating(initialRating ?? 0) === rating &&
		(initialReview?.trim() ?? "") === review.trim()
	);
}

interface LocalReviewFormProps {
	initialRating?: number | null;
	initialReview?: string | null;
	ratingInput: string;
	reviewInput: string;
	onRatingChange: (value: string) => void;
	onReviewChange: (value: string) => void;
	onSave: (rating: number, review: string) => unknown;
}

export function LocalReviewForm({
	initialRating,
	initialReview,
	ratingInput,
	reviewInput,
	onRatingChange,
	onReviewChange,
	onSave,
}: LocalReviewFormProps) {
	const { t } = useTranslation();
	const [isSaving, setIsSaving] = useState(false);
	const parsedRating = useMemo(
		() => parseRatingInput(ratingInput),
		[ratingInput],
	);
	const ratingError = Boolean(parsedRating.error);
	const ratingErrorText =
		parsedRating.error === "range"
			? t("pages.Detail.Review.ratingRangeError", "评分只能为 0 或 1-10")
			: parsedRating.error === "invalid"
				? t("pages.Detail.Review.ratingInvalidError", "请输入有效评分")
				: "";
	const hasChanges =
		!ratingError &&
		!isSameReviewState(
			initialRating,
			initialReview,
			parsedRating.value,
			reviewInput,
		);

	const save = async () => {
		const nextRating = parseRatingInput(ratingInput);
		if (nextRating.error) {
			snackbar.error(
				nextRating.error === "range"
					? t("pages.Detail.Review.ratingRangeError", "评分只能为 0 或 1-10")
					: t("pages.Detail.Review.ratingInvalidError", "请输入有效评分"),
			);
			return;
		}
		if (
			isSameReviewState(
				initialRating,
				initialReview,
				nextRating.value,
				reviewInput,
			)
		) {
			onRatingChange(formatRating(nextRating.value));
			return;
		}

		setIsSaving(true);
		try {
			await onSave(nextRating.value, reviewInput);
		} catch (error) {
			snackbar.error(String(error));
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<GlassSurface component="section" className="detail-glass-card">
			<CardContent>
				<Typography variant="h6" gutterBottom>
					{t("pages.Detail.Review.localReview", "本地评价")}
				</Typography>
				<Stack spacing={3}>
					<TextField
						label={t("pages.Detail.Review.myRating", "我的评分")}
						type="number"
						size="small"
						value={ratingInput}
						onChange={(event) => onRatingChange(event.target.value)}
						error={ratingError}
						helperText={
							ratingErrorText ||
							t(
								"pages.Detail.Review.ratingHelperText",
								"0 表示清空评分；1-10 支持一位小数",
							)
						}
						inputProps={{ min: 0, max: 10, step: 0.1 }}
						sx={{ width: { xs: "100%", sm: 180 } }}
					/>
					<TextField
						label={t("pages.Detail.Review.myReview", "我的评价")}
						value={reviewInput}
						onChange={(event) => onReviewChange(event.target.value)}
						fullWidth
						multiline
						minRows={6}
						maxRows={12}
						helperText={t(
							"pages.Detail.Review.reviewHelperText",
							"评分和评价会一起保存到本地",
						)}
						InputProps={{
							sx: {
								"& textarea": {
									resize: "vertical",
									overflow: "auto !important",
								},
							},
						}}
					/>
					<Button
						variant="contained"
						fullWidth
						startIcon={isSaving ? <CircularProgress size={16} /> : <SaveIcon />}
						disabled={isSaving || ratingError || !hasChanges}
						onClick={() => void save()}
					>
						{isSaving
							? t("pages.Detail.Review.saving", "保存中...")
							: t("pages.Detail.Review.save", "保存本地评价")}
					</Button>
				</Stack>
			</CardContent>
		</GlassSurface>
	);
}
