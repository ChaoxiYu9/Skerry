import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en_US from "@/locales/en-US.json";
import ja_JP from "@/locales/ja-JP.json";
import zh_CN from "@/locales/zh-CN.json";
import zh_TW from "@/locales/zh-TW.json";

const resources = {
	"zh-CN": {
		translation: zh_CN,
	},
	"zh-TW": {
		translation: zh_TW,
	},
	"en-US": {
		translation: en_US,
	},
	"ja-JP": {
		translation: ja_JP,
	},
};

i18n
	// 将i18n实例传递给react-i18next
	.use(initReactI18next)
	// 初始化i18next
	.init({
		resources,
		lng: "zh-CN",
		fallbackLng: "zh-CN", // 默认语言
		interpolation: {
			escapeValue: false, // 不转义特殊字符
		},
	});

export default i18n;
