import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const browserModule = process.env.SKERRY_PLAYWRIGHT_MODULE;
const { chromium } = await import(
	browserModule ? pathToFileURL(browserModule).href : "playwright"
);
let server;
let browser;
let origin;

before(async () => {
	server = await createServer({
		configFile: false,
		root: resolve(import.meta.dirname, ".."),
		cacheDir: ".project-cache/vite-library-tests",
		optimizeDeps: { entries: ["tests/fixtures/libraryRendering.tsx"] },
		plugins: [
			react(),
			{
				name: "library-test-fixture",
				configureServer(viteServer) {
					viteServer.middlewares.use(
						"/__library-fixture",
						async (_request, response) => {
							response.setHeader("Content-Type", "text/html");
							response.end(
								await viteServer.transformIndexHtml(
									"/__library-fixture",
									'<html><body style="margin:0"><div id="root"></div><script type="module" src="/tests/fixtures/libraryRendering.tsx"></script></body></html>',
								),
							);
						},
					);
				},
			},
		],
		resolve: {
			alias: [
				{
					find: "@/providers/routePreloads",
					replacement: resolve(
						import.meta.dirname,
						"fixtures/libraryMotionPages.tsx",
					),
				},
				{
					find: "@/pages/Home",
					replacement: resolve(
						import.meta.dirname,
						"fixtures/libraryMotionPages.tsx",
					),
				},
				{
					find: "@/store/appStore",
					replacement: resolve(
						import.meta.dirname,
						"fixtures/librarySearchData.ts",
					),
				},
				{
					find: "@/hooks/features/games/useGameListFacade",
					replacement: resolve(
						import.meta.dirname,
						"fixtures/librarySearchData.ts",
					),
				},
				{ find: "@", replacement: resolve(import.meta.dirname, "../src") },
			],
		},
		server: {
			host: "127.0.0.1",
			port: 5189,
			strictPort: true,
			watch: {
				ignored: [
					"**/src-tauri/**",
					"**/.project-cache/**",
					"**/node_modules/**",
				],
			},
		},
	});
	await server.listen();
	origin = server.resolvedUrls.local[0];
	browser = await chromium.launch({
		headless: true,
		...(process.env.SKERRY_BROWSER_EXECUTABLE
			? { executablePath: process.env.SKERRY_BROWSER_EXECUTABLE }
			: {}),
	});
});

test("virtual grid bounds mounted cards for 100 to 10000 games and survives reverse scrolling", async () => {
	const page = await browser.newPage();
	const results = [];
	try {
		for (const viewport of [
			{ width: 1920, height: 1080 },
			{ width: 2560, height: 1440 },
			{ width: 900, height: 700 },
		]) {
			await page.setViewportSize(viewport);
			for (const count of [100, 1000, 5000, 10000]) {
				await page.goto(`${origin}__library-fixture?grid=1&count=${count}`);
				await page.waitForFunction(
					() => document.querySelectorAll(".skerry-game-card").length >= 8,
				);
				await page.waitForTimeout(150);
				const initial = await page.locator(".skerry-game-card").count();
				assert.ok(initial <= 180, `${count} games mounted ${initial} cards`);
				const scroll = page.getByTestId("scroll-container");
				await scroll.evaluate((element) => {
					element.scrollTop = element.scrollHeight - element.clientHeight;
				});
				await page.waitForFunction(
					(lastId) => document.querySelector(`[data-game-card-id="${lastId}"]`),
					count,
				);
				const atEnd = await page.locator(".skerry-game-card").count();
				assert.ok(atEnd <= 180);
				await scroll.evaluate((element) => {
					element.scrollTop = 0;
				});
				await page.waitForFunction(() =>
					document.querySelector('[data-game-card-id="1"]'),
				);
				assert.ok((await page.locator(".skerry-game-card").count()) <= 180);
				const image = page.locator('[data-game-card-id="1"] img');
				await image.evaluate((element) => element.decode());
				assert.equal(
					await image.evaluate((element) => element.naturalWidth),
					256,
				);
				results.push({
					viewport: `${viewport.width}x${viewport.height}`,
					count,
					initial,
					atEnd,
				});
			}
		}
		console.log("Mounted card counts:", JSON.stringify(results));
	} finally {
		await page.close();
	}
});

after(async () => {
	await browser?.close();
	await server?.close();
});

test("opening cards from different rows and returning keeps the library toolbar stationary", async () => {
	const page = await browser.newPage();
	try {
		for (const viewport of [
			{ width: 1920, height: 1080 },
			{ width: 2560, height: 1440 },
			{ width: 900, height: 700 },
		]) {
			await page.setViewportSize(viewport);
			await page.goto(`${origin}__library-fixture?motion=1`);
			const toolbar = page.getByTestId("library-toolbar");
			await toolbar.waitFor();
			await page.waitForTimeout(650);
			for (const scrollTop of [0, 1200, 2800]) {
				const scroll = page.getByTestId("motion-scroll");
				await scroll.evaluate((element, top) => {
					element.scrollTop = top;
				}, scrollTop);
				await page.waitForTimeout(150);
				await page.evaluate(() => {
					window.motionSamples = [];
					const toolbar = document.querySelector(
						'[data-testid="library-toolbar"]',
					);
					const initial = toolbar.getBoundingClientRect();
					window.sampleLibraryMotion = () => {
						const layer = document.querySelector(
							'[data-skerry-route-layer="libraries"]',
						);
						const base = toolbar.closest(".skerry-library-route-base");
						const rect = toolbar.getBoundingClientRect();
						window.motionSamples.push({
							mountedCards:
								document.querySelectorAll(".skerry-game-card").length,
							transform: layer.style.transform,
							opacity: layer.style.opacity,
							contentTransform:
								document.querySelector(".skerry-detail-page")?.style
									.transform ||
								document.querySelector('[data-testid="motion-scroll"]').style
									.transform,
							contentOpacity:
								document.querySelector(".skerry-detail-page")?.style.opacity ||
								document.querySelector('[data-testid="motion-scroll"]').style
									.opacity,
							toolbarShift: base.classList.contains("is-detail-active")
								? 0
								: Math.max(
										Math.abs(rect.x - initial.x),
										Math.abs(rect.y - initial.y),
										Math.abs(rect.width - initial.width),
									),
						});
						window.motionFrame = requestAnimationFrame(
							window.sampleLibraryMotion,
						);
					};
					window.motionFrame = requestAnimationFrame(
						window.sampleLibraryMotion,
					);
				});
				const visibleCard = page
					.locator(".skerry-game-card")
					.filter({ visible: true });
				// Virtual overscan can mount cards outside the scroll viewport.
				const cardId = await visibleCard.evaluateAll((cards) => {
					const scrollRect = document
						.querySelector('[data-testid="motion-scroll"]')
						.getBoundingClientRect();
					return cards.find((card) => {
						const rect = card.getBoundingClientRect();
						return (
							rect.top >= scrollRect.top && rect.bottom <= scrollRect.bottom
						);
					}).dataset.gameCardId;
				});
				await page.locator(`[data-game-card-id="${cardId}"]`).click();
				await page.getByTestId("detail-back").waitFor();
				await page.waitForTimeout(600);
				await page.getByTestId("detail-back").click();
				await toolbar.waitFor({ state: "visible" });
				await page.waitForTimeout(600);
				const samples = await page.evaluate(() => {
					cancelAnimationFrame(window.motionFrame);
					return window.motionSamples;
				});
				assert.equal(
					samples.some((sample) => sample.transform || sample.opacity),
					false,
					`row at scroll ${scrollTop}: shared library frame must not animate`,
				);
				assert.equal(
					samples.some((sample) => sample.contentTransform),
					true,
					"the new entrance has a visible spatial motion",
				);
				assert.ok(
					samples.some((sample) => sample.contentOpacity),
					"the moving content also softens its arrival",
				);
				assert.ok(
					samples.every((sample) => sample.toolbarShift < 0.5),
					`row at scroll ${scrollTop}: toolbar moved`,
				);
				assert.ok(
					samples.every((sample) => sample.mountedCards <= 180),
					"retaining the source must keep virtual card mounts bounded",
				);
				assert.ok(
					Math.abs(
						(await scroll.evaluate((element) => element.scrollTop)) - scrollTop,
					) < 1,
					"return preserves scroll position",
				);
			}
		}
	} finally {
		await page.close();
	}
});

test("rapid library detail navigation cleans up fades and respects reduced motion", async () => {
	for (const reducedMotion of ["no-preference", "reduce"]) {
		const page = await browser.newPage({ reducedMotion });
		try {
			await page.goto(`${origin}__library-fixture?motion=1`);
			const card = page.locator('[data-game-card-id="1"]');
			await card.waitFor();
			for (let turn = 0; turn < 5; turn++) {
				await card.click();
				if (reducedMotion === "reduce") {
					assert.equal(
						await page
							.locator(".skerry-detail-page")
							.evaluate((element) => element.style.opacity),
						"",
					);
				}
				await page.getByTestId("detail-back").click();
			}
			await page.getByTestId("library-toolbar").waitFor({ state: "visible" });
			await page.waitForTimeout(600);
			const styles = await page.evaluate(() =>
				[
					document.querySelector('[data-skerry-route-layer="libraries"]'),
					document.querySelector('[data-testid="motion-scroll"]'),
				].map((element) => ({
					transform: element.style.transform,
					opacity: element.style.opacity,
					visibility: element.style.visibility,
				})),
			);
			assert.ok(
				styles.every(
					(style) => !style.transform && !style.opacity && !style.visibility,
				),
				"completed/cancelled navigation must leave no animation styles",
			);
			assert.equal(await page.getByTestId("library-toolbar").isVisible(), true);
		} finally {
			await page.close();
		}
	}
});

test("library and wish-plan details share a visible entrance after data arrives without replaying on refresh", async () => {
	const observations = [];
	for (const scene of ["library", "wish"]) {
		const page = await browser.newPage();
		try {
			await page.goto(
				`${origin}__library-fixture?motion=1&delayed=1&initial=${scene === "wish" ? "/" : "/libraries"}`,
			);
			const source =
				scene === "wish"
					? page.getByTestId("wish-card").filter({ visible: true })
					: page.locator('[data-game-card-id="1"]');
			await source.click();
			await page.getByTestId("detail-loading").waitFor();
			await page.locator(".skerry-detail-page").waitFor();
			assert.equal(
				await page
					.locator(".skerry-detail-route-layer")
					.evaluate((element) => getComputedStyle(element).zIndex),
				"1",
				"detail paint layer stays above the retained source",
			);
			const sampling = page
				.locator(".skerry-detail-page")
				.evaluate(async (root) => {
					const samples = [];
					const start = performance.now();
					while (performance.now() - start < 700) {
						const poster = root.querySelector(".detail-poster");
						const body = root.querySelector(".detail-body");
						samples.push({
							time: performance.now() - start,
							transform: root.style.transform,
							opacity: root.style.opacity,
							poster: poster.style.transform,
							body: body.style.transform,
							backdrop: root.querySelector(".detail-hero-bg").style.transform,
						});
						await new Promise(requestAnimationFrame);
					}
					return samples;
				});
			if (process.env.SKERRY_MOTION_SCREENSHOT_DIR) {
				for (const frame of ["early", "middle", "settled"]) {
					await page.waitForTimeout(frame === "settled" ? 400 : 100);
					await page.screenshot({
						path: resolve(
							process.env.SKERRY_MOTION_SCREENSHOT_DIR,
							`${scene}-${frame}.png`,
						),
					});
				}
			}
			const samples = await sampling;
			assert.ok(
				samples.some(
					(sample) => sample.transform && Number(sample.opacity) < 0.9,
				),
				`${scene}: visible entrance must survive lazy/data loading; first frames: ${JSON.stringify(samples.slice(0, 8))}`,
			);
			assert.ok(
				samples.some((sample) => sample.time > 120 && sample.transform),
				"entrance must remain perceptible beyond click feedback timing",
			);
			assert.ok(
				samples.every(
					(sample) => !sample.poster && !sample.body && !sample.backdrop,
				),
				"detail content enters together without stacked child motions",
			);
			assert.equal(samples.at(-1).transform, "");
			await page.getByTestId("refresh-detail").click();
			assert.equal(
				await page
					.locator(".skerry-detail-page")
					.evaluate((root) => root.style.transform),
				"",
				"same-game data refresh must not replay navigation",
			);
			observations.push({
				scene,
				movingFrames: samples.filter((sample) => sample.transform).length,
			});
		} finally {
			await page.close();
		}
	}
	console.log("Shared detail entrances:", JSON.stringify(observations));
});

test("all primary pages enter, including a lazily resolved page, and interrupted detail exits cannot navigate later", async () => {
	const page = await browser.newPage();
	const routeOrder = [
		"home",
		"libraries",
		"collection",
		"report",
		"potato-import",
		"settings",
	];
	let previousRoute = "home";
	try {
		await page.goto(`${origin}__library-fixture?motion=1&initial=/`);
		await page.getByTestId("wish-card").filter({ visible: true }).waitFor();
		for (const route of [
			"settings",
			"libraries",
			"collection",
			"report",
			"potato-import",
			"home",
		]) {
			await page.getByTestId(`nav-${route}`).click();
			if (route === "settings") {
				const underlay = page.locator(".is-motion-underlay");
				await underlay.waitFor();
				const incoming = page.locator(
					'[data-skerry-route-layer="settings"]',
				);
				assert.equal(
					await incoming.evaluate((element) => element.style.backgroundColor),
					"",
					"a not-yet-rendered lazy page must not paint an opaque animation surface",
				);
				assert.equal(
					await underlay.evaluate(
						(element) => getComputedStyle(element).visibility,
					),
					"visible",
					"the current page remains painted while a lazy destination loads",
				);
				assert.match(await underlay.innerText(), /Home fixture/);
			}
			const target =
				route === "libraries"
					? page.getByTestId("motion-scroll")
					: page.locator("[data-skerry-route-layer].is-active");
			await target.waitFor();
			await page.waitForFunction(() => {
				const layer = document.querySelector(
					"[data-skerry-route-layer].is-active",
				);
				const target = layer?.querySelector(".cards-scroll-region") ?? layer;
				return target?.style.transform && target.style.opacity;
			});
			const dimensions = await target.evaluate((element) => {
				const matrix = new DOMMatrix(getComputedStyle(element).transform);
				return {
					scaleX: matrix.a,
					scaleY: matrix.d,
					x: matrix.m41,
					y: matrix.m42,
				};
			});
			assert.ok(
				Math.abs(dimensions.scaleX - 1) < 0.001 &&
					Math.abs(dimensions.scaleY - 1) < 0.001,
				"navigation must not scale virtual viewport geometry",
			);
			assert.ok(
				Math.abs(dimensions.y) < 0.01,
				"peer navigation must not move vertically",
			);
			assert.ok(
				(routeOrder.indexOf(route) >= routeOrder.indexOf(previousRoute)
					? dimensions.x > 0
					: dimensions.x < 0),
				"peer direction follows the navigation order",
			);
			assert.equal(
				await page.locator(".is-motion-underlay").count(),
				1,
				"the old view stays painted under the incoming page",
			);
			await page.waitForTimeout(600);
			assert.equal(
				await target.evaluate((element) => element.style.transform),
				"",
			);
			assert.equal(await page.locator(".is-motion-underlay").count(), 0);
			previousRoute = route;
		}
		await page.getByTestId("wish-card").filter({ visible: true }).click();
		await page.getByTestId("detail-back").click({ force: true });
		await page.getByTestId("nav-settings").click();
		await page.waitForTimeout(850);
		assert.equal(
			await page
				.locator('[data-skerry-route-layer="settings"]')
				.getAttribute("aria-hidden"),
			"false",
			"the last requested exit destination wins exactly once",
		);
		await page.getByTestId("nav-home").click();
		await page.getByTestId("wish-card").filter({ visible: true }).click();
		await page.getByTestId("detail-back").click({ force: true });
		await page.getByTestId("history-back").click();
		await page.getByTestId("nav-report").click();
		await page.waitForTimeout(850);
		assert.equal(
			await page
				.locator('[data-skerry-route-layer="report"]')
				.getAttribute("aria-hidden"),
			"false",
			"unmount cancels any pending exit callback",
		);
	} finally {
		await page.close();
	}
});

test("details retain the source geometry and return without replaying its entrance", async () => {
	for (const scene of ["library", "wish"]) {
		const page = await browser.newPage();
		try {
			await page.goto(
				`${origin}__library-fixture?motion=1&initial=${scene === "wish" ? "/" : "/libraries"}`,
			);
			const source =
				scene === "wish"
					? page.locator('[data-skerry-route-layer="home"]')
					: page.locator(".skerry-library-route-base");
			await source.waitFor();
			await page.waitForTimeout(650);
			const before = await source.boundingBox();
			await (scene === "wish"
				? page.getByTestId("wish-card").filter({ visible: true })
				: page.locator('[data-game-card-id="1"]')
			).click();
			await page.locator(".skerry-detail-page").waitFor();
			const pinned = await source.boundingBox();
			assert.ok(
				Math.abs(pinned.width - before.width) < 0.5 &&
					Math.abs(pinned.height - before.height) < 0.5,
				"the retained source must keep its viewport geometry",
			);
			assert.ok(
				Math.abs(pinned.x - before.x) < 0.5 &&
					Math.abs(pinned.y - before.y) < 0.5,
				`source stays in its original screen position across shell changes: ${JSON.stringify({ scene, before, pinned })}`,
			);
			assert.equal(
				await source.evaluate(
					(element) =>
						element.inert && element.classList.contains("is-motion-underlay"),
				),
				true,
			);
			const crop = await source.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				const stage = element
					.closest(".skerry-motion-root")
					.getBoundingClientRect();
				const values = getComputedStyle(element)
					.clipPath.match(/-?[\d.]+/g)
					.map(Number);
				return {
					left: values[3],
					requiredLeft: Math.max(0, stage.left - rect.left),
				};
			});
			assert.ok(
				crop.left >= crop.requiredLeft - 0.5,
				"old cards cannot paint into the detail page's outer padding",
			);
			await page.waitForTimeout(550);
			await page.evaluate(() => {
				window.returnEntries = [];
				const source = document.querySelector(".is-motion-underlay");
				const target = source.querySelector(".cards-scroll-region") ?? source;
				window.returnObserver = new MutationObserver(() =>
					window.returnEntries.push({
						transform: target.style.transform,
						opacity: target.style.opacity,
					}),
				);
				window.returnObserver.observe(target, {
					attributes: true,
					attributeFilter: ["style"],
				});
			});
			await page.getByTestId("detail-back").click();
			await page.waitForFunction(
				() => !document.querySelector(".skerry-detail-page"),
			);
			await page.waitForTimeout(550);
			const entries = await page.evaluate(() => {
				window.returnObserver.disconnect();
				return window.returnEntries;
			});
			assert.ok(
				entries.every((entry) => !entry.transform && !entry.opacity),
				"return reveals the source without moving or fading it again",
			);
			assert.equal(await source.evaluate((element) => element.inert), false);
			assert.equal(await page.locator(".is-motion-underlay").count(), 0);
		} finally {
			await page.close();
		}
	}
});

test("a search typo and Backspace preserve the focused input across empty results", async () => {
	const page = await browser.newPage();
	try {
		await page.goto(`${origin}__library-fixture`);
		const input = page.getByRole("textbox", { name: "Search fixture" });
		await input.fill("Alpha");
		await input.evaluate((element) => {
			window.originalSearchInput = element;
		});
		await page.keyboard.type("z");
		await page.waitForTimeout(100);
		assert.equal(
			await input.evaluate(
				(element) =>
					element === window.originalSearchInput &&
					document.activeElement === element,
			),
			true,
			"entering an empty result must keep the same focused DOM input",
		);
		await page.keyboard.press("Backspace");
		assert.equal(await input.inputValue(), "Alpha");
		assert.equal(
			await input.evaluate((element) => document.activeElement === element),
			true,
		);
	} finally {
		await page.close();
	}
});

test("real game search preserves focus after a typo and defers Chinese IME intermediate text", async () => {
	const page = await browser.newPage();
	try {
		await page.goto(`${origin}__library-fixture?search=1`);
		const input = page.getByRole("combobox");
		await input.fill("Alpha");
		await page.waitForFunction(
			() =>
				document.querySelector('[data-testid="keyword"]').textContent ===
				"Alpha",
		);
		await input.evaluate((element) => {
			window.originalSearchInput = element;
		});
		await page.keyboard.type("z");
		await page.waitForFunction(
			() =>
				document.querySelector('[data-testid="keyword"]').textContent ===
				"Alphaz",
		);
		assert.equal(
			await input.evaluate(
				(element) =>
					element === window.originalSearchInput &&
					document.activeElement === element,
			),
			true,
		);
		await page.keyboard.press("Backspace");
		await page.waitForFunction(
			() =>
				document.querySelector('[data-testid="keyword"]').textContent ===
				"Alpha",
		);
		await input.dispatchEvent("compositionstart", { data: "" });
		await input.fill("ni");
		await page.waitForTimeout(350);
		assert.equal(await page.getByTestId("keyword").textContent(), "Alpha");
		await input.fill("你");
		await input.dispatchEvent("compositionend", { data: "你" });
		await page.waitForFunction(
			() =>
				document.querySelector('[data-testid="keyword"]').textContent === "你",
		);
		await page.keyboard.press("Backspace");
		assert.equal(await input.inputValue(), "");
		assert.equal(
			await input.evaluate((element) => document.activeElement === element),
			true,
		);
	} finally {
		await page.close();
	}
});
