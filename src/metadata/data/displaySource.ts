import type { GameData, SourceType } from "@/types";
import type { SourceDisplayFields } from "../sourceCandidate";
import { getRuntimeSourceAdapter } from "../sourceRegistry";

export function assignBasicFields(
	target: GameData,
	fields: SourceDisplayFields,
): void {
	if (fields.name != null) target.name = fields.name;
	if (fields.name_cn != null) target.name_cn = fields.name_cn;
	if (fields.summary != null) target.summary = fields.summary;
	if (fields.developer != null) target.developer = fields.developer;
	if (fields.nsfw != null) target.nsfw = fields.nsfw;
}

export function getSourceDisplayFields(
	source: SourceType,
	data: unknown,
): SourceDisplayFields {
	return getRuntimeSourceAdapter(source).toDisplayFields(data);
}

export function applySingleSourceDisplay(
	target: GameData,
	source: SourceType,
	data: unknown,
): void {
	const fields = getSourceDisplayFields(source, data);
	assignBasicFields(target, fields);

	target.image = fields.image;
	target.tags = fields.tags ?? target.tags;
	target.screenshots = fields.screenshots;
	target.rank = fields.rank;
	target.score = fields.score;
	target.all_titles = fields.all_titles;
	target.aliases = fields.aliases ?? target.aliases;
	target.average_hours = fields.average_hours;
}
