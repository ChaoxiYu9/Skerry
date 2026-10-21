import CircularProgress from "@mui/material/CircularProgress";
import type { CircularProgressProps } from "@mui/material/CircularProgress";

export type ButtonLoadingIndicatorProps = Omit<CircularProgressProps, "size">;

export function ButtonLoadingIndicator(props: ButtonLoadingIndicatorProps) {
	return <CircularProgress {...props} size={17} />;
}
