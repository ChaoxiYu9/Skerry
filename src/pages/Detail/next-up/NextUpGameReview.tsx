import { useEffect, useState } from "react";
import { formatRating, LocalReviewForm } from "@/pages/Detail/LocalReviewForm";
import type { NextUpVirtualGame } from "@/store/appStore";

interface NextUpGameReviewProps {
	game: NextUpVirtualGame;
	onSave: (rating: number | undefined, review: string | undefined) => void;
}

export function NextUpGameReview({ game, onSave }: NextUpGameReviewProps) {
	const [rating, setRating] = useState(formatRating(game.userRating));
	const [review, setReview] = useState(game.userReview ?? "");

	useEffect(() => {
		setRating(formatRating(game.userRating));
		setReview(game.userReview ?? "");
	}, [game]);

	return (
		<LocalReviewForm
			initialRating={game.userRating}
			initialReview={game.userReview}
			ratingInput={rating}
			reviewInput={review}
			onRatingChange={setRating}
			onReviewChange={setReview}
			onSave={(nextRating, nextReview) => {
				onSave(nextRating || undefined, nextReview.trim() || undefined);
			}}
		/>
	);
}
