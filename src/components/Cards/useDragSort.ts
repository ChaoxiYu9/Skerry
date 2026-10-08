import {
	type DragEndEvent,
	type DragStartEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useCallback, useEffect, useRef, useState } from "react";

function areSameIds(a: readonly number[], b: readonly number[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index += 1) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

/**
 * 拖拽排序 Hook - 管理拖拽相关状态和逻辑
 *
 * 操作纯 ID 数组，不再依赖完整 GameData 对象。
 */
export function useDragSort(options: {
	gameIds: number[];
	onReorder?: (gameIds: number[]) => Promise<void> | void;
	enabled: boolean;
}) {
	const { gameIds, onReorder, enabled } = options;

	const [sortableIds, setSortableIds] = useState(() => gameIds);
	const [activeId, setActiveId] = useState<number | null>(null);
	const isDraggingRef = useRef(false);
	const syncedIdsRef = useRef(gameIds);

	const ids = enabled ? sortableIds : gameIds;

	// 排序模式保留本地顺序，非排序模式直接使用外部数据，避免删除后慢一帧
	useEffect(() => {
		if (!enabled || isDraggingRef.current) return;
		if (areSameIds(syncedIdsRef.current, gameIds)) return;

		syncedIdsRef.current = gameIds;
		setSortableIds((current) => (areSameIds(current, gameIds) ? current : gameIds));
	}, [enabled, gameIds]);

	// 传感器配置
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 10 },
		}),
	);

	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			if (!enabled) return;
			isDraggingRef.current = true;
			setActiveId(event.active.id as number);
		},
		[enabled],
	);

	const handleDragCancel = useCallback(() => {
		isDraggingRef.current = false;
		setActiveId(null);
	}, []);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			setActiveId(null);

			if (!over || active.id === over.id) {
				isDraggingRef.current = false;
				return;
			}

			const oldIndex = ids.indexOf(active.id as number);
			const newIndex = ids.indexOf(over.id as number);

			if (oldIndex !== -1 && newIndex !== -1) {
				const newIds = arrayMove(ids, oldIndex, newIndex);
				syncedIdsRef.current = newIds;
				setSortableIds(newIds);
				isDraggingRef.current = false;

				void Promise.resolve(onReorder?.(newIds)).catch((error) => {
					console.error("排序更新失败:", error);
					syncedIdsRef.current = ids;
					setSortableIds(ids); // 回滚
				});
			}

			isDraggingRef.current = false;
		},
		[ids, onReorder],
	);

	return {
		ids,
		activeId,
		sensors,
		handleDragStart,
		handleDragCancel,
		handleDragEnd,
	};
}
