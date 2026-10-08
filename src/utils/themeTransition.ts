import { flushSync } from "react-dom";

type ViewTransitionDocument = Document & {
	startViewTransition?: (updateCallback: () => void | Promise<void>) => {
		finished?: Promise<void>;
		ready?: Promise<void>;
		updateCallbackDone?: Promise<void>;
	};
};

const THEME_VIEW_TRANSITION_CLASS = "skerry-theme-view-transition";
const TO_DARK_CLASS = "skerry-theme-transition-to-dark";
const TO_LIGHT_CLASS = "skerry-theme-transition-to-light";

let activeThemeAnimation: Animation | null = null;

function cancelExistingThemeAnimations(element: HTMLElement): void {
	if (activeThemeAnimation) {
		try {
			activeThemeAnimation.cancel();
		} catch {}
		activeThemeAnimation = null;
	}
	try {
		// 取消之前挂在 documentElement 及其伪元素上的全部残余动画，防止 fill: "forwards" 污染下一次切换
		element.getAnimations({ subtree: true }).forEach((anim) => {
			anim.cancel();
		});
	} catch {}
}

export function changeThemeWithTransition(
	applyChange: () => void,
	eventOrOrigin?: React.MouseEvent | MouseEvent | { x: number; y: number },
	targetMode?: "light" | "dark",
): void {
	if (
		typeof window === "undefined" ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		applyChange();
		return;
	}

	const documentWithTransition = document as ViewTransitionDocument;
	if (!documentWithTransition.startViewTransition) {
		applyChange();
		return;
	}

	const root = document.documentElement;

	// 核心修复：每次开始新的过渡前，强力清理上次残留的动画状态，彻底防止第二次切换时伪元素继承上一轮的 forwards 状态导致整屏提前变色
	cancelExistingThemeAnimations(root);

	const currentMode =
		root.getAttribute("data-toolpad-color-scheme") ||
		root.getAttribute("data-mui-color-scheme") ||
		"dark";
	const isToLight = targetMode
		? targetMode === "light"
		: currentMode === "dark";

	let originX = window.innerWidth / 2;
	let originY = window.innerHeight / 2;

	if (eventOrOrigin) {
		if ("clientX" in eventOrOrigin && typeof eventOrOrigin.clientX === "number") {
			originX = eventOrOrigin.clientX;
			originY = eventOrOrigin.clientY;
		} else if ("x" in eventOrOrigin && typeof eventOrOrigin.x === "number") {
			originX = eventOrOrigin.x;
			originY = eventOrOrigin.y;
		}
	}

	const maxRadius = Math.hypot(
		Math.max(originX, window.innerWidth - originX),
		Math.max(originY, window.innerHeight - originY),
	);

	// 在 startViewTransition 前提前注入 CSS 变量，确保伪元素创建第 1 帧时就是 0 尺寸
	root.style.setProperty("--skerry-theme-x", `${originX}px`);
	root.style.setProperty("--skerry-theme-y", `${originY}px`);
	root.style.setProperty("--skerry-theme-r", `${maxRadius}px`);

	root.classList.add(THEME_VIEW_TRANSITION_CLASS);
	root.classList.add(isToLight ? TO_LIGHT_CLASS : TO_DARK_CLASS);

	const cleanup = () => {
		cancelExistingThemeAnimations(root);
		root.classList.remove(THEME_VIEW_TRANSITION_CLASS);
		root.classList.remove(TO_DARK_CLASS);
		root.classList.remove(TO_LIGHT_CLASS);
		root.style.removeProperty("--skerry-theme-x");
		root.style.removeProperty("--skerry-theme-y");
		root.style.removeProperty("--skerry-theme-r");
	};

	try {
		const viewTransition = documentWithTransition.startViewTransition(() => {
			flushSync(applyChange);
		});

		if (viewTransition && typeof viewTransition.ready?.then === "function") {
			void viewTransition.ready.then(() => {
				if (isToLight) {
					// 深色变浅色：从全屏向按钮收缩 (从大变小，收缩到点击按钮处归零消失，露出底层的浅色模式)
					activeThemeAnimation = document.documentElement.animate(
						[
							{
								clipPath: `circle(${maxRadius}px at ${originX}px ${originY}px)`,
								opacity: 1,
							},
							{
								clipPath: `circle(0px at ${originX}px ${originY}px)`,
								opacity: 1,
								offset: 0.98,
							},
							{
								clipPath: `circle(0px at ${originX}px ${originY}px)`,
								opacity: 0,
								offset: 1,
							},
						],
						{
							duration: 440,
							easing: "cubic-bezier(0.2, 0, 0, 1)",
							fill: "forwards",
							pseudoElement: "::view-transition-old(root)",
						},
					);
				} else {
					// 浅色变深色：从按钮处向外圆形扩散充满全屏 (从小变大)
					activeThemeAnimation = document.documentElement.animate(
						[
							{
								clipPath: `circle(0px at ${originX}px ${originY}px)`,
							},
							{
								clipPath: `circle(${maxRadius}px at ${originX}px ${originY}px)`,
							},
						],
						{
							duration: 440,
							easing: "cubic-bezier(0.2, 0, 0, 1)",
							fill: "forwards",
							pseudoElement: "::view-transition-new(root)",
						},
					);
				}
			});
		}

		const fallbackTimer = setTimeout(cleanup, 700);

		if (viewTransition && typeof viewTransition.finished?.finally === "function") {
			void viewTransition.finished.finally(() => {
				clearTimeout(fallbackTimer);
				cleanup();
			});
		} else {
			cleanup();
		}
	} catch (error) {
		console.warn("View transition failed, falling back to direct update:", error);
		cleanup();
		applyChange();
	}
}
