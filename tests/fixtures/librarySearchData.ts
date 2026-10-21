import { create } from "zustand";

interface SearchState {
	searchInput: string;
	searchKeyword: string;
	setSearchInput: (value: string) => void;
	setSearchKeyword: (value: string) => void;
}

export const useStore = create<SearchState>((set) => ({
	searchInput: "",
	searchKeyword: "",
	setSearchInput: (searchInput) => set({ searchInput }),
	setSearchKeyword: (searchKeyword) => set({ searchKeyword }),
}));

const games = [
	{
		id: 1,
		name: "Alpha",
		name_cn: "测试游戏",
		custom_data: null,
		all_titles: [],
		aliases: [],
	},
];
export function useFilteredGamesFacade() {
	return { filteredGames: games };
}
