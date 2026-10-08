import gsap from "gsap";
import { useLayoutEffect, useRef } from "react";
import { traceMotion } from "./motionTrace";

const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface FlipMotionOptions {
	selector?: string;
	keyAttribute?: string;
	duration?: number;
	disabled?: boolean;
	maxElements?: number;
	visibleOnly?: boolean;
	viewportMargin?: number;
	maxAnimatedElements?: number;
}

function isNearViewport(element: HTMLElement, margin: number): boolean {
	const rect = element.getBoundingClientRect();
	return (
		rect.width > 1 &&
		rect.height > 1 &&
		rect.bottom >= -margin &&
		rect.top <= window.innerHeight + margin &&
		rect.right >= -margin &&
		rect.left <= window.innerWidth + margin
	);
}

/**
 * Keeps keyed content spatially continuous when a list is filtered, sorted or
 * updated. The previous layout is retained between commits, then GSAP only
 * animates the delta on elements that survived the update.
 */
export function useFlipMotion<T extends HTMLElement = HTMLDivElement>(
	signature: string,
	options: FlipMotionOptions = {},
) {
	const rootRef = useRef<T | null>(null);
	const previousRectsRef = useRef<Map<string, DOMRect>>(new Map());
	const previousSignatureRef = useRef<string | null>(null);
	const hasSnapshotRef = useRef(false);
	const selector = options.selector ?? "[data-flip-key]";
	const keyAttribute = options.keyAttribute ?? "data-flip-key";
	const duration = options.duration ?? 0.34;
	const disabled = options.disabled ?? false;
	const maxElements = options.maxElements ?? 180;
	const visibleOnly = options.visibleOnly ?? false;
	const viewportMargin = options.viewportMargin ?? 260;
	const maxAnimatedElements = options.maxAnimatedElements ?? maxElements;

	// The signature intentionally drives a post-commit measurement whenever the
	// keyed list changes; the ref stores the previous commit's layout.
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root || disabled || prefersReducedMotion()) {
			hasSnapshotRef.current = false;
			previousSignatureRef.current = signature;
			return;
		}

		const previousRects = previousRectsRef.current;
		const isInitialCommit = previousSignatureRef.current === null;
		previousSignatureRef.current = signature;
		const measureStart = performance.now();
		const allElements = Array.from(root.querySelectorAll<HTMLElement>(selector));
		const elements = visibleOnly
			? allElements
					.filter((element) => isNearViewport(element, viewportMargin))
					.slice(0, maxElements)
			: allElements;
		if (!visibleOnly && elements.length > maxElements) {
			hasSnapshotRef.current = false;
			previousRectsRef.current = new Map();
			return;
		}
		const nextRects = new Map(
			elements.flatMap((element) => {
				const key = element.getAttribute(keyAttribute);
				return key ? [[key, element.getBoundingClientRect()] as const] : [];
			}),
		);
		const measureDuration = performance.now() - measureStart;
		if (measureDuration > 8 || allElements.length > 60) {
			traceMotion("flip-measure", {
				signatureLength: signature.length,
				allElements: allElements.length,
				measuredElements: elements.length,
				duration: Math.round(measureDuration * 10) / 10,
				rootClass: root.className,
			});
		}

		if (isInitialCommit || !hasSnapshotRef.current) {
			previousRectsRef.current = nextRects;
			hasSnapshotRef.current = true;
			return;
		}

		const movedElements = elements.flatMap((element) => {
			const key = element.getAttribute(keyAttribute);
			const previous = key ? previousRects.get(key) : undefined;
			const next = key ? nextRects.get(key) : undefined;
			if (!previous || !next) return [];

			const deltaX = previous.left - next.left;
			const deltaY = previous.top - next.top;
			if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return [];
			return [{ element, deltaX, deltaY }];
		});

		const animatedElements = movedElements.slice(0, maxAnimatedElements);
		if (movedElements.length) {
			traceMotion("flip-animate", {
				movedElements: movedElements.length,
				animatedElements: animatedElements.length,
				rootClass: root.className,
			});
		}
		const movedTargets = animatedElements.map(({ element }) => element);
		animatedElements.forEach(({ element, deltaX, deltaY }, index) => {
			gsap.killTweensOf(element);
			gsap.fromTo(
				element,
				{
					x: deltaX,
					y: deltaY,
					willChange: "transform",
				},
				{
					x: 0,
					y: 0,
					duration,
					delay: Math.min(index * 0.012, 0.12),
					ease: "power3.out",
					clearProps: "transform,willChange",
				},
			);
		});

		previousRectsRef.current = nextRects;

		return () => {
			if (!movedTargets.length) return;
			gsap.killTweensOf(movedTargets);
			gsap.set(movedTargets, { clearProps: "transform,willChange" });
		};
	}, [
		disabled,
		duration,
		keyAttribute,
		maxAnimatedElements,
		maxElements,
		selector,
		signature,
		viewportMargin,
		visibleOnly,
	]);

	return rootRef;
}
