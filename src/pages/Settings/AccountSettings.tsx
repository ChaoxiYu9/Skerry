import Stack from "@mui/material/Stack";
import {
	BgmProviderSection,
	BgmTokenSettings,
} from "./account/BgmProviderSection";
import {
	HikarinagiAuthSettings,
	HikarinagiProviderSection,
} from "./account/HikarinagiProviderSection";
import {
	KungalProviderSection,
	KungalTokenSettings,
} from "./account/KungalProviderSection";
import {
	VndbProviderSection,
	VndbTokenSettings,
} from "./account/VndbProviderSection";

export {
	BgmProviderSection,
	BgmTokenSettings,
	HikarinagiAuthSettings,
	HikarinagiProviderSection,
	KungalProviderSection,
	KungalTokenSettings,
	VndbProviderSection,
	VndbTokenSettings,
};

export const CollectionSyncSettings = () => null;

export const AccountSettings = () => (
	<Stack spacing={2.5}>
		<KungalProviderSection />
		<BgmProviderSection />
		<HikarinagiProviderSection />
		<VndbProviderSection />
	</Stack>
);

export const AccountAndSyncSettings = AccountSettings;

export default AccountSettings;
