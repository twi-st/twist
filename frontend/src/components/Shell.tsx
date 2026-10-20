import { useStore } from '../lib/store';
import { Header } from './Header';
import { ChatSidebar } from './ChatSidebar';
import { AuthModal } from './AuthModal';
import { Donate } from './Donate';
import { DownloadsDock } from './DownloadsDock';

/**
 * The app frame: the scrolling main column plus the chat rail. Window chrome
 * (search, history, profile/downloads/chat/settings, window buttons) lives in
 * the TitleBar, which is rendered once above every route.
 */
export const Shell = ({ children }: { children: React.ReactNode }) => {
  // Chat visibility lives in the store: message polling stops while it is shut.
  const { chatOpen, setChatOpen } = useStore();

  return (
    <div className="relative flex h-full min-h-0 bg-twist-900">
      <div className="main-content flex min-w-0 flex-1 flex-col overflow-y-auto">
        <Header />
        <Donate />
        {children}
      </div>

      <ChatSidebar open={chatOpen} onClose={() => setChatOpen(false)} />
      <DownloadsDock />
      <AuthModal />
    </div>
  );
};
