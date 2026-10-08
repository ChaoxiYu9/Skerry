# -*- coding: utf-8 -*-
code = '''import Box from "@mui/material/Box";
import FormControl from "@mui/material/FormControl";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import type { SxProps, Theme } from "@mui/material/styles";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { getRuntimeSourceAdapter, SEARCHABLE_SOURCE_KEYS } from "@/metadata";
import type { SourceType } from "@/types";

export type AddGameMode = "single" | "mixed" | "custom";
export type MetadataMatchMode = "single" | "mixed";

interface SourceModeToggleGroupProps<TValue extends string> {
	value: TValue;
	options: readonly { value: TValue; label: string }[];
	onChange: (value: TValue) => void;
	disabled?: boolean;
	sx?: SxProps<Theme>;
}

interface SingleSourceSelectProps {
	value: SourceType;
	onChange: (value: SourceType) => void;
	disabled?: boolean;
	sx?: SxProps<Theme>;
}

const SINGLE_SOURCE_OPTIONS: { value: SourceType; label: string }[] =
	SEARCHABLE_SOURCE_KEYS.map((source) => ({
		value: source,
		label: getRuntimeSourceAdapter(source).label,
	}));

function SourceModeToggleGroup<TValue extends string>({
	value,
	options,
	onChange,
	disabled = false,
	sx,
}: SourceModeToggleGroupProps<TValue>) {
	return (
		<ToggleButtonGroup
			className="p-1 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] border border-[var(--mui-palette-divider)]/40 gap-1 w-full"
			exclusive
			size="small"
			value={value}
			sx={{
				borderRadius: "16px",
				border: "none",
				width: "100%",
				display: "flex",
				"& .MuiToggleButtonGroup-grouped": {
					border: "none !important",
					borderRadius: "12px !important",
					textTransform: "none",
					fontWeight: 700,
					fontSize: "0.8125rem",
					py: 0.8,
					transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
					color: "var(--mui-palette-text-secondary)",
					"&:hover": {
						backgroundColor: "rgba(0, 0, 0, 0.04)",
						color: "var(--mui-palette-text-primary)",
					},
					"&.Mui-selected": {
						background: "linear-gradient(135deg, #E05220 0%, #F16E36 100%) !important",
						color: "#ffffff !important",
						boxShadow: "0 4px 12px rgba(224, 82, 32, 0.25) !important",
					},
				},
				...((sx as object) || {}),
			}}
			onChange={(_, nextValue: TValue | null) => {
				if (nextValue) {
					onChange(nextValue);
				}
			}}
			disabled={disabled}
		>
			{options.map((option) => (
				<ToggleButton
					key={option.value}
					value={option.value}
					sx={{ flex: 1, minWidth: 0 }}
				>
					{option.label}
				</ToggleButton>
			))}
		</ToggleButtonGroup>
	);
}

export function AddGameModeToggleGroup({
	value,
	onChange,
	disabled,
	sx,
}: Omit<SourceModeToggleGroupProps<AddGameMode>, "options">) {
	const { t } = useTranslation();
	const options = [
		{
			value: "single",
			label: t("components.AddModal.singleSourceMode", "单一数据源"),
		},
		{ value: "mixed", label: t("components.AddModal.mixedMode", "聚合多源") },
		{ value: "custom", label: t("components.AddModal.manualMode", "本地自定义") },
	] as const;

	return (
		<SourceModeToggleGroup
			value={value}
			options={options}
			onChange={onChange}
			disabled={disabled}
			sx={sx}
		/>
	);
}

export function MetadataMatchModeToggleGroup({
	value,
	onChange,
	disabled,
	sx,
}: Omit<SourceModeToggleGroupProps<MetadataMatchMode>, "options">) {
	const { t } = useTranslation();
	const options = [
		{
			value: "single",
			label: t("components.AddModal.singleSourceMode", "单一数据源"),
		},
		{ value: "mixed", label: t("components.AddModal.mixedMode", "聚合多源") },
	] as const;

	return (
		<SourceModeToggleGroup
			value={value}
			options={options}
			onChange={onChange}
			disabled={disabled}
			sx={sx}
		/>
	);
}

export function SingleSourceSelect({
	value,
	onChange,
	disabled = false,
	sx,
}: SingleSourceSelectProps) {
	const { t } = useTranslation();

	return (
		<Box className="flex flex-col gap-1.5 w-full">
			<Typography variant="caption" color="text.secondary" className="font-semibold text-[11px] px-1">
				{t("components.AddModal.apiSource", "选择匹配数据源")}
			</Typography>
			<FormControl
				fullWidth
				size="small"
				disabled={disabled}
				sx={{
					"& .MuiOutlinedInput-root": {
						borderRadius: "14px",
						backgroundColor: "rgba(0, 0, 0, 0.02)",
						"&:hover": {
							backgroundColor: "rgba(0, 0, 0, 0.03)",
						},
						"& fieldset": {
							borderColor: "var(--mui-palette-divider)",
						},
					},
					...((sx as object) || {}),
				}}
			>
				<Select
					value={value}
					displayEmpty
					onChange={(event) => onChange(event.target.value as SourceType)}
				>
					{SINGLE_SOURCE_OPTIONS.map((option) => (
						<MenuItem key={option.value} value={option.value}>
							{option.label}
						</MenuItem>
					))}
				</Select>
			</FormControl>
		</Box>
	);
}
'''

with open(r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AddModal\SourceMatchControls.tsx", "w", encoding="utf-8") as f:
    f.write(code)

print("Updated SourceMatchControls.tsx successfully.")
