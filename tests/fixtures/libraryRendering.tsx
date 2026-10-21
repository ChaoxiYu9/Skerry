import i18next from "i18next";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { CardsViewport } from "../../src/components/Cards/CardsViewport";
import { GameListStateView } from "../../src/components/GameListStateView";
import { SearchBox } from "../../src/components/SearchBox";
import { SkerryMotionOutlet } from "../../src/components/SkerryMotionOutlet";
import { DetailFixture, MotionNavigation } from "./libraryMotionPages";
import { useStore } from "./librarySearchData";
import "../../src/styles/4-components/cards-grid.css";
import "../../src/styles/4-components/route-motion.css";
import "../../src/styles/5-pages/library.css";
import "../../src/styles/5-pages/detail.css";

await i18next
	.use(initReactI18next)
	.init({ lng: "zh-CN", resources: { "zh-CN": { translation: {} } } });

const fixtureCover =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='256' height='384'%3E%3Crect width='256' height='384' fill='%238890a0'/%3E%3C/svg%3E";

function GridFixture() {
	const params = new URLSearchParams(window.location.search);
	const count = Number(params.get("count") ?? 10000);
	const ids = useMemo(
		() => Array.from({ length: count }, (_, index) => index + 1),
		[count],
	);
	const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(
		null,
	);
	const gridRef = useRef<HTMLDivElement | null>(null);
	const renderCard = useCallback(
		(_index: number, id: number) => (
			<div
				className="skerry-game-card"
				data-game-card-id={id}
				style={{
					padding: "8px 8px 10px",
					boxSizing: "border-box",
					minWidth: 0,
				}}
			>
				<div style={{ aspectRatio: "2/3" }}>
					<img
						src={fixtureCover}
						alt={`Game ${id}`}
						style={{ display: "block", width: "100%", height: "100%" }}
					/>
				</div>
				<div style={{ height: 70 }}>Game {id}</div>
			</div>
		),
		[],
	);
	return (
		<div
			ref={setScrollContainer}
			data-testid="scroll-container"
			style={{
				height: "100vh",
				overflowY: "auto",
				padding: "16px 0 32px",
				boxSizing: "border-box",
			}}
		>
			{scrollContainer && (
				<CardsViewport
					gameIds={ids}
					scrollContainer={scrollContainer}
					gridRef={gridRef}
					renderCard={renderCard}
				/>
			)}
		</div>
	);
}

function Fixture() {
	const [value, setValue] = useState("");
	const [loading, setLoading] = useState(false);
	return (
		<div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
			<button type="button" onClick={() => setLoading((current) => !current)}>
				Toggle loading
			</button>
			<GameListStateView
				empty={value.length > 0 && value !== "Alpha"}
				loading={loading}
				keepChildrenWhenEmpty
			>
				<input
					aria-label="Search fixture"
					value={value}
					onChange={(event) => setValue(event.target.value)}
				/>
				<div>Library results</div>
			</GameListStateView>
		</div>
	);
}

function SearchFixture() {
	const keyword = useStore((state) => state.searchKeyword);
	return (
		<GameListStateView
			keepChildrenWhenEmpty
			empty={keyword.length > 0 && keyword !== "Alpha"}
		>
			<SearchBox />
			<output data-testid="keyword">{keyword}</output>
		</GameListStateView>
	);
}

function MotionMain({ children }: { children: ReactNode }) {
	const { pathname } = useLocation();
	const library = pathname === "/libraries" || pathname === "/collection";
	const detail =
		pathname.startsWith("/libraries/") || pathname.startsWith("/next-up/");
	const home = pathname === "/";
	return (
		<main
			className={library ? "skerry-main library-page-scroll" : "skerry-main"}
			style={{
				height: "100vh",
				boxSizing: "border-box",
				paddingLeft: home ? 0 : library ? 6 : 20,
				paddingRight: detail ? 5 : library ? 40 : 24,
				overflow: detail || library || home ? "hidden" : "auto",
				background: "#e9e4dd",
			}}
		>
			<style>{`.skerry-motion-root { --skerry-canvas: #e9e4dd; }`}</style>
			{children}
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	const params = new URLSearchParams(window.location.search);
	createRoot(root).render(
		params.has("motion") ? (
			<MemoryRouter initialEntries={[params.get("initial") ?? "/libraries"]}>
				<MotionNavigation />
				<MotionMain>
					<Routes>
						<Route element={<SkerryMotionOutlet />}>
							<Route path="/libraries" element={null} />
							<Route
								path="/libraries/:id"
								element={
									<div
										className="skerry-detail-route-layer"
										style={{ height: "100vh", overflowY: "auto" }}
									>
										<DetailFixture />
									</div>
								}
							/>
							<Route
								path="/next-up/:id"
								element={
									<div
										className="skerry-detail-route-layer"
										style={{ height: "100vh", overflowY: "auto" }}
									>
										<DetailFixture />
									</div>
								}
							/>
							{[
								"/",
								"/collection",
								"/report",
								"/potato-import",
								"/settings",
							].map((path) => (
								<Route key={path} path={path} element={null} />
							))}
						</Route>
					</Routes>
				</MotionMain>
			</MemoryRouter>
		) : params.has("grid") ? (
			<GridFixture />
		) : params.has("search") ? (
			<SearchFixture />
		) : (
			<Fixture />
		),
	);
}
