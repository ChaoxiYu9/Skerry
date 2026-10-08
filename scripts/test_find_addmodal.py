# -*- coding: utf-8 -*-
import os

filepath = r"E:\galgame\Codex_xm\Wangy\Skerry\Skerry\src\components\AddModal\AddModal.tsx"
with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Let's inspect the exact lines of Dialog rendering in AddModal.tsx
target_start = '''			<Dialog
				open={addModalOpen}
				onClose={(_, reason) => {
					// 加载时防止关闭弹窗
					if (reason !== "backdropClick" && !isBusy) {
						handleCloseModal();
					}
				}}'''

print("Target exists in content:", target_start in content)
