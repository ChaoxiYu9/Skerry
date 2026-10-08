import type { PaperProps } from "@mui/material/Paper";
import Paper from "@mui/material/Paper";

export function GlassSurface({ sx, ...props }: PaperProps) {
	const baseSx = {
		background: "var(--skerry-glass-surface)",
		backdropFilter: "blur(18px) saturate(125%)",
		borderColor: "var(--skerry-glass-border)",
		boxShadow: "var(--skerry-glass-shadow)",
	};
	return (
		<Paper
			variant="outlined"
			{...props}
			sx={[baseSx, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])] as any}
		/>
	);
}
