import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";

type SettingsGroupProps = {
	title: ReactNode;
	description?: ReactNode;
	children: ReactNode;
};

type SettingsItemProps = {
	title: ReactNode;
	description?: ReactNode;
	children: ReactNode;
	stacked?: boolean;
};

export const SettingsGroup = ({
	title,
	description,
	children,
}: SettingsGroupProps) => (
	<Box className="settings-feature-card">
		<Typography variant="subtitle1" component="h3" className="font-semibold">
			{title}
		</Typography>
		{description && (
			<Typography variant="body2" color="text.secondary" className="mt-1">
				{description}
			</Typography>
		)}
		<Box className="mt-4 space-y-4">{children}</Box>
	</Box>
);

export const SettingsItem = ({
	title,
	description,
	children,
	stacked = false,
}: SettingsItemProps) => (
	<Stack
		direction={stacked ? "column" : { xs: "column", sm: "row" }}
		spacing={stacked ? 1.5 : 2}
		alignItems={stacked ? "stretch" : { xs: "stretch", sm: "center" }}
		justifyContent="space-between"
		className="min-w-0"
	>
		<Box className="min-w-0 flex-1">
			<Typography variant="body2" className="font-medium">
				{title}
			</Typography>
			{description && (
				<Typography
					variant="caption"
					color="text.secondary"
					className="mt-1 block"
				>
					{description}
				</Typography>
			)}
		</Box>
		<Box className={stacked ? "min-w-0" : "shrink-0"}>{children}</Box>
	</Stack>
);

export const SettingsDivider = () => <Divider className="my-6" />;
