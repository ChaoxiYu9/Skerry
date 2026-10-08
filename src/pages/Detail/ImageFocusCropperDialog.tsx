import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { BannerFocus } from "@/types";

interface ImageFocusCropperDialogProps {
	open: boolean;
	title: string;
	imageUrl: string;
	initialFocus?: BannerFocus | null;
	aspectRatio?: number;
	onCancel: () => void;
	onSave: (focus: BannerFocus, croppedBlob?: Blob | null) => void;
}

const clampFocus = (value: number) => Math.min(100, Math.max(0, value));

export function ImageFocusCropperDialog({
	open,
	title,
	imageUrl,
	initialFocus,
	aspectRatio = 16 / 9,
	onCancel,
	onSave,
}: ImageFocusCropperDialogProps) {
	const frameRef = useRef<HTMLDivElement>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const dragRef = useRef<{
		pointerId: number;
		startX: number;
		startY: number;
		focus: BannerFocus;
	} | null>(null);
	const [focus, setFocus] = useState<BannerFocus>({ x: 50, y: 50 });
	const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setFocus({
			x: clampFocus(initialFocus?.x ?? 50),
			y: clampFocus(initialFocus?.y ?? 50),
		});
		setNaturalSize(null);
	}, [initialFocus, open]);

	const updateFocus = (
		startFocus: BannerFocus,
		startX: number,
		startY: number,
		nextX: number,
		nextY: number,
	) => {
		const frame = frameRef.current;
		if (!frame) return;
		const rect = frame.getBoundingClientRect();
		const deltaX = nextX - startX;
		const deltaY = nextY - startY;

		if (!naturalSize) {
			setFocus({
				x: clampFocus(startFocus.x - (deltaX / rect.width) * 100),
				y: clampFocus(startFocus.y - (deltaY / rect.height) * 100),
			});
			return;
		}

		const coverScale = Math.max(rect.width / naturalSize.width, rect.height / naturalSize.height);
		const horizontalOverflow = rect.width - naturalSize.width * coverScale;
		const verticalOverflow = rect.height - naturalSize.height * coverScale;
		setFocus({
			x: horizontalOverflow < 0
				? clampFocus(startFocus.x + (deltaX / horizontalOverflow) * 100)
				: 50,
			y: verticalOverflow < 0
				? clampFocus(startFocus.y + (deltaY / verticalOverflow) * 100)
				: 50,
		});
	};

	const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			focus,
		};
	};

	const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		updateFocus(drag.focus, drag.startX, drag.startY, event.clientX, event.clientY);
	};

	const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	const handleSave = () => {
		setIsSaving(true);
		try {
			onSave(focus, null);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Dialog open={open} onClose={onCancel} maxWidth="md" fullWidth>
			<DialogTitle>{title}</DialogTitle>
			<DialogContent>
				<Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
					拖动图片，把想显示的区域放进截图框内。
				</Typography>
				<Box
					ref={frameRef}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					onPointerCancel={handlePointerUp}
					sx={{
						position: "relative",
						width: "100%",
						aspectRatio: `${Math.max(0.5, Math.min(4, aspectRatio))}`,
						maxHeight: "min(58vh, 460px)",
						overflow: "hidden",
						borderRadius: 2,
						bgcolor: "rgba(15,23,42,.28)",
						border: 1,
						borderColor: "divider",
						cursor: "grab",
						touchAction: "none",
						userSelect: "none",
					}}
				>
					<Box
						component="img"
						ref={imageRef}
						src={imageUrl}
						alt=""
						draggable={false}
						
						onLoad={(event) => {
							const image = event.currentTarget;
							if (image.naturalWidth && image.naturalHeight) {
								setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
							}
						}}
						sx={{
							position: "absolute",
							inset: 0,
							width: "100%",
							height: "100%",
							objectFit: "cover",
							objectPosition: `${focus.x}% ${focus.y}%`,
							pointerEvents: "none",
						}}
					/>
					<Box
						aria-hidden="true"
						sx={{
							position: "absolute",
							inset: 0,
							pointerEvents: "none",
							border: 2,
							borderColor: "rgba(255,255,255,.72)",
							backgroundImage:
								"linear-gradient(to right, transparent 0, transparent calc(33.333% - 1px), rgba(255,255,255,.36) 33.333%, transparent calc(33.333% + 1px)), linear-gradient(to right, transparent 0, transparent calc(66.666% - 1px), rgba(255,255,255,.36) 66.666%, transparent calc(66.666% + 1px)), linear-gradient(to bottom, transparent 0, transparent calc(33.333% - 1px), rgba(255,255,255,.36) 33.333%, transparent calc(33.333% + 1px)), linear-gradient(to bottom, transparent 0, transparent calc(66.666% - 1px), rgba(255,255,255,.36) 66.666%, transparent calc(66.666% + 1px))",
						}}
					/>
				</Box>
			</DialogContent>
			<DialogActions>
				<Button onClick={() => setFocus({ x: 50, y: 50 })}>重置居中</Button>
				<Button onClick={onCancel}>取消</Button>
				<Button variant="contained" disabled={isSaving} startIcon={isSaving ? <CircularProgress size={14} /> : null} onClick={() => void handleSave()}>
					{isSaving ? "保存中..." : "保存位置"}
				</Button>
			</DialogActions>
		</Dialog>
	);
}
