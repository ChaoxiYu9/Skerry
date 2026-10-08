import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import AccountCircleOutlinedIcon from "@mui/icons-material/AccountCircleOutlined";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import PaletteOutlinedIcon from "@mui/icons-material/PaletteOutlined";
import SettingsSuggestOutlinedIcon from "@mui/icons-material/SettingsSuggestOutlined";
import StorageRoundedIcon from "@mui/icons-material/StorageRounded";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PathSettingsModal } from "@/components/PathSettingsModal";
import { useScrollRestore } from "@/hooks/common/useScrollRestore";
import { AboutSection } from "./AboutSettings";
import { AccountSettings } from "./AccountSettings";
import {
	DevSettings,
	MixedSearchSourceSettings,
	VndbDataSettings,
} from "./DataSourceSettings";
import { ModeSelectionSettings, NsfwSettings } from "./GeneralSettings";
import { DatabaseBackupSettings } from "./MaintenanceSettings";
import { SettingsDivider, SettingsGroup, SettingsItem } from "./SettingsLayout";
import {
	AutoStartSettings,
	CloseBtnSettings,
	LinuxLaunchCommandSettings,
	LogLevelSettings,
	ProxySettings,
	TimeTrackingModeSettings,
} from "./SystemSettings";

type SettingsSection = {
	id: string;
	label: string;
	subLabel?: string;
	description: string;
	icon?: React.ReactNode;
	content: React.ReactNode;
	frame?: "card" | "plain";
};

/**
 * Settings 组件
 * 应用设置页面，组织各设置分区。
 */
export const Settings: React.FC = () => {
	const { t } = useTranslation();
	useScrollRestore("/settings");
	const [pathSettingsModalOpen, setPathSettingsModalOpen] = useState(false);
	const [activeSectionId, setActiveSectionId] = useState("account");
	const settingsContentRef = useRef<HTMLDivElement | null>(null);
	const activeSectionFrameRef = useRef<number | null>(null);
	const sections = useMemo<SettingsSection[]>(
		() => [
			{
				id: "account",
				label: t("pages.Settings.sections.account", "账号与同步"),
				subLabel: "ACCOUNT",
				icon: <AccountCircleOutlinedIcon fontSize="small" />,
				description: t(
					"pages.Settings.sections.accountDescription",
					"管理数据源账号令牌和收藏同步行为。",
				),
				frame: "plain",
				content: <AccountSettings />,
			},
			{
				id: "data-source",
				label: t("pages.Settings.sections.dataSource", "数据源"),
				subLabel: "SOURCES",
				icon: <StorageRoundedIcon fontSize="small" />,
				description: t(
					"pages.Settings.sections.dataSourceDescription",
					"配置搜索源、VNDB 数据处理和批量数据维护。",
				),
				content: (
					<>
						<MixedSearchSourceSettings />
						<VndbDataSettings />
						<DevSettings />
					</>
				),
			},
			{
				id: "display",
				label: t("pages.Settings.sections.display", "显示与交互"),
				subLabel: "APPEARANCE",
				icon: <PaletteOutlinedIcon fontSize="small" />,
				description: t(
					"pages.Settings.sections.displayDescription",
					"调整内容过滤和游戏卡片交互方式。",
				),
				content: (
					<Box className="space-y-5">
						<ModeSelectionSettings />
						<NsfwSettings />
					</Box>
				),
			},
			{
				id: "system",
				label: t("pages.Settings.sections.system", "系统"),
				subLabel: "SYSTEM",
				icon: <SettingsSuggestOutlinedIcon fontSize="small" />,
				description: t(
					"pages.Settings.sections.systemDescription",
					"管理启动、日志、关闭行为和计时模式。",
				),
				content: (
					<Box className="space-y-5">
						<AutoStartSettings />
						<LogLevelSettings />
						<ProxySettings />
						<CloseBtnSettings />
						<TimeTrackingModeSettings />
						{import.meta.env.TAURI_ENV_PLATFORM === "linux" && (
							<>
								<SettingsDivider />
								<LinuxLaunchCommandSettings />
							</>
						)}
					</Box>
				),
			},
			{
				id: "storage",
				label: t("pages.Settings.sections.storage", "路径与备份"),
				subLabel: "STORAGE",
				icon: <FolderOpenRoundedIcon fontSize="small" />,
				description: t(
					"pages.Settings.sections.storageDescription",
					"配置本地路径，执行数据备份和恢复。",
				),
				content: (
					<>
						<SettingsGroup
							title={t("pages.Settings.pathSettings.title", "路径设置")}
						>
							<SettingsItem
								stacked
								title={t(
									"pages.Settings.pathSettings.openModal",
									"打开路径设置",
								)}
								description={t(
									"pages.Settings.pathSettings.note",
									"配置游戏存档备份、数据库备份、LE转区软件、Magpie软件等路径",
								)}
							>
								<Button
									variant="outlined"
									onClick={() => setPathSettingsModalOpen(true)}
									className="px-4 py-2"
								>
									{t("pages.Settings.pathSettings.openModal", "打开路径设置")}
								</Button>
							</SettingsItem>
						</SettingsGroup>
						<DatabaseBackupSettings />
					</>
				),
			},
			{
				id: "about",
				label: t("pages.Settings.sections.about", "关于"),
				subLabel: "ABOUT",
				icon: <InfoOutlinedIcon fontSize="small" />,
				description: t(
					"pages.Settings.sections.aboutDescription",
					"查看版本、更新状态、文档和反馈入口。",
				),
				content: <AboutSection />,
			},
		],
		[t],
	);

	useEffect(() => {
		const sectionElements = sections
			.map((section) => document.getElementById(section.id))
			.filter((element): element is HTMLElement => Boolean(element));

		const observer = new IntersectionObserver(
			(entries) => {
				const visibleEntry = entries
					.filter((entry) => entry.isIntersecting)
					.toSorted((a, b) => b.intersectionRatio - a.intersectionRatio)
					.at(0);

				if (visibleEntry) {
					const nextSectionId = visibleEntry.target.id;
					if (activeSectionFrameRef.current !== null) {
						window.cancelAnimationFrame(activeSectionFrameRef.current);
					}
					activeSectionFrameRef.current = window.requestAnimationFrame(() => {
						activeSectionFrameRef.current = null;
						setActiveSectionId((current) =>
							current === nextSectionId ? current : nextSectionId,
						);
					});
				}
			},
			{
				root: document.querySelector("main"),
				rootMargin: "-16px 0px -70% 0px",
				threshold: [0.1, 0.3, 0.6],
			},
		);

		for (const element of sectionElements) {
			observer.observe(element);
		}

		return () => {
			observer.disconnect();
			if (activeSectionFrameRef.current !== null) {
				window.cancelAnimationFrame(activeSectionFrameRef.current);
				activeSectionFrameRef.current = null;
			}
		};
	}, [sections]);

	const handleSectionClick = (sectionId: string) => {
		const target = document.getElementById(sectionId);
		const container = settingsContentRef.current?.closest("main");

		if (!target) return;

		if (container) {
			const containerRect = container.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			container.scrollTo({
				top: container.scrollTop + targetRect.top - containerRect.top - 76,
				behavior: "smooth",
			});
			return;
		}

		target.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	return (
		<Box className="w-full max-w-full">
			<Box className="settings-workspace">
				<Box className="settings-workspace-grid">
					<nav
						className="settings-section-nav"
						aria-label={t("pages.Settings.navigation", "设置分类导航")}
					>
						<Box className="settings-nav-header">
							<Typography className="settings-nav-kicker">PREFERENCES</Typography>
							<Typography className="settings-nav-title">设置分类</Typography>
						</Box>
						<Box className="settings-section-nav-list">
							{sections.map((section) => {
								const isActive = section.id === activeSectionId;

								return (
									<button
										key={section.id}
										type="button"
										onClick={() => handleSectionClick(section.id)}
										className={`settings-section-nav-button ${isActive ? "is-active" : ""}`}
									>
										{section.icon ? (
											<span className="settings-nav-item-icon">
												{section.icon}
											</span>
										) : null}
										<span className="settings-nav-item-text">
											<span className="settings-nav-item-label">
												{section.label}
											</span>
											{section.subLabel ? (
												<span className="settings-nav-item-sub">
													{section.subLabel}
												</span>
											) : null}
										</span>
									</button>
								);
							})}
						</Box>
					</nav>

					<Box ref={settingsContentRef} className="settings-content-scroll">
						{sections.map((section) => (
							<section
								key={section.id}
								id={section.id}
								className="settings-section-block scroll-mt-24 lg:scroll-mt-24"
							>
								<Box className="settings-section-heading mb-3">
									<Typography
										variant="h6"
										component="h2"
										className="font-semibold"
									>
										{section.label}
									</Typography>
									<Typography
										variant="body2"
										color="text.secondary"
										className="mt-1"
									>
										{section.description}
									</Typography>
								</Box>
								{section.content}
							</section>
						))}
					</Box>
				</Box>
			</Box>

			{/* 路径设置弹窗 */}
			<PathSettingsModal
				open={pathSettingsModalOpen}
				onClose={() => setPathSettingsModalOpen(false)}
				inSettingsPage={true}
			/>
		</Box>
	);
};
