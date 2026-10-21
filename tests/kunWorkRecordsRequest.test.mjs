import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const context = vm.createContext({
	DOMException,
	URLSearchParams,
	window: {},
});
const sourceUrl = new URL("../src/metadata/api/kun.ts", import.meta.url);
const source = stripTypeScriptTypes(
	readFileSync(fileURLToPath(sourceUrl), "utf8"),
	{ mode: "strip", sourceUrl: sourceUrl.href },
);
const module = new vm.SourceTextModule(source, {
	context,
	identifier: sourceUrl.href,
});
const httpClient = {
	get: (...args) => httpFallback(...args),
};
let httpFallback = async () => {
	throw new Error("Unexpected Tauri HTTP fallback");
};

function stubModule(identifier, exports) {
	return new vm.SyntheticModule(
		Object.keys(exports),
		function () {
			for (const [name, value] of Object.entries(exports)) {
				this.setExport(name, value);
			}
		},
		{ context, identifier },
	);
}

await module.link((specifier) => {
	if (specifier === "i18next")
		return stubModule("i18next", { default: { language: "en" } });
	if (specifier === "@/utils/async")
		return stubModule("async", {
			isAbortError: (error) =>
				error instanceof DOMException && error.name === "AbortError",
		});
	if (specifier === "@/utils/errors")
		return stubModule("errors", { AppError: class AppError extends Error {} });
	if (specifier === "../constants")
		return stubModule("constants", { USER_AGENT: "Skerry test" });
	if (specifier === "../sourceCandidate") {
		return stubModule("source-candidate", {
			createGameCandidate: () => ({}),
			createSourceCandidateRecord: () => ({}),
			getCandidateSourceId: () => undefined,
			mergeCandidateSources: () => [],
		});
	}
	if (specifier === "./http")
		return stubModule("http", { default: httpClient });
	if (specifier === "./vndb")
		return stubModule("vndb", { fetchVndbById: async () => undefined });
	throw new Error(`Unexpected KunGal API import: ${specifier}`);
});
await module.evaluate();

const { fetchKunUserWorkRecordsPage } = module.namespace;

test("NextMoe work-record requests keep full records and only send documented paging values", async () => {
	let requestedUrl;
	let requestedInit;
	context.window.fetch = async (url, init) => {
		requestedUrl = url;
		requestedInit = init;
		return { ok: true, json: async () => ({ items: [] }) };
	};

	await fetchKunUserWorkRecordsPage("user-token", {
		cursor: "next/page?opaque=1",
		limit: 100,
	});

	const request = new URL(requestedUrl);
	assert.equal(request.pathname, "/v2/me/work-records");
	assert.deepEqual([...request.searchParams.entries()].sort(), [
		["cursor", "next/page?opaque=1"],
		["limit", "100"],
	]);
	assert.equal(requestedInit.headers.Authorization, "Bearer user-token");
});

test("Tauri HTTP fallback receives the same full-record pagination contract", async () => {
	let requestedUrl;
	let fallbackOptions;
	context.window.fetch = async (url) => {
		requestedUrl = url;
		throw new Error("WebView fetch unavailable");
	};
	httpFallback = async (url, options) => {
		fallbackOptions = { url, ...options };
		return { data: { items: [] } };
	};

	await fetchKunUserWorkRecordsPage("user-token", {
		cursor: "opaque-next-cursor",
		limit: 100,
	});

	assert.equal(new URL(requestedUrl).pathname, "/v2/me/work-records");
	assert.equal(
		fallbackOptions.url,
		"https://api.nextmoe.dev/v2/me/work-records",
	);
	assert.deepEqual(Object.keys(fallbackOptions.params).sort(), [
		"cursor",
		"limit",
	]);
	assert.equal(fallbackOptions.params.limit, "100");
	assert.equal(fallbackOptions.params.cursor, "opaque-next-cursor");
	assert.equal(fallbackOptions.headers.Authorization, "Bearer user-token");
});

test("cancellation during the Tauri HTTP fallback remains an AbortError", async () => {
	const cancellation = new DOMException("Aborted", "AbortError");
	context.window.fetch = async () => {
		throw new Error("WebView fetch unavailable");
	};
	httpFallback = async () => {
		throw cancellation;
	};

	await assert.rejects(
		fetchKunUserWorkRecordsPage("user-token", { limit: 100 }),
		(error) => error === cancellation,
	);
});
