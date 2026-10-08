export function reconcileGameOrder(
	savedOrder: readonly number[],
	allGameIds: readonly number[],
): number[] {
	const allGameIdSet = new Set(allGameIds);
	const reconciled = savedOrder.filter((gameId) => allGameIdSet.has(gameId));
	const reconciledSet = new Set(reconciled);

	for (const gameId of allGameIds) {
		if (!reconciledSet.has(gameId)) reconciled.push(gameId);
	}

	return reconciled;
}

export function mergeVisibleGameOrder(
	fullOrder: readonly number[],
	nextVisibleGameIds: readonly number[],
): number[] {
	const visibleGameIdSet = new Set(nextVisibleGameIds);
	let visibleIndex = 0;

	return fullOrder.map((gameId) =>
		visibleGameIdSet.has(gameId) ? nextVisibleGameIds[visibleIndex++] : gameId,
	);
}
