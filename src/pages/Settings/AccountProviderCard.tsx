import SyncIcon from "@mui/icons-material/Sync";
import {
	Box,
	Chip,
	Divider,
	Paper,
	Stack,
	Switch,
	Typography,
} from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import type { ReactNode } from "react";

type AccountProviderCardProps = {
	wordmark: ReactNode;
	connected: boolean;
	description: ReactNode;
	children: ReactNode;
	sync: {
		title: ReactNode;
		description: ReactNode;
		checked: boolean;
		disabled: boolean;
		onChange: (checked: boolean) => void;
	};
	className?: string;
	paperSx?: SxProps<Theme>;
};

const defaultPaperSx: SxProps<Theme> = {
	p: 2.5,
	borderRadius: 1,
	borderColor: "divider",
};

/** Owns the shared account-provider card layout; providers retain their auth and token flows. */
export function AccountProviderCard({
	wordmark,
	connected,
	description,
	children,
	sync,
	className = "account-provider-card",
	paperSx = defaultPaperSx,
}: AccountProviderCardProps) {
	return (
		<Paper className={className} variant="outlined" sx={paperSx}>
			<Stack
				direction="row"
				justifyContent="space-between"
				alignItems="center"
				className="mb-2"
			>
				{wordmark}
				{!connected && <Chip label="未登录" size="small" variant="outlined" />}
			</Stack>

			<Typography variant="body2" color="text.secondary" className="mb-4">
				{description}
			</Typography>

			<Box className="space-y-4">{children}</Box>

			<Divider className="my-4" />

			<Stack direction="row" justifyContent="space-between" alignItems="center">
				<Box>
					<Stack direction="row" spacing={1} alignItems="center">
						<SyncIcon fontSize="small" color="action" />
						<Typography variant="subtitle2" className="font-semibold">
							{sync.title}
						</Typography>
					</Stack>
					<Typography variant="caption" color="text.secondary">
						{sync.description}
					</Typography>
				</Box>
				<Switch
					checked={sync.checked}
					onChange={(event) => sync.onChange(event.target.checked)}
					disabled={sync.disabled}
					color="primary"
				/>
			</Stack>
		</Paper>
	);
}
