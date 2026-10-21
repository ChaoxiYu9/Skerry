import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { CardsViewport } from "../../src/components/Cards/CardsViewport";
import {
	animateDetailClose,
	useDetailMotion,
} from "../../src/components/motion/useDetailMotion";

export function Home() {
	return (
		<div style={{ padding: 32 }}>
			<h1>Home fixture</h1>
			<Link data-testid="wish-card" to="/next-up/1">
				Wish plan game
			</Link>
		</div>
	);
}

function Libraries() {
	const ids = useMemo(
		() => Array.from({ length: 200 }, (_, index) => index + 1),
		[],
	);
	const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(
		null,
	);
	const gridRef = useRef<HTMLDivElement | null>(null);
	const renderCard = useCallback(
		(_index: number, id: number) => (
			<Link
				className="skerry-game-card"
				data-game-card-id={id}
				to={`/libraries/${id}`}
				style={{ display: "block", height: 320, background: "#778899" }}
			>
				Game {id}
			</Link>
		),
		[],
	);
	return (
		<div className="library-page-shell">
			<div
				className="cards-control-bar"
				data-testid="library-toolbar"
				style={{ height: 72 }}
			>
				<button type="button">Search / Filter</button>
			</div>
			<div
				ref={setScrollContainer}
				className="cards-scroll-region"
				data-testid="motion-scroll"
				style={{ height: "calc(100vh - 100px)", overflowY: "auto" }}
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
		</div>
	);
}

export function DetailFixture() {
	const location = useLocation();
	const navigate = useNavigate();
	const delayed = new URLSearchParams(window.location.search).has("delayed");
	const [ready, setReady] = useState(!delayed);
	const [revision, setRevision] = useState(0);
	const ref = useDetailMotion(location.pathname, ready);
	useEffect(() => {
		if (!delayed) return;
		const timer = window.setTimeout(() => setReady(true), 220);
		return () => window.clearTimeout(timer);
	}, [delayed]);
	if (!ready) return <div data-testid="detail-loading">Loading</div>;
	return (
		<div
			ref={ref}
			className="skerry-detail-page"
			data-detail-motion-key={location.pathname}
			style={{ background: "#e9e4dd", minHeight: "100%" }}
		>
			<div
				className="detail-hero"
				style={{
					height: 390,
					paddingTop: 0,
					position: "relative",
					overflow: "hidden",
					background: "#586f80",
				}}
			>
				<div
					className="detail-hero-bg"
					style={{
						position: "absolute",
						inset: 0,
						background: "linear-gradient(135deg,#426575,#cbbdb2)",
					}}
				/>
				<div
					style={{
						display: "flex",
						gap: 28,
						position: "relative",
						padding: 50,
						alignItems: "end",
					}}
				>
					<div
						className="detail-poster"
						style={{ width: 170, height: 255, background: "#354753" }}
					/>
					<div className="detail-copy-group">
						<h1>
							{location.pathname.startsWith("/next-up/")
								? "Wish plan detail"
								: "Library detail"}
						</h1>
						<p>Shared detail entrance</p>
					</div>
					<div className="detail-action-group">
						<button
							data-testid="detail-back"
							type="button"
							onClick={() =>
								animateDetailClose({ onComplete: () => navigate(-1) })
							}
						>
							Back
						</button>
					</div>
				</div>
			</div>
			<div className="detail-body" style={{ padding: 30, display: "block" }}>
				<h2>Overview</h2>
				<p>Ready data revision {revision}</p>
				<button
					type="button"
					data-testid="refresh-detail"
					onClick={() => setRevision((value) => value + 1)}
				>
					Refresh data
				</button>
			</div>
		</div>
	);
}

export function MotionNavigation() {
	const navigate = useNavigate();
	return (
		<nav
			style={{
				position: "fixed",
				bottom: 12,
				right: 12,
				zIndex: 9999,
				background: "white",
			}}
		>
			{[
				"/",
				"/libraries",
				"/collection",
				"/report",
				"/potato-import",
				"/settings",
			].map((path) => (
				<button
					key={path}
					type="button"
					data-testid={"nav-" + (path.slice(1) || "home")}
					onClick={() =>
						animateDetailClose({ onComplete: () => navigate(path) })
					}
				>
					{path}
				</button>
			))}
			<button
				type="button"
				data-testid="history-back"
				onClick={() => navigate(-1)}
			>
				History back
			</button>
		</nav>
	);
}

function PrimaryPage({ name }: { name: string }) {
	return (
		<div style={{ padding: 32 }}>
			<h1>{name}</h1>
			<p>Page fixture</p>
		</div>
	);
}
export const loadLibrariesPage = async () => ({ default: Libraries });
export const loadCollectionPage = async () => ({
	default: () => <PrimaryPage name="Collection" />,
});
export const loadAnnualReportPage = async () => ({
	default: () => <PrimaryPage name="Report" />,
});
export const loadPotatoImportPage = async () => ({
	default: () => <PrimaryPage name="Import" />,
});
export const loadSettingsPage = async () => {
	await new Promise((resolve) => window.setTimeout(resolve, 1200));
	return { default: () => <PrimaryPage name="Settings" /> };
};
export const preloadDetailPage = () => {};
