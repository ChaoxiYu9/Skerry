import {
	forwardRef,
	type MutableRefObject,
	memo,
	type ReactNode,
	useCallback,
	useMemo,
} from "react";
import {
	type GridListProps,
	type ListRange,
	VirtuosoGrid,
} from "react-virtuoso";

interface GridContext {
	gridRef: MutableRefObject<HTMLDivElement | null>;
}

// Keep this component type stable: defining it inside the grid would remount
// every card whenever a range or selection changes.
const GridList = forwardRef<
	HTMLDivElement,
	GridListProps & { context?: GridContext }
>(function GridList({ context, ...props }, forwardedRef) {
	const attach = useCallback(
		(element: HTMLDivElement | null) => {
			if (context) context.gridRef.current = element;
			if (typeof forwardedRef === "function") forwardedRef(element);
			else if (forwardedRef) forwardedRef.current = element;
		},
		[context, forwardedRef],
	);
	return <div {...props} ref={attach} />;
});
const GRID_COMPONENTS = { List: GridList };
const BUFFER_PX = { top: 640, bottom: 640 };
const RENDER_CHUNK_PX = { main: 240, reverse: 240 };
const gameKey = (_index: number, gameId: number) => gameId;

interface CardsViewportProps {
	gameIds: readonly number[];
	scrollContainer: HTMLElement;
	gridRef: MutableRefObject<HTMLDivElement | null>;
	renderCard: (index: number, gameId: number) => ReactNode;
	onRangeChanged?: (range: ListRange) => void;
	onReady?: (ready: boolean) => void;
}

/** Only the viewport and a bounded distance on both sides own card instances. */
export const CardsViewport = memo(function CardsViewport({
	gameIds,
	scrollContainer,
	gridRef,
	renderCard,
	onRangeChanged,
	onReady,
}: CardsViewportProps) {
	const context = useMemo(() => ({ gridRef }), [gridRef]);
	return (
		<VirtuosoGrid
			className="cards-viewport"
			customScrollParent={scrollContainer}
			data={gameIds}
			computeItemKey={gameKey}
			components={GRID_COMPONENTS}
			context={context}
			listClassName="sortable-cards-grid"
			itemClassName="cards-viewport-item"
			itemContent={renderCard}
			increaseViewportBy={BUFFER_PX}
			overscan={RENDER_CHUNK_PX}
			rangeChanged={onRangeChanged}
			readyStateChanged={onReady}
		/>
	);
});
