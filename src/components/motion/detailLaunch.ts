import gsap from "gsap";
import { preloadDetailPage } from "@/providers/routePreloads";
import { wasRecentlyResumed } from "@/providers/webviewKeepAlive";

const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const SKIP_NEXT_ROUTE_MOTION_KEY = "skerry-skip-next-route-motion";

interface DetailLaunchOptions {
	cardId?: number;
	target?: HTMLElement | null;
	onComplete: () => void;
}

interface DetailCloseOptions {
	onComplete: () => void;
}

function resolveTarget(options: DetailLaunchOptions): HTMLElement | null {
	if (options.target) return options.target;
	if (typeof options.cardId !== "number") return null;
	const cards = Array.from(
		document.querySelectorAll<HTMLElement>(
			'[data-game-card-id="' + options.cardId + '"]',
		),
	);
	const card =
		cards.find((element) => {
			const rect = element.getBoundingClientRect();
			return (
				rect.width > 0 &&
				rect.height > 0 &&
				!element.closest(".skerry-primary-route-layer:not(.is-active)") &&
				!element.closest("[aria-hidden='true']")
			);
		}) ?? cards.find((element) => element.getBoundingClientRect().width > 0);
	return (
		card?.querySelector<HTMLElement>(
			".detail-launch-source, .game-card-cover",
		) ?? card ?? null
	);
}

export function animateDetailLaunch(options: DetailLaunchOptions) {
	preloadDetailPage();
	const target = resolveTarget(options);
	if (!target || prefersReducedMotion()) {
		options.onComplete();
		return;
	}

	const resumedRecently = wasRecentlyResumed();
	const cardRoot = target.closest<HTMLElement>(
		".detail-launch-card, .skerry-game-card",
	);

	if (resumedRecently) {
		options.onComplete();
		return;
	}

	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		options.onComplete();
		if (cardRoot) {
			cardRoot.classList.remove("is-detail-launching");
			gsap.set(cardRoot, { clearProps: "zIndex,isolation,willChange,transform" });
		}
		gsap.set(target, { clearProps: "zIndex,transform,willChange" });
	};

	if (cardRoot) {
		cardRoot.classList.add("is-detail-launching");
		gsap.set(cardRoot, {
			zIndex: 1400,
			isolation: "isolate",
		});
	}

	gsap.killTweensOf([cardRoot, target].filter(Boolean));
	gsap.to(target, {
		duration: 0.18,
		scale: 1.035,
		y: -5,
		ease: "power2.out",
		overwrite: "auto",
		onComplete: finish,
	});

	window.setTimeout(finish, 240);
}

export function animateDetailClose(options: DetailCloseOptions) {
	const root = document.querySelector<HTMLElement>(".detail-motion-page");
	if (!root || prefersReducedMotion()) {
		options.onComplete();
		return;
	}
	root.dataset.detailMotionClosing = "true";

	let finished = false;
	let fallbackTimer: number | undefined;
	const finish = () => {
		if (finished) return;
		finished = true;
		if (fallbackTimer !== undefined) {
			window.clearTimeout(fallbackTimer);
		}
		window.sessionStorage.setItem(SKIP_NEXT_ROUTE_MOTION_KEY, "1");
		options.onComplete();
	};

	const detailNodes = gsap.utils.toArray<HTMLElement>("*", root);
	gsap.killTweensOf([root, ...detailNodes]);

	gsap.to(root, {
		duration: 0.20,
		y: 8,
		autoAlpha: 0,
		scale: 0.992,
		ease: "power2.inOut",
		overwrite: "auto",
		onComplete: finish,
	});

	fallbackTimer = window.setTimeout(finish, 260);
}
