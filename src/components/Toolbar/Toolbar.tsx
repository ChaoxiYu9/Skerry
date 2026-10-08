import Stack from "@mui/material/Stack";
import type { GameData } from "@/types";
import { CollectionToolbar } from "./Collection";
import {
	DeleteModal,
	MoreButton,
	OpenFolder,
	OpenReadmeText,
	OpenSaveDirectory,
} from "./MoreButton";

export { ThemeSwitcher, type ThemeMode } from "./ThemeSwitcher";
export {
	DeleteModal,
	MoreButton,
	type MoreButtonProps,
	OpenFolder,
	OpenReadmeText,
	OpenSaveDirectory,
	SourceLinkIcon,
	useModal,
} from "./MoreButton";

export interface ButtonGroupProps {
	isCollection: boolean;
}

export const DetailGameActions = ({
	selectedGame,
}: {
	selectedGame: GameData;
}) => (
	<Stack
		spacing={0.75}
		sx={{
			mt: 1.25,
			width: "100%",
			maxWidth: 224,
			"& .MuiButton-root": {
				justifyContent: "flex-start",
				minHeight: 34,
				px: 1.25,
				borderRadius: 1,
			},
		}}
	>
		<OpenFolder selectedGame={selectedGame} />
		<OpenReadmeText selectedGame={selectedGame} />
		<OpenSaveDirectory selectedGame={selectedGame} />
		<DeleteModal id={selectedGame.id} />
		<MoreButton selectedGame={selectedGame} />
	</Stack>
);

/**
 * 顶部按钮组组件，根据页面类型切换显示内容
 * @param {ButtonGroupProps} props
 * @returns {JSX.Element}
 */
export const Buttongroup = ({ isCollection }: ButtonGroupProps) => {
	return <>{isCollection && <CollectionToolbar />}</>;
};

/**
 * 主工具栏组件，根据路由自动切换按钮组
 * @returns {JSX.Element}
 */
export const Toolbars = () => {
	return null;
};