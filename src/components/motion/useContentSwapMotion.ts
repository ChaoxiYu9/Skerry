import gsap from "gsap";
import { useLayoutEffect, useRef } from "react";

const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Gives an existing content region a quiet cross-state handoff. */
export function useContentSwapMotion<T extends HTMLElement = HTMLDivElement>(
	key: string | number | null | undefined,
) {
	const ref = useRef<T | null>(null);
	const hasRenderedRef = useRef(false);

	useLayoutEffect(() => {
		const element = ref.current;
		if (!element || key === null || key === undefined) return;

		if (!hasRenderedRef.current || prefersReducedMotion()) {
			hasRenderedRef.current = true;
			return;
		}

		gsap.killTweensOf(element);
		const tween = gsap.fromTo(
			element,
			{ autoAlpha: 0.72, y: 4, willChange: "transform,opacity" },
			{
				autoAlpha: 1,
				y: 0,
				duration: 0.28,
				ease: "power3.out",
				clearProps: "transform,opacity,visibility,willChange",
			},
		);
		hasRenderedRef.current = true;

		return () => {
			tween.kill();
			gsap.set(element, {
				clearProps: "transform,opacity,visibility,willChange",
			});
		};
	}, [key]);

	return ref;
}
