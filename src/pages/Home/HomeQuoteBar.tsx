import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Chip from "@mui/material/Chip";
import AutorenewRoundedIcon from "@mui/icons-material/AutorenewRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import ArrowForwardRoundedIcon from "@mui/icons-material/ArrowForwardRounded";
import { useContentSwapMotion } from "@/components/motion/useContentSwapMotion";

export interface GalgameQuote {
	id: string;
	text: string;
	work: string;
	company: string;
	custom?: boolean;
}

const DEFAULT_QUOTES: GalgameQuote[] = [
	{
		id: "def-0",
		text: "Skerry｜漂泊于世间，归栖于此间。",
		work: "",
		company: "",
	},
	{
		id: "def-1",
		text: "世界上并没有什么奇迹，有的只是必然和偶然，还有谁做了什么。",
		work: "悠久之翼 (ef)",
		company: "minori",
	},
	{
		id: "def-2",
		text: "那是何等荒谬，却也是我生涯中最棒的歌剧啊。",
		work: "神怒之日~为爱痴狂~",
		company: "light",
	},
	{
		id: "def-3",
		text: "为什么会变成这样呢……第一次有了喜欢的人，有了能做一辈子朋友的人。",
		work: "白色相簿2",
		company: "Leaf",
	},
	{
		id: "def-4",
		text: "这一切，都是命运石之门的选择。El Psy Kongroo。",
		work: "命运石之门",
		company: "5pb. / Nitro+",
	},
	{
		id: "def-5",
		text: "在这樱花飞舞的世界里，我愿寻找那抹属于生命的色彩。",
		work: "樱之诗",
		company: "枕 (Makura)",
	},
	{
		id: "def-6",
		text: "某个角落，就你和我。",
		work: "恋狱月狂病",
		company: "Innocent Grey",
	},
	{
		id: "def-7",
		text: "唯有那片绚烂的夏之蔚蓝，永远不会褪色。",
		work: "Summer Pockets",
		company: "Key",
	},
	{
		id: "def-8",
		text: "赎罪交织，弦上终曲。",
		work: "G弦上的魔王",
		company: "AKABEiSOFT2",
	},
	{
		id: "def-9",
		text: "夏天结束了，但向日葵盛开的记忆永远留在这里。",
		work: "向日葵的教会与长长的暑假",
		company: "枕 (Makura)",
	},
	{
		id: "def-10",
		text: "响彻天际的雷霆，你也是我的英雄。",
		work: "Silverio Vendetta",
		company: "light",
	},
	{
		id: "def-11",
		text: "在地球最后的日子里，我只要能陪伴在你的身边。",
		work: "eden*",
		company: "minori",
	},
	{
		id: "def-12",
		text: "飞向天空的彼端，寻找风停息的地方。",
		work: "苍之彼方的四重奏",
		company: "sprite",
	},
	{
		id: "def-13",
		text: "梦生梦死梦中人，梦言梦语梦之话。",
		work: "相州战神馆学园 万仙阵",
		company: "light",
	},
	{
		id: "def-14",
		text: "无论多么微小的愿望，只要彼此相信，就能化作前行的力量。",
		work: "星空列车与白的旅行",
		company: "Shiratamaco",
	},
];

const STORAGE_KEY = "skerry_custom_quotes_v1";

function loadStoredQuotes(): GalgameQuote[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveStoredQuotes(quotes: GalgameQuote[]) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(quotes));
	} catch (error) {
		console.error("保存自定义文案失败:", error);
	}
}

interface HomeQuoteBarProps {
	onNavigateToLibrary: () => void;
}

// 模块级标记：记录软件当前会话是否为初次启动挂载
let isAppFirstLaunch = true;

// 供页面切换返回时调用的组件定义
export const HomeQuoteBar: React.FC<HomeQuoteBarProps> = ({ onNavigateToLibrary }) => {
	const location = useLocation();
	const prevPathRef = useRef(location.pathname);
	const [customQuotes, setCustomQuotes] = useState<GalgameQuote[]>(() => loadStoredQuotes());
	const [currentIndex, setCurrentIndex] = useState(0);
	const [animCounter, setAnimCounter] = useState(0);

	// Dialog states
	const [dialogOpen, setDialogOpen] = useState(false);
	const [activeTab, setActiveTab] = useState(0);

	// Add quote inputs
	const [textInput, setTextInput] = useState("");
	const [workInput, setWorkInput] = useState("");
	const [companyInput, setCompanyInput] = useState("");

	// Edit quote states
	const [editDialogOpen, setEditDialogOpen] = useState(false);
	const [editingQuote, setEditingQuote] = useState<GalgameQuote | null>(null);
	const [editText, setEditText] = useState("");
	const [editWork, setEditWork] = useState("");
	const [editCompany, setEditCompany] = useState("");

	const allQuotes = useMemo(() => {
		return [...customQuotes, ...DEFAULT_QUOTES];
	}, [customQuotes]);

	// 初次打开软件首发显示专属标语
	useEffect(() => {
		if (allQuotes.length === 0) return;
		if (isAppFirstLaunch) {
			isAppFirstLaunch = false;
			const defaultIndex = allQuotes.findIndex((q) => q.id === "def-0");
			setCurrentIndex(defaultIndex >= 0 ? defaultIndex : 0);
		}
	}, [allQuotes]);

	// 监听路由：因首页属于常驻缓存层（不随切页卸载），从其他页面返回首页时动态随机刷新文案并播放动画
	useEffect(() => {
		if (location.pathname === "/" && prevPathRef.current !== "/") {
			if (allQuotes.length > 1) {
				let nextIndex = Math.floor(Math.random() * allQuotes.length);
				if (nextIndex === currentIndex) {
					nextIndex = (currentIndex + 1) % allQuotes.length;
				}
				setCurrentIndex(nextIndex);
				setAnimCounter((prev) => prev + 1);
			}
		}
		prevPathRef.current = location.pathname;
	}, [location.pathname, allQuotes, currentIndex]);

	const currentQuote = allQuotes[currentIndex] ?? DEFAULT_QUOTES[0];

	// Animate whenever currentQuote or animCounter changes
	const contentSwapRef = useContentSwapMotion<HTMLDivElement>(
		`${currentQuote.id}-${animCounter}`
	);

	const handleNextQuote = useCallback(() => {
		if (allQuotes.length <= 1) return;
		let nextIndex = Math.floor(Math.random() * allQuotes.length);
		if (nextIndex === currentIndex) {
			nextIndex = (currentIndex + 1) % allQuotes.length;
		}
		setCurrentIndex(nextIndex);
		setAnimCounter((prev) => prev + 1);
	}, [allQuotes.length, currentIndex]);

	const handleOpenManage = () => {
		setActiveTab(1);
		setDialogOpen(true);
	};

	const handleSaveQuote = () => {
		const trimmedText = textInput.trim();
		const trimmedWork = workInput.trim();
		const trimmedCompany = companyInput.trim();
		if (!trimmedText || !trimmedWork) return;

		const newQuote: GalgameQuote = {
			id: "custom-" + Date.now(),
			text: trimmedText,
			work: trimmedWork,
			company: trimmedCompany || "未知会社",
			custom: true,
		};

		const nextCustom = [newQuote, ...customQuotes];
		setCustomQuotes(nextCustom);
		saveStoredQuotes(nextCustom);
		setTextInput("");
		setWorkInput("");
		setCompanyInput("");
		setCurrentIndex(0);
		setAnimCounter((prev) => prev + 1);
		setDialogOpen(false);
	};

	const handleOpenEdit = (quote: GalgameQuote) => {
		if (!quote.custom) return; // Locked default quotes cannot be edited
		setEditingQuote(quote);
		setEditText(quote.text);
		setEditWork(quote.work);
		setEditCompany(quote.company);
		setEditDialogOpen(true);
	};

	const handleSaveEdit = () => {
		if (!editingQuote) return;
		const trimmedText = editText.trim();
		const trimmedWork = editWork.trim();
		const trimmedCompany = editCompany.trim();
		if (!trimmedText || !trimmedWork) return;

		const nextCustom = customQuotes.map((q) => {
			if (q.id === editingQuote.id) {
				return {
					...q,
					text: trimmedText,
					work: trimmedWork,
					company: trimmedCompany || "未知会社",
				};
			}
			return q;
		});

		setCustomQuotes(nextCustom);
		saveStoredQuotes(nextCustom);
		setAnimCounter((prev) => prev + 1);
		setEditDialogOpen(false);
		setEditingQuote(null);
	};

	const handleDeleteCustomQuote = (id: string) => {
		const nextCustom = customQuotes.filter((q) => q.id !== id);
		setCustomQuotes(nextCustom);
		saveStoredQuotes(nextCustom);
		if (currentIndex >= nextCustom.length + DEFAULT_QUOTES.length) {
			setCurrentIndex(0);
		}
		setAnimCounter((prev) => prev + 1);
	};

	return (
		<>
			<Box
				className="home-quote-banner"
				sx={{
					gridColumn: "1 / -1",
					width: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 1.5,
					height: 48,
					minHeight: 48,
					py: 0.5,
					px: { xs: 1, sm: 2 },
					boxSizing: "border-box",
					overflow: "visible",
				}}
			>
				{/* 左侧：操作图标组 + 文案胶囊（紧贴文案） */}
				<Box
					sx={{
						display: "flex",
						alignItems: "center",
						gap: 1.25,
						minWidth: 0,
						flex: "1 1 auto",
						overflow: "visible",
					}}
				>
					{/* 左侧紧贴的操作按钮：换一句、设置（文案管理） */}
					<Box
						sx={{
							display: "inline-flex",
							alignItems: "center",
							gap: 0.75,
							flexShrink: 0,
						}}
					>
						<Tooltip title="换一句文案">
							<IconButton
								onClick={handleNextQuote}
								size="small"
								className="home-quote-action-btn"
								sx={{
									width: 38,
									height: 38,
									minWidth: 38,
									minHeight: 38,
									borderRadius: "999px",
									p: 0,
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									outline: "none !important",
									"&:focus, &:focus-visible": {
										outline: "none !important",
									},
									"&:hover": {
										transform: "rotate(45deg)",
									},
								}}
							>
								<AutorenewRoundedIcon sx={{ fontSize: 18 }} />
							</IconButton>
						</Tooltip>

						<Tooltip title="文案管理">
							<IconButton
								onClick={handleOpenManage}
								size="small"
								className="home-quote-action-btn"
								sx={{
									width: 38,
									height: 38,
									minWidth: 38,
									minHeight: 38,
									borderRadius: "999px",
									p: 0,
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									outline: "none !important",
									"&:focus, &:focus-visible": {
										outline: "none !important",
									},
								}}
							>
								<TuneRoundedIcon sx={{ fontSize: 18 }} />
							</IconButton>
						</Tooltip>
					</Box>

					{/* 文案胶囊（带进场平滑过渡动画） */}
					<Box
						ref={contentSwapRef}
						className="home-quote-content-container"
						sx={{
							display: "inline-flex",
							alignItems: "center",
							height: 38,
							minHeight: 38,
							maxHeight: 38,
							maxWidth: "calc(100% - 90px)",
							px: 2,
							py: 0,
							borderRadius: "10px",
							backdropFilter: "blur(16px)",
							overflow: "visible",
							boxSizing: "border-box",
							flexShrink: 1,
							cursor: "default",
						}}
					>
						<Box
							sx={{
								width: 3,
								height: 16,
								borderRadius: "2px",
								bgcolor: "primary.main",
								flexShrink: 0,
								mr: 1.25,
							}}
						/>
						<Typography
							component="span"
							noWrap
							sx={{
								fontSize: "0.86rem",
								color: "text.primary",
								fontWeight: 550,
								letterSpacing: "0.01em",
								minWidth: 0,
								flexShrink: 1,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								lineHeight: 1.2,
							}}
						>
							{currentQuote.text}
						</Typography>
						{(currentQuote.work || currentQuote.company) ? (
							<Typography
								component="span"
								noWrap
								sx={{
									fontSize: "0.8rem",
									color: "text.secondary",
									fontWeight: 500,
									flexShrink: 0,
									ml: 1.75,
									whiteSpace: "nowrap",
									lineHeight: 1.2,
									opacity: 0.88,
								}}
							>
								——{currentQuote.work ? `《${currentQuote.work}》` : ""}{currentQuote.company ? (currentQuote.work ? ` · ${currentQuote.company}` : currentQuote.company) : ""}
							</Typography>
						) : null}
					</Box>
				</Box>

				{/* 右侧：进入游戏库胶囊按钮 */}
				<Button
					variant="contained"
					onClick={onNavigateToLibrary}
					endIcon={<ArrowForwardRoundedIcon sx={{ fontSize: 16 }} />}
					className="home-header-library-btn"
					sx={{
						borderRadius: "999px",
						px: 2.2,
						height: 38,
						minHeight: 38,
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						fontSize: "0.85rem",
						fontWeight: 700,
						flexShrink: 0,
						textTransform: "none",
						boxShadow: "none",
						background: "linear-gradient(135deg, var(--mui-palette-primary-main) 0%, color-mix(in srgb, var(--mui-palette-primary-main) 75%, black) 100%)",
						"&:hover": {
							boxShadow: "0 4px 14px rgba(82, 204, 195, 0.28)",
						},
					}}
				>
					打开游戏库
				</Button>
			</Box>

			{/* 文案管理弹窗 */}
			<Dialog
				open={dialogOpen}
				onClose={() => setDialogOpen(false)}
				maxWidth="sm"
				fullWidth
				PaperProps={{
					sx: {
						borderRadius: 3.5,
						backgroundImage: "none",
						bgcolor: "background.paper",
						p: 1,
					},
				}}
			>
				<DialogTitle sx={{ fontWeight: 800, fontSize: "1.18rem", pb: 1 }}>
					文案管理
				</DialogTitle>

				<Box sx={{ borderBottom: 1, borderColor: "divider", px: 3 }}>
					<Tabs
						value={activeTab}
						onChange={(_, val) => setActiveTab(val)}
						sx={{ minHeight: 40 }}
					>
						<Tab label="录入新文案" sx={{ minHeight: 40, py: 1, fontWeight: 700 }} />
						<Tab
							label={`文案列表 (${allQuotes.length})`}
							sx={{ minHeight: 40, py: 1, fontWeight: 700 }}
						/>
					</Tabs>
				</Box>

				<DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "16px !important" }}>
					{activeTab === 0 ? (
						<>
							<TextField
								label="文案内容"
								multiline
								rows={3}
								value={textInput}
								onChange={(e) => setTextInput(e.target.value)}
								placeholder="例如：世界上并没有什么奇迹，有的只是必然和偶然，还有谁做了什么。"
								fullWidth
								required
							/>
							<Box sx={{ display: "flex", gap: 2 }}>
								<TextField
									label="作品名字"
									value={workInput}
									onChange={(e) => setWorkInput(e.target.value)}
									placeholder="例如：悠久之翼 (ef)"
									fullWidth
									required
								/>
								<TextField
									label="制作会社"
									value={companyInput}
									onChange={(e) => setCompanyInput(e.target.value)}
									placeholder="例如：minori"
									fullWidth
								/>
							</Box>
							<Typography variant="caption" sx={{ color: "text.secondary", mt: 0.5 }}>
								提示：自由录入的文案将保存在本地文案库中，可随时修改或删除。系统内置的 15 句文案保持锁定保护。
							</Typography>
						</>
					) : (
						<Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
							<Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
								<Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 700 }}>
									内置默认文案 15 句 (锁定) · 自定义文案 {customQuotes.length} 句
								</Typography>
							</Box>
							<Box
								sx={{
									maxHeight: 340,
									overflowY: "auto",
									display: "flex",
									flexDirection: "column",
									gap: 1,
									pr: 0.5,
									scrollbarWidth: "none",
									msOverflowStyle: "none",
									"&::-webkit-scrollbar": {
										display: "none",
									},
								}}
							>
								{allQuotes.map((q) => {
									const isCustom = Boolean(q.custom);
									return (
										<Box
											key={q.id}
											sx={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												p: 1.25,
												borderRadius: 2,
												bgcolor: "action.hover",
												border: "1px solid var(--mui-palette-divider)",
											}}
										>
											<Box sx={{ minWidth: 0, flex: 1, mr: 1 }}>
												<Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
													{isCustom ? (
														<Chip
															label="自定义"
															size="small"
															color="primary"
															sx={{ height: 20, fontSize: "0.7rem", fontWeight: 700 }}
														/>
													) : (
														<Chip
															icon={<LockRoundedIcon sx={{ fontSize: "12px !important" }} />}
															label="内置锁定"
															size="small"
															sx={{
																height: 20,
																fontSize: "0.7rem",
																fontWeight: 700,
																opacity: 0.85,
															}}
														/>
													)}
													{(q.work || q.company) ? (
														<Typography
															variant="caption"
															color="text.secondary"
															noWrap
															sx={{ fontWeight: 600 }}
														>
															{q.work ? `《${q.work}》` : ""}{q.company ? (q.work ? ` · ${q.company}` : q.company) : ""}
														</Typography>
													) : null}
												</Box>
												<Typography
													variant="body2"
													sx={{
														fontSize: "0.84rem",
														color: "text.primary",
														lineHeight: 1.4,
													}}
												>
													“{q.text}”
												</Typography>
											</Box>

											<Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexShrink: 0 }}>
												{isCustom ? (
													<>
														<Tooltip title="修改该文案">
															<IconButton
																size="small"
																onClick={() => handleOpenEdit(q)}
																sx={{ color: "text.secondary", "&:hover": { color: "primary.main" } }}
															>
																<EditRoundedIcon fontSize="small" />
															</IconButton>
														</Tooltip>
														<Tooltip title="删除该文案">
															<IconButton
																size="small"
																color="error"
																onClick={() => handleDeleteCustomQuote(q.id)}
															>
																<DeleteOutlineRoundedIcon fontSize="small" />
															</IconButton>
														</Tooltip>
													</>
												) : (
													<Tooltip title="内置默认文案已锁定，不可修改或删除">
														<span>
															<IconButton size="small" disabled sx={{ opacity: 0.4 }}>
																<LockRoundedIcon fontSize="small" />
															</IconButton>
														</span>
													</Tooltip>
												)}
											</Box>
										</Box>
									);
								})}
							</Box>
						</Box>
					)}
				</DialogContent>
				<DialogActions sx={{ px: 3, pb: 2 }}>
					<Button
						onClick={() => setDialogOpen(false)}
						color="inherit"
						sx={{ borderRadius: "999px" }}
					>
						关闭
					</Button>
					{activeTab === 0 && (
						<Button
							onClick={handleSaveQuote}
							variant="contained"
							disabled={!textInput.trim() || !workInput.trim()}
							sx={{ borderRadius: "999px", px: 3 }}
						>
							保存并展示
						</Button>
					)}
				</DialogActions>
			</Dialog>

			{/* 修改自定义文案弹窗 */}
			<Dialog
				open={editDialogOpen}
				onClose={() => setEditDialogOpen(false)}
				maxWidth="sm"
				fullWidth
				PaperProps={{
					sx: {
						borderRadius: 3.5,
						backgroundImage: "none",
						bgcolor: "background.paper",
						p: 1,
					},
				}}
			>
				<DialogTitle sx={{ fontWeight: 800, fontSize: "1.15rem" }}>
					编辑自定义文案
				</DialogTitle>
				<DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2.2, pt: "10px !important" }}>
					<TextField
						label="文案内容"
						multiline
						rows={3}
						value={editText}
						onChange={(e) => setEditText(e.target.value)}
						fullWidth
						required
					/>
					<Box sx={{ display: "flex", gap: 2 }}>
						<TextField
							label="作品名字"
							value={editWork}
							onChange={(e) => setEditWork(e.target.value)}
							fullWidth
							required
						/>
						<TextField
							label="制作会社"
							value={editCompany}
							onChange={(e) => setEditCompany(e.target.value)}
							fullWidth
						/>
					</Box>
				</DialogContent>
				<DialogActions sx={{ px: 3, pb: 2 }}>
					<Button
						onClick={() => setEditDialogOpen(false)}
						color="inherit"
						sx={{ borderRadius: "999px" }}
					>
						取消
					</Button>
					<Button
						onClick={handleSaveEdit}
						variant="contained"
						disabled={!editText.trim() || !editWork.trim()}
						sx={{ borderRadius: "999px", px: 3 }}
					>
						保存修改
					</Button>
				</DialogActions>
			</Dialog>
		</>
	);
};
