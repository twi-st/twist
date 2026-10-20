import { Shell } from '../components/Shell';
import { SettingsPage } from '../components/SettingsModal';

/** `/settings` — a full page, so the window chrome stays available. */
export const SettingsRoute = ({ tab }: { tab?: 'playback' | 'appearance' | 'desktop' | 'account' }) => (
  <Shell>
    <SettingsPage initialTab={tab} />
  </Shell>
);
