import { Suspense, useEffect, lazy } from 'react';
import { Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { TitleBar } from './components/TitleBar';
import { MainPage } from './components/MainPage';
import { RouteNotFound } from './components/RouteState';
import { useOffline } from './lib/network';

/*
 * Only the landing page ships in the entry chunk. Everything else is loaded on
 * navigation, which keeps first paint fast: the wallet/crypto stack behind the
 * profile and settings screens alone is most of the bundle.
 */
const UserProfile = lazy(() => import('./components/UserProfile').then((m) => ({ default: m.UserProfile })));
const AdminPanel = lazy(() => import('./components/AdminPanel').then((m) => ({ default: m.AdminPanel })));
const InfoRoute = lazy(() => import('./routes/InfoRoute').then((m) => ({ default: m.InfoRoute })));
const WatchRoute = lazy(() => import('./routes/WatchRoute').then((m) => ({ default: m.WatchRoute })));
const LocalPlayer = lazy(() => import('./routes/LocalPlayer').then((m) => ({ default: m.LocalPlayer })));
const DownloadsPage = lazy(() => import('./views/DownloadsPage').then((m) => ({ default: m.DownloadsPage })));
const DownloadsInfoRoute = lazy(() =>
  import('./views/DownloadsInfo').then((m) => ({ default: m.DownloadsInfoRoute }))
);
const SettingsRoute = lazy(() => import('./routes/SettingsRoute').then((m) => ({ default: m.SettingsRoute })));
const LibraryPage = lazy(() => import('./views/LibraryPage').then((m) => ({ default: m.LibraryPage })));

/** Neutral placeholder while a route chunk loads; avoids a layout jump. */
const RouteFallback = () => (
  <div className="flex h-full items-center justify-center">
    <span className="block h-4 w-4 animate-spin rounded-full border-2 border-twist-gray/40 border-t-twist-lightgray" />
  </div>
);

export const App = () => {
  const offline = useOffline();
  const location = useLocation();
  // Offline the catalogue cannot load, so the only useful screen is the
  // downloaded episodes. Local playback and the downloads page stay as they are.
  const localRoute =
    location.pathname === '/downloads' || location.pathname.startsWith('/offline');

  return (
    <div className="flex h-screen min-h-screen flex-col bg-twist-900">
      <TitleBar />
      <div className="min-h-0 flex-1">
        <Suspense fallback={<RouteFallback />}>
          {offline && !localRoute ? (
            <DownloadsPage offline />
          ) : (
            <Routes>
              <Route path="/" element={<MainPage />} />
              <Route path="/downloads" element={<DownloadsPage />} />
              <Route path="/downloads/:slug" element={<DownloadsInfoRoute />} />
              <Route path="/settings" element={<SettingsRoute />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/profile" element={<UserProfile />} />
              <Route path="/profile/:username" element={<ProfileRoute />} />
              <Route path="/admin" element={<AdminPanel />} />
              <Route path="/:slug/info" element={<InfoRoute />} />
              <Route path="/:slug/watch/:episode" element={<WatchRoute />} />
              <Route path="/offline" element={<OfflineRedirect />} />
              <Route path="/offline/:id" element={<LocalPlayer />} />
              <Route
                path="*"
                element={
                  <RouteNotFound
                    title="Page not found"
                    detail="That link does not point anywhere in Twist."
                  />
                }
              />
            </Routes>
          )}
        </Suspense>
      </div>
    </div>
  );
};

const ProfileRoute = () => {
  const { username } = useParams<{ username: string }>();
  return <UserProfile username={username ? decodeURIComponent(username) : undefined} />;
};

/** `/offline` without an episode id lands on the downloads shelf. */
const OfflineRedirect = () => {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/downloads', { replace: true });
  }, [navigate]);
  return null;
};
