import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { useEffect, useState, type FC, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getUserErrorMessage } from "@/utils/errors";

const LOADING_HINT_DELAY_MS = 520;

interface GameListStateViewProps {
	loading?: boolean;
	error?: unknown;
	empty?: boolean;
	emptyMessage?: ReactNode;
	customEmptyView?: ReactNode;
	keepChildrenWhenEmpty?: boolean;
	children: ReactNode;
}

export const GameListStateView: FC<GameListStateViewProps> = ({
	loading = false,
	error,
	empty = false,
	emptyMessage,
	customEmptyView,
	keepChildrenWhenEmpty = false,
	children,
}) => {
	const { t } = useTranslation();
	const [showLoadingHint, setShowLoadingHint] = useState(false);

	useEffect(() => {
		if (!loading) {
			setShowLoadingHint(false);
			return;
		}

		const timer = window.setTimeout(
			() => setShowLoadingHint(true),
			LOADING_HINT_DELAY_MS,
		);
		return () => window.clearTimeout(timer);
	}, [loading]);

	const loadingTitle = t(
		"components.GameListStateView.loadingTitle",
		"\u6b63\u5728\u6574\u7406\u6e38\u620f",
	);
	const loadingSubtitle = t(
		"components.GameListStateView.loadingSubtitle",
		"\u8bfb\u53d6\u5c01\u9762\u3001\u72b6\u6001\u548c\u672c\u5730\u6570\u636e...",
	);
	const fallbackEmptyMessage = t(
		"components.GameListStateView.empty",
		"\u6ca1\u6709\u627e\u5230\u7b26\u5408\u6761\u4ef6\u7684\u6e38\u620f",
	);
	const loadingHint = showLoadingHint ? (
		<Box className="game-list-loading-inline" role="status" aria-live="polite">
			<CircularProgress size={16} thickness={4} />
			<Typography variant="caption" fontWeight={800}>
				{loadingTitle}
			</Typography>
		</Box>
	) : null;

	if (loading) {
		if (keepChildrenWhenEmpty) {
			return (
				<Box className="game-list-state-with-children is-loading">
					{children}
					{loadingHint}
				</Box>
			);
		}

		if (!showLoadingHint) return null;

		return (
			<Box className="skerry-loading-state skerry-loading-state--soft">
				<Box className="skerry-loading-orb">
					<CircularProgress size={18} thickness={4.2} />
				</Box>
				<Box className="skerry-loading-copy">
					<Typography variant="subtitle2" fontWeight={900}>
						{loadingTitle}
					</Typography>
					<Typography variant="caption" color="text.secondary">
						{loadingSubtitle}
					</Typography>
				</Box>
			</Box>
		);
	}

	if (error) {
		return (
			<Box className="p-4">
				<Alert severity="error">{getUserErrorMessage(error, t)}</Alert>
			</Box>
		);
	}

	if (empty) {
		if (keepChildrenWhenEmpty) {
			return (
				<Box className="game-list-state-with-children">
					{children}
					<Box className="game-list-empty-overlay">
						{customEmptyView ? (
							customEmptyView
						) : (
							<Alert severity="info">
								{emptyMessage ?? fallbackEmptyMessage}
							</Alert>
						)}
					</Box>
				</Box>
			);
		}

		return (
			customEmptyView ? (
			<>{customEmptyView}</>
		) : (
			<Box className="flex justify-center mt-12">
				<Alert severity="info">{emptyMessage ?? fallbackEmptyMessage}</Alert>
			</Box>
		)
		);
	}

	return <>{children}</>;
};
