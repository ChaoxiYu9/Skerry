import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const projectRoot = process.cwd();
const sourceRoot = path.join(projectRoot, "src");
const localePath = path.join(projectRoot, "src/locales/zh-CN.json");
const shouldWriteMissing = process.argv.includes("--write-missing");

const sourceExtensions = new Set([".ts", ".tsx"]);

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listSourceFiles(dirPath, files = []) {
	for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			listSourceFiles(fullPath, files);
			continue;
		}
		if (sourceExtensions.has(path.extname(entry.name))) {
			files.push(fullPath);
		}
	}
	return files;
}

function getLocaleValue(locale, keyPath) {
	const keys = keyPath.split(".");
	let current = locale;

	for (const key of keys) {
		if (!current || typeof current !== "object" || !(key in current)) {
			return undefined;
		}
		current = current[key];
	}

	return typeof current === "string" ? current : undefined;
}

function resolveLocaleValue(locale, keyPath, hasCountOption) {
	const exactValue = getLocaleValue(locale, keyPath);
	if (exactValue !== undefined) return exactValue;

	if (hasCountOption) {
		return getLocaleValue(locale, `${keyPath}_other`);
	}

	return undefined;
}

function getStaticText(node) {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return node.text;
	}
	return undefined;
}

function getPropertyNameText(name) {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
	return undefined;
}

function getDefaultValueProperty(objectLiteral) {
	for (const property of objectLiteral.properties) {
		if (!ts.isPropertyAssignment(property)) continue;
		if (getPropertyNameText(property.name) === "defaultValue") {
			return property.initializer;
		}
	}
	return undefined;
}

function hasCountProperty(node) {
	if (!ts.isObjectLiteralExpression(node)) return false;
	return node.properties.some(
		(property) =>
			ts.isPropertyAssignment(property) &&
			getPropertyNameText(property.name) === "count",
	);
}

function isTranslationCall(node) {
	if (!ts.isCallExpression(node)) return false;

	if (ts.isIdentifier(node.expression)) {
		return node.expression.text === "t";
	}

	if (ts.isPropertyAccessExpression(node.expression)) {
		return node.expression.name.text === "t";
	}

	return false;
}

function formatLocation(sourceFile, position) {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
	return `${path.relative(projectRoot, sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

function inspectFile(filePath, locale) {
	const sourceText = fs.readFileSync(filePath, "utf8");
	const sourceFile = ts.createSourceFile(
		filePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const issues = [];
	const replacements = [];

	function visit(node) {
		if (!isTranslationCall(node)) {
			ts.forEachChild(node, visit);
			return;
		}

		const [keyArg, secondArg, thirdArg] = node.arguments;
		const key = keyArg ? getStaticText(keyArg) : undefined;
		if (!key) {
			ts.forEachChild(node, visit);
			return;
		}

		const hasCountOption =
			(secondArg && hasCountProperty(secondArg)) ||
			(thirdArg && hasCountProperty(thirdArg));
		const localeValue = resolveLocaleValue(locale, key, hasCountOption);
		const location = formatLocation(sourceFile, node.getStart(sourceFile));

		if (localeValue === undefined) {
			issues.push({
				type: "missing-locale",
				location,
				key,
				message: "locale 中找不到对应 key，跳过默认值检查",
			});
			ts.forEachChild(node, visit);
			return;
		}

		if (!secondArg) {
			issues.push({
				type: "missing-default",
				location,
				key,
				expected: localeValue,
			});
			replacements.push({
				filePath,
				position: keyArg.end,
				text: `, ${JSON.stringify(localeValue)}`,
			});
			ts.forEachChild(node, visit);
			return;
		}

		const secondText = getStaticText(secondArg);
		if (secondText !== undefined) {
			if (secondText !== localeValue) {
				issues.push({
					type: "mismatch",
					location,
					key,
					actual: secondText,
					expected: localeValue,
				});
			}
			ts.forEachChild(node, visit);
			return;
		}

		if (ts.isObjectLiteralExpression(secondArg)) {
			const defaultValueNode = getDefaultValueProperty(secondArg);
			if (!defaultValueNode) {
				issues.push({
					type: "missing-default",
					location,
					key,
					expected: localeValue,
				});
				replacements.push({
					filePath,
					position: keyArg.end,
					text: `, ${JSON.stringify(localeValue)}`,
				});
				ts.forEachChild(node, visit);
				return;
			}

			const defaultValueText = getStaticText(defaultValueNode);
			if (defaultValueText === undefined) {
				issues.push({
					type: "dynamic-default",
					location,
					key,
					expected: localeValue,
					message: defaultValueNode.getText(sourceFile),
				});
				ts.forEachChild(node, visit);
				return;
			}

			if (defaultValueText !== localeValue) {
				issues.push({
					type: "mismatch",
					location,
					key,
					actual: defaultValueText,
					expected: localeValue,
				});
			}
			ts.forEachChild(node, visit);
			return;
		}

		issues.push({
			type: "dynamic-default",
			location,
			key,
			expected: localeValue,
			message: secondArg.getText(sourceFile),
		});

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return { issues, replacements };
}

function applyReplacements(replacements) {
	const byFile = new Map();
	for (const replacement of replacements) {
		const list = byFile.get(replacement.filePath) ?? [];
		list.push(replacement);
		byFile.set(replacement.filePath, list);
	}

	for (const [filePath, fileReplacements] of byFile) {
		let text = fs.readFileSync(filePath, "utf8");
		fileReplacements.sort((a, b) => b.position - a.position);
		for (const replacement of fileReplacements) {
			text =
				text.slice(0, replacement.position) +
				replacement.text +
				text.slice(replacement.position);
		}
		fs.writeFileSync(filePath, text);
	}
}

function printIssues(issues) {
	const grouped = new Map();
	for (const issue of issues) {
		const list = grouped.get(issue.type) ?? [];
		list.push(issue);
		grouped.set(issue.type, list);
	}
	for (const [type, list] of grouped) {
		console.log(`\n${type}: ${list.length}`);
		for (const issue of list) {
			console.log(`  ${issue.location} ${issue.key}`);
			if (issue.expected !== undefined) {
				console.log(`    locale: ${JSON.stringify(issue.expected)}`);
			}
			if (issue.actual !== undefined) {
				console.log(`    code:   ${JSON.stringify(issue.actual)}`);
			}
			if (issue.message) {
				console.log(`    note:   ${issue.message}`);
			}
		}
	}
}

const locale = readJson(localePath);
const results = listSourceFiles(sourceRoot).map((filePath) =>
	inspectFile(filePath, locale),
);
const issues = results.flatMap((result) => result.issues);
const replacements = results.flatMap((result) => result.replacements);

if (shouldWriteMissing && replacements.length > 0) {
	applyReplacements(replacements);
}

console.log("i18n 默认文案检查");
console.log(`扫描文件: ${results.length}`);
console.log(`问题数量: ${issues.length}`);
if (shouldWriteMissing) {
	console.log(`已补全缺失默认值: ${replacements.length}`);
} else {
	console.log(`可自动补全缺失默认值: ${replacements.length}`);
}

if (issues.length > 0) {
	printIssues(issues);
}

const unresolvedIssues = shouldWriteMissing
	? issues.filter((issue) => issue.type !== "missing-default")
	: issues;

process.exitCode = unresolvedIssues.length > 0 ? 1 : 0;
