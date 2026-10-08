import gsap from "gsap";
import {
	forwardRef,
	type ImgHTMLAttributes,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

const prefersReducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export type RevealImageProps = ImgHTMLAttributes<HTMLImageElement> & {
	revealMotion?: boolean;
};

/** Reveals an already-loaded image without changing its layout box. */
export const RevealImage = forwardRef<HTMLImageElement, RevealImageProps>(
	(
		{ onLoad, onError, alt = "", src, loading, revealMotion = true, ...props },
		forwardedRef,
	) => {
		const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
		const imageRef = useRef<HTMLImageElement | null>(null);
		const revealedRef = useRef(false);
		const shouldAnimateReveal = revealMotion && loading !== "lazy";
		const resolvedSrc = fallbackSrc ?? src;

		useEffect(() => {
			setFallbackSrc(null);
		}, [src]);

		const setRef = useCallback(
			(node: HTMLImageElement | null) => {
				imageRef.current = node;
				if (typeof forwardedRef === "function") forwardedRef(node);
				else if (forwardedRef) forwardedRef.current = node;
			},
			[forwardedRef],
		);

		const reveal = useCallback(() => {
			const image = imageRef.current;
			if (!image || revealedRef.current || !resolvedSrc) return;
			revealedRef.current = true;
			gsap.killTweensOf(image);
			if (!shouldAnimateReveal || prefersReducedMotion()) {
				gsap.set(image, {
					autoAlpha: 1,
					clearProps: "transform,opacity,visibility",
				});
				return;
			}
			gsap.fromTo(
				image,
				{ autoAlpha: 0.01 },
				{
					autoAlpha: 1,
					duration: 0.34,
					ease: "power2.out",
					clearProps: "transform,opacity,visibility",
				},
			);
		}, [resolvedSrc, shouldAnimateReveal]);

		useLayoutEffect(() => {
			revealedRef.current = false;
			const image = imageRef.current;
			if (!image) return;
			gsap.killTweensOf(image);
			if (!resolvedSrc) {
				gsap.set(image, {
					autoAlpha: 1,
					clearProps: "transform,opacity,visibility",
				});
				return;
			}
			if (!shouldAnimateReveal) {
				gsap.set(image, {
					autoAlpha: 1,
					clearProps: "transform,opacity,visibility",
				});
				return () => gsap.killTweensOf(image);
			}
			if (image.complete && image.naturalWidth > 0) {
				revealedRef.current = true;
				gsap.set(image, {
					autoAlpha: 1,
					clearProps: "transform,opacity,visibility",
				});
				return;
			}
			gsap.set(image, { autoAlpha: 0.01 });
			return () => gsap.killTweensOf(image);
		}, [reveal, resolvedSrc, shouldAnimateReveal]);

		return (
			<img
				ref={setRef}
				src={resolvedSrc}
				alt={alt}
				loading={loading}
				onLoad={(event) => {
					onLoad?.(event);
					reveal();
				}}
				onError={(event) => {
					if (resolvedSrc && resolvedSrc !== "/images/default.png") {
						setFallbackSrc("/images/default.png");
					}
					gsap.set(event.currentTarget, {
						autoAlpha: 1,
						clearProps: "transform,opacity,visibility",
					});
					onError?.(event);
				}}
				{...props}
			/>
		);
	},
);

RevealImage.displayName = "RevealImage";
