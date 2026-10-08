import { alpha, createTheme } from "@mui/material/styles";

export const skerryTheme = createTheme({
	defaultColorScheme: "dark",
	cssVariables: {
		colorSchemeSelector: "data-toolpad-color-scheme",
	},
	colorSchemes: {
		light: {
			palette: {
				primary: {
					main: "#9a3412",
					light: "#c2410c",
					dark: "#7c2d12",
					contrastText: "#ffffff",
				},
				secondary: {
					main: "#7c3aed",
					light: "#9061f9",
					dark: "#5b21b6",
					contrastText: "#ffffff",
				},
				info: { main: "#7c2d12" },
				success: { main: "#4d7c0f" },
				warning: { main: "#c2410c" },
				error: { main: "#b91c1c" },
				background: {
					default: "#f3efe7",
					paper: "rgba(253,251,246,0.94)",
				},
				text: {
					primary: "#1f2937",
					secondary: "#64748b",
				},
				divider: "#e4dcce",
			},
		},
		dark: {
			palette: {
				primary: {
					main: "#75c9ff",
					light: "#b7e6ff",
					dark: "#2f7df6",
					contrastText: "#06172b",
				},
				secondary: {
					main: "#aaa0ff",
					light: "#d1ccff",
					dark: "#7d73de",
					contrastText: "#121129",
				},
				info: { main: "#65c2ff" },
				success: { main: "#34d399" },
				warning: { main: "#f1bf69" },
				background: {
					default: "#071321",
					paper: "rgba(13,25,40,0.84)",
				},
				text: {
					primary: "#eff7ff",
					secondary: "#9db5cc",
				},
				divider: "rgba(117, 201, 255, 0.16)",
			},
		},
	},
	shape: {
		borderRadius: 14,
	},
	typography: {
		fontFamily:
			'"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
		h1: { letterSpacing: "-0.025em" },
		h2: { letterSpacing: "-0.02em" },
		h3: { letterSpacing: "-0.018em" },
		h4: { letterSpacing: "-0.012em" },
		button: {
			fontWeight: 600,
			textTransform: "none",
			lineHeight: 1,
		},
	},
	components: {
		MuiPaper: {
			styleOverrides: {
				root: {
					backgroundColor: "var(--mui-palette-background-paper)",
					backdropFilter: "blur(22px) saturate(135%)",
					backgroundImage:
						"linear-gradient(135deg, rgba(255,255,255,.18), rgba(255,255,255,0) 48%)",
					border: "1px solid var(--mui-palette-divider)",
					boxShadow: "var(--skerry-glass-shadow)",
				},
			},
		},
		MuiCard: {
			styleOverrides: {
				root: {
					borderRadius: 16,
					backgroundColor: "var(--mui-palette-background-paper)",
					backgroundImage:
						"linear-gradient(135deg, rgba(255,255,255,.16), rgba(255,255,255,0) 48%)",
				},
			},
		},
		MuiAvatar: {
			styleOverrides: {
				rounded: {
					borderRadius: 8,
				},
			},
		},
		MuiButton: {
			defaultProps: {
				disableElevation: true,
			},
			styleOverrides: {
				root: {
					borderRadius: 11,
					lineHeight: 1,
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					verticalAlign: "middle",
					transition:
						"transform 180ms ease, box-shadow 180ms ease, background-color 180ms ease",
					"& .MuiButton-startIcon": {
						display: "inherit",
						alignItems: "center",
						justifyContent: "center",
						marginTop: 1,
					},
					"& .MuiButton-endIcon": {
						display: "inherit",
						alignItems: "center",
						justifyContent: "center",
						marginTop: 1,
					},
				},
				sizeMedium: {
					minHeight: 38,
				},
				contained: ({ ownerState, theme }) => ({
					...(ownerState.size === "medium" && {
						paddingInline: 18,
					}),
					backgroundImage: "none",
			...(ownerState.color === "primary" && {
						background: "linear-gradient(135deg, #2f7df6, #70c7ff 58%, #7d74ff)",
						boxShadow: `0 12px 24px ${alpha("#2f7df6", 0.25)}`,
						...theme.applyStyles("light", {
							background:
								"linear-gradient(135deg, #9a3412, #c2410c 58%, #7c2d12)",
							boxShadow: `0 12px 24px ${alpha("#9a3412", 0.18)}`,
						}),
					}),
					...(ownerState.color === "error" && {
						boxShadow: `0 12px 24px ${alpha(theme.palette.error.main, 0.18)}`,
					}),
				}),
				outlined: ({ ownerState }) => ({
					...(ownerState.size === "medium" && {
						paddingInline: 18,
					}),
					backgroundColor: "transparent",
					...(ownerState.color === "primary" && {
						borderColor: "var(--mui-palette-divider)",
						color: "var(--mui-palette-text-primary)",
									"&:hover": {
										backgroundColor: "color-mix(in srgb, var(--mui-palette-primary-main) 8%, transparent)",
							borderColor: "var(--mui-palette-primary-main)",
							color: "var(--mui-palette-primary-main)",
						},
					}),
				}),
			},
		},
		MuiIconButton: {
			styleOverrides: {
				root: ({ theme }) => ({
					borderRadius: 12,
					transition:
						"background-color 180ms ease, color 180ms ease, border-color 180ms ease, box-shadow 180ms ease, transform 180ms ease",
					"&:hover": {
						backgroundColor: "rgba(0,0,0,0.08)",
					},
					...theme.applyStyles("dark", {
						"&:hover": {
							backgroundColor: "rgba(255,255,255,0.12)",
						},
					}),
				}),
			},
		},
		MuiDialog: {
			styleOverrides: {
				paper: ({ theme }) => ({
					outline: 0,
					"&:focus": {
						outline: 0,
					},
					"&:focus-visible": {
						outline: 0,
					},
					borderRadius: 24,
					backgroundImage: "none",
					backgroundColor: "var(--mui-palette-background-paper)",
					border: "1px solid var(--mui-palette-divider)",
					boxShadow: `0 24px 64px ${alpha("#587083", 0.16)}`,
					...theme.applyStyles("dark", {
						boxShadow: `0 24px 64px ${alpha("#020617", 0.4)}`,
					}),
				}),
			},
		},
		MuiDialogTitle: {
			styleOverrides: {
				root: {
					fontWeight: 700,
					padding: "24px 24px 16px 24px",
				},
			},
		},
		MuiDialogContent: {
			styleOverrides: {
				root: {
					padding: "16px 24px 20px 24px",
					"&.MuiDialogContent-root": {
						paddingTop: "16px !important",
					},
				},
			},
		},
		MuiDialogActions: {
			styleOverrides: {
				root: {
					padding: "16px 24px 24px 24px",
				},
			},
		},
		MuiAppBar: {
			defaultProps: {
				elevation: 0,
			},
			styleOverrides: {
				root: {
					backgroundColor: "var(--mui-palette-background-paper)",
					backgroundImage: "none",
					borderBottom: "1px solid var(--mui-palette-divider)",
					color: "var(--mui-palette-text-primary)",
				},
			},
		},
		MuiMenu: {
			styleOverrides: {
				paper: {
					borderRadius: 8,
					padding: 4,
				},
				list: {
					paddingBlock: 4,
				},
			},
		},
		MuiPopover: {
			styleOverrides: {
				paper: {
					borderRadius: 8,
				},
			},
		},
		MuiAutocomplete: {
			styleOverrides: {
				paper: {
					borderRadius: 8,
				},
			},
		},
		MuiOutlinedInput: {
			styleOverrides: {
				root: {
					"&.Mui-focused .MuiOutlinedInput-notchedOutline": {
						borderWidth: "1px",
					},
				},
			},
		},
		MuiAccordion: {
			styleOverrides: {
				root: {
					backgroundImage: "none",
					backgroundColor: "var(--mui-palette-background-paper)",
					boxShadow: "none",
					border: "1px solid var(--mui-palette-divider)",
					"&:before": {
						display: "none",
					},
				},
			},
		},
		MuiTooltip: {
			styleOverrides: {
				tooltip: {
					backgroundColor: "var(--mui-palette-text-primary)",
					color: "var(--mui-palette-background-default)",
					borderRadius: 8,
				},
			},
		},
		MuiSwitch: {
			styleOverrides: {
				root: {
					width: 40,
					height: 24,
					padding: 0,
					margin: "0 8px",
					display: "flex",
					"&:active": {
						"& .MuiSwitch-thumb": {
							width: 24,
						},
						"& .MuiSwitch-switchBase.Mui-checked": {
							transform: "translateX(12px)",
						},
					},
				},
				sizeSmall: {
					width: 32,
					height: 20,
					margin: "0 4px",
					"& .MuiSwitch-switchBase": {
						padding: 2,
						"&.Mui-checked": {
							transform: "translateX(12px)",
						},
					},
					"& .MuiSwitch-thumb": {
						width: 16,
						height: 16,
					},
					"&:active": {
						"& .MuiSwitch-thumb": {
							width: 20,
						},
						"& .MuiSwitch-switchBase.Mui-checked": {
							transform: "translateX(8px)",
						},
					},
				},
				switchBase: ({ theme }) => ({
					padding: 2,
					"&.Mui-checked": {
						transform: "translateX(16px)",
						color: "#fff",
						"& + .MuiSwitch-track": {
							opacity: 1,
							backgroundColor: "var(--mui-palette-primary-main)",
							...theme.applyStyles("dark", {
								backgroundColor: "var(--mui-palette-primary-main)",
							}),
						},
					},
				}),
				thumb: {
					width: 20,
					height: 20,
					borderRadius: 10,
					boxShadow: "0 2px 6px rgba(31, 90, 164, .22)",
					transition: "transform 180ms ease, box-shadow 180ms ease",
				},
				track: ({ theme }) => ({
					borderRadius: 12,
					opacity: 1,
					backgroundColor: "rgba(0,0,0,.2)",
					boxSizing: "border-box",
					...theme.applyStyles("dark", {
						backgroundColor: "rgba(255,255,255,.35)",
					}),
				}),
			},
		},
		MuiMenuItem: {
			styleOverrides: {
				root: {
					borderRadius: 6,
					gap: 10,
					marginBlock: 2,
					marginLeft: 4,
					marginRight: 4,
					paddingLeft: 8,
					paddingRight: 8,
					minHeight: 32,
					"& .MuiSwitch-root": {
						margin: 0,
					},
				},
			},
		},
		MuiSelect: {
			styleOverrides: {
				root: {
					borderRadius: 14,
				},
			},
		},
		MuiBreadcrumbs: {
			styleOverrides: {
				root: {
					"& .MuiBreadcrumbs-separator": {
						color: "var(--mui-palette-text-secondary)",
					},
				},
				li: {
					"& .MuiLink-root": {
						color: "var(--mui-palette-text-primary)",
						textDecoration: "none",
						transition: "color 0.2s ease-in-out",
						fontWeight: 400,
						cursor: "pointer",
						"&:hover": {
							color: "var(--mui-palette-primary-main)",
							textDecoration: "none",
						},
					},
					"& .MuiTypography-root:not(.MuiLink-root)": {
						color: "var(--mui-palette-text-primary)",
						fontWeight: 700,
					},
				},
			},
		},
		MuiTextField: {
			defaultProps: {
				autoComplete: "off",
			},
		},
		MuiInputBase: {
			defaultProps: {
				inputProps: {
					autoComplete: "off",
					autoCorrect: "off",
					autoCapitalize: "off",
					spellCheck: false,
				},
			},
			styleOverrides: {
				root: {
					"& .MuiInputAdornment-root": {
						userSelect: "none",
						WebkitUserSelect: "none",
					},
				},
				input: {
					"&::placeholder": {
						userSelect: "none",
						WebkitUserSelect: "none",
					},
				},
			},
		},
	},
});
