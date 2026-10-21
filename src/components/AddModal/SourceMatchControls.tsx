import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import type { SxProps, Theme } from "@mui/material/styles";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
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
			className="skerry-source-mode-toggle"
			exclusive
			size="small"
			value={value}
			sx={sx}
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
			label: t("components.AddModal.singleSourceMode", "单源"),
		},
		{ value: "mixed", label: t("components.AddModal.mixedMode", "Mixed") },
		{ value: "custom", label: t("components.AddModal.manualMode", "自定义") },
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
			label: t("components.AddModal.singleSourceMode", "单源"),
		},
		{ value: "mixed", label: t("components.AddModal.mixedMode", "Mixed") },
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
	const label = t("components.AddModal.apiSource", "匹配数据源");

	return (
		<FormControl fullWidth size="small" disabled={disabled} sx={sx}>
			<InputLabel id="single-api-source-label">{label}</InputLabel>
			<Select
				labelId="single-api-source-label"
				value={value}
				label={label}
				onChange={(event) => onChange(event.target.value as SourceType)}
			>
				{SINGLE_SOURCE_OPTIONS.map((option) => (
					<MenuItem key={option.value} value={option.value}>
						{option.label}
					</MenuItem>
				))}
			</Select>
		</FormControl>
	);
}
