import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { blockedHosts } from './links';
import {
  applyRateLimits,
  foldModeration,
  isRootAddress,
  type ModerationDocs,
  type ModerationState,
} from './moderation';
import {
  fetchVaultProgress,
  fetchVaultSettings,
  flushVaultQueue,
  publishVaultProgress,
  publishVaultSettings,
  queueVaultUpload,
} from './vault';
import {
  beginSession,
  accountExistsOnChain,
  clearSession,
  getSession,
  persistSession,
  restoreSession,
} from './identity';
import {
  isUsernameClaimed,
  publishAccount,
  publishBan,
  publishChatMessage,
  publishComment,
  publishDelete,
  publishGenesis,
  publishProfile,
  publishRegistry,
  publishReport,
  publishStats,
  publishUnban,
  syncChat,
  syncModeration,
  syncProfiles,
  type ProfileSettings,
  type RemoteComment,
  type RemoteMessage,
  type RemoteUser,
} from './chain';
import { deriveWallet, passwordProblem, usernameProblem } from './wallet';
import { ensureNameClaims, noteClaim, syncNameClaims } from './names';

export type Theme = 'dark' | 'dim' | 'midnight';
export type ControlsMode = 'hover' | 'visible';
export type SubtitleSize = 'small' | 'medium' | 'large';
export type ViewMode = 'list' | 'cards';
/** Which title line is used across the app. */
export type TitleLanguage = 'romaji' | 'english';

/** YouTube-style caption styling; every field is independently adjustable. */
export type SubtitleStyle = {
  /** Font scale in percent (50â€“250). */
  scale: number;
  /** Caption text colour (#rrggbb). */
  color: string;
  /** Caption background colour (#rrggbb). */
  background: string;
  /** Background opacity in percent (0â€“100). */
  backgroundOpacity: number;
  /** Overall caption opacity in percent (0â€“100). */
  opacity: number;
  /** Outline colour. */
  stroke: string;
  /** Outline thickness in px (0â€“6). */
  strokeSize: number;
  /** Drop shadow on/off. */
  shadow: boolean;
};

export type Settings = {
  autoplay: boolean;
  autoNext: boolean;
  autoSkip: boolean;
  theme: Theme;
  accent: string;
  controls: ControlsMode;
  subtitles: SubtitleSize;
  viewMode: ViewMode;
  titleLanguage: TitleLanguage;
  subtitleStyle: SubtitleStyle;
  /** Caption visibility is remembered per audio track: dubs and subs differ. */
  subtitlesOn: { sub: boolean; dub: boolean };
  /** Seconds of episode-end warning before auto-next fires. */
  autoNextDelay: number;
  /** Where playback happens: the built-in player or an external one. */
  player: PlayerTarget;
  /** Preferred caption language code ("en", "es", …; "auto" = source default). */
  subtitleLanguage: string;
  /** Audio track picked by default when a title has both. */
  defaultTrack: 'sub' | 'dub';
  /** Home page appearance: hide the logo / search, widen the column, columns. */
  homeLogo: boolean;
  homeSearch: boolean;
  /** Column width for the home content, in px. */
  homeWidth: number;
  /** Cards per row in the grid view (2–6). */
  homeColumns: number;
};

/** Built-in player, a discovered external player id, or the OS default. */
export type PlayerTarget = string;

export type Account = {
  username: string;
  createdAt: number;
  /** Ethereum-style address derived from the credentials (the real identity). */
  address?: string;
  /** Avatar seed; empty falls back to the username's deterministic avatar. */
  avatar?: string;
  /** Profile card preset id (see `lib/profile.ts`). */
  card?: string;
};

export type Progress = {
  slug: string;
  episode: number;
  currentTime: number;
  duration: number;
  completed: boolean;
  updatedAt: number;
  /** Tombstone: this episode was deleted from the history on some device. */
  removed?: boolean;
};

/** One title saved for later. Kept small: the list renders from the catalogue. */
export type LibraryEntry = {
  slug: string;
  /** Title at the time it was saved, so the list is readable offline. */
  title: string;
  poster: string;
  addedAt: number;
};

export type Message = {
  id: string;
  username: string;
  body: string;
  at: number;
  mine?: boolean;
  /** Image posted via the GIF picker. */
  gif?: string;
  /** Snapshot of the message this one replies to. */
  replyTo?: { username: string; body: string };
  /** Author address for chain messages (canonical identity). */
  address?: string;
};

export type Dismissed = {
  /** Collapsed (not hidden) banners â€” the header arrow opens them again. */
  donate: boolean;
};

export type Comment = {
  id: string;
  slug: string;
  episode: number;
  /** Root comment id when this is a level-2 reply. */
  parentId?: string;
  /** Id of the comment being answered; replies show a snippet of it. */
  replyToId?: string;
  username: string;
  body: string;
  at: number;
  /** Author address for chain comments. */
  address?: string;
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  scale: 100,
  color: '#ffffff',
  background: '#000000',
  backgroundOpacity: 0,
  opacity: 100,
  stroke: '#000000',
  strokeSize: 2,
  shadow: true,
};

const DEFAULT_SETTINGS: Settings = {
  autoplay: false,
  autoNext: true,
  autoSkip: false,
  theme: 'dark',
  accent: '#d4433c',
  controls: 'hover',
  subtitles: 'medium',
  viewMode: 'list',
  titleLanguage: 'romaji',
  subtitleStyle: DEFAULT_SUBTITLE_STYLE,
  subtitlesOn: { sub: true, dub: true },
  autoNextDelay: 8,
  player: 'builtin',
  subtitleLanguage: 'auto',
  defaultTrack: 'sub',
  homeLogo: true,
  homeSearch: true,
  homeWidth: 672,
  homeColumns: 3,
};

const DEFAULT_DISMISSED: Dismissed = {
  donate: false,
};

/** The public copy of the preferences that travels in the profile document. */
const profileSettingsOf = (settings: Settings): ProfileSettings => ({ ...settings });

/** Validates settings from someone's public profile before applying them. */
const sanitizeProfileSettings = (patch?: ProfileSettings): Partial<Settings> => {
  if (!patch || typeof patch !== 'object') return {};

  const next: Partial<Settings> = {};
  if (patch.theme === 'dark' || patch.theme === 'dim' || patch.theme === 'midnight') {
    next.theme = patch.theme;
  }
  if (typeof patch.accent === 'string' && /^#[0-9a-f]{6}$/i.test(patch.accent.trim())) {
    next.accent = patch.accent.trim().toLowerCase();
  }
  if (patch.viewMode === 'list' || patch.viewMode === 'cards') next.viewMode = patch.viewMode;
  if (patch.titleLanguage === 'romaji' || patch.titleLanguage === 'english') {
    next.titleLanguage = patch.titleLanguage;
  }
  if (typeof patch.autoplay === 'boolean') next.autoplay = patch.autoplay;
  if (typeof patch.autoNext === 'boolean') next.autoNext = patch.autoNext;
  if (typeof patch.autoSkip === 'boolean') next.autoSkip = patch.autoSkip;
  if (patch.controls === 'hover' || patch.controls === 'visible') next.controls = patch.controls;
  if (
    patch.subtitles === 'small' ||
    patch.subtitles === 'medium' ||
    patch.subtitles === 'large'
  ) {
    next.subtitles = patch.subtitles;
  }
  if (patch.subtitleStyle && typeof patch.subtitleStyle === 'object') {
    next.subtitleStyle = {
      ...DEFAULT_SUBTITLE_STYLE,
      ...sanitizeSubtitleStyle(patch.subtitleStyle as Partial<SubtitleStyle>),
    };
  }
  if (patch.subtitlesOn && typeof patch.subtitlesOn === 'object') {
    next.subtitlesOn = {
      sub: Boolean((patch.subtitlesOn as Settings['subtitlesOn']).sub),
      dub: Boolean((patch.subtitlesOn as Settings['subtitlesOn']).dub),
    };
  }
  if (typeof patch.autoNextDelay === 'number' && patch.autoNextDelay >= 0) {
    next.autoNextDelay = Math.min(60, Math.round(patch.autoNextDelay));
  }
  // Player ids come from the desktop side's discovery ("builtin", "system",
  // "vlc", "mpv", …); anything else is ignored rather than persisted.
  if (typeof patch.player === 'string' && /^[a-z0-9_-]{3,40}$/.test(patch.player)) {
    next.player = patch.player;
  }
  if (typeof patch.subtitleLanguage === 'string' && /^(auto|[a-z]{2,3})$/.test(patch.subtitleLanguage)) {
    next.subtitleLanguage = patch.subtitleLanguage;
  }
  if (patch.defaultTrack === 'sub' || patch.defaultTrack === 'dub') {
    next.defaultTrack = patch.defaultTrack;
  }
  if (typeof patch.homeLogo === 'boolean') next.homeLogo = patch.homeLogo;
  if (typeof patch.homeSearch === 'boolean') next.homeSearch = patch.homeSearch;
  if (typeof patch.homeWidth === 'number' && Number.isFinite(patch.homeWidth)) {
    next.homeWidth = Math.min(1600, Math.max(560, Math.round(patch.homeWidth)));
  }
  if (typeof patch.homeColumns === 'number' && Number.isFinite(patch.homeColumns)) {
    next.homeColumns = Math.min(6, Math.max(2, Math.round(patch.homeColumns)));
  }
  return next;
};

/** Clamps caption styling to sane ranges so a stored value cannot break the UI. */
const sanitizeSubtitleStyle = (patch: Partial<SubtitleStyle>): Partial<SubtitleStyle> => {
  const next: Partial<SubtitleStyle> = {};
  const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  };
  const hex = (value: unknown) =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())
      ? value.trim().toLowerCase()
      : undefined;
  if (patch.scale !== undefined) next.scale = clamp(patch.scale, 50, 250, 100);
  if (patch.backgroundOpacity !== undefined) {
    next.backgroundOpacity = clamp(patch.backgroundOpacity, 0, 100, 0);
  }
  if (patch.opacity !== undefined) next.opacity = clamp(patch.opacity, 10, 100, 100);
  if (patch.strokeSize !== undefined) next.strokeSize = clamp(patch.strokeSize, 0, 6, 2);
  if (patch.color !== undefined) next.color = hex(patch.color) ?? '#ffffff';
  if (patch.background !== undefined) next.background = hex(patch.background) ?? '#000000';
  if (patch.stroke !== undefined) next.stroke = hex(patch.stroke) ?? '#000000';
  if (patch.shadow !== undefined) next.shadow = Boolean(patch.shadow);
  return next;
};

const STORAGE = {
  settings: 'twist:settings',
  account: 'twist:account',
  progress: 'twist:progress',
  library: 'twist:library',
  messages: 'twist:messages',
  dismissed: 'twist:dismissed',
  comments: 'twist:comments',
  commentLikes: 'twist:comment-likes',
  deletes: 'twist:deletes',
};

/** Local (not-yet-published) ids look like `${Date.now()}-${username}`. */
/**
 * Two progress keys name the same title. A route can be reached by its Kitsu
 * slug or by `mal-<id>` (downloads without a slug), and the same episode must
 * resume in both cases.
 */
const sameTitle = (a: string, b: string) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const strip = (value: string) => value.replace(/^(mal|anilist|kitsu)-/i, '');
  return strip(a) === strip(b);
};

const LOCAL_ID = /^\d{10,}-/;
/** Minimum gap between re-publish attempts for the same pending post. */
const RETRY_GAP_MS = 30_000;

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};

/**
 * Settings are read synchronously so the first paint already carries the
 * saved theme, accent and caption styling (no flash of the defaults).
 */
const loadSettings = (): Settings => {
  const stored = read<Partial<Settings>>(STORAGE.settings, {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE, ...(stored.subtitleStyle ?? {}) },
    subtitlesOn: { ...DEFAULT_SETTINGS.subtitlesOn, ...(stored.subtitlesOn ?? {}) },
  };
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
};

export const levelFromXp = (xp: number) => Math.floor(Math.sqrt(xp / 25)) + 1;

/**
 * Lightens (positive) or darkens (negative) a hex colour by `amount` percent
 * so the accent colour can drive its own hover and border variants.
 */
const shade = (hex: string, amount: number) => {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!match) return hex;

  const shift = (channel: string) => {
    const value = parseInt(channel, 16);
    const next = amount >= 0
      ? value + ((255 - value) * amount) / 100
      : value * (1 + amount / 100);
    return Math.round(Math.min(255, Math.max(0, next)))
      .toString(16)
      .padStart(2, '0');
  };

  return `#${shift(match[1])}${shift(match[2])}${shift(match[3])}`;
};

export const xpFromProgress = (progress: Progress[]) =>
  progress.reduce(
    (total, entry) =>
      total +
      (entry.completed ? 100 : Math.floor((entry.currentTime / Math.max(entry.duration, 1)) * 40)),
    0
  );

type Store = {
  ready: boolean;
  account: Account | null;
  settings: Settings;
  progress: Progress[];
  messages: Message[];
  /** Chat panel state â€” messages are only polled while it is open. */
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  /** Panel opened at / messages last synced, so the cache can pulse until fresh. */
  chatOpenedAt: number;
  chatSyncedAt: number;
  level: number;
  xp: number;
  watched: number;
  signUp: (username: string, password: string) => Promise<string | null>;
  signIn: (username: string, password: string) => Promise<string | null>;
  signOut: () => void;
  updateSettings: (patch: Partial<Settings>) => void;
  saveProgress: (entry: Omit<Progress, 'updatedAt'>) => void;
  toggleCompleted: (slug: string, episode: number) => void;
  /** Removes one episode from the watch history (local and cloud copies). */
  removeProgress: (slug: string, episode: number) => void;
  getProgress: (slug: string, episode: number) => Progress | undefined;
  postMessage: (
    body: string,
    options?: { gif?: string; replyTo?: { username: string; body: string } }
  ) => void;
  resetProgress: () => void;
  /** Titles saved for later ("library"), newest first. */
  library: LibraryEntry[];
  inLibrary: (slug: string) => boolean;
  toggleLibrary: (entry: Omit<LibraryEntry, 'addedAt'>) => void;
  removeFromLibrary: (slug: string) => void;
  dismissed: Dismissed;
  dismiss: (key: keyof Dismissed) => void;
  restore: (key: keyof Dismissed) => void;
  updateAccount: (patch: Partial<Pick<Account, 'avatar' | 'card'>>) => void;
  comments: Comment[];
  likedComments: string[];
  postComment: (input: {
    slug: string;
    episode: number;
    parentId?: string;
    replyToId?: string;
    body: string;
  }) => boolean;
  toggleCommentLike: (id: string) => void;
  authOpen: boolean;
  openAuth: () => void;
  closeAuth: () => void;
  /** Latest sync/offline status from the chain layer. */
  chainNotice: string | null;
  mergeRemoteMessages: (messages: RemoteMessage[]) => void;
  mergeRemoteComments: (comments: RemoteComment[]) => void;
  users: Record<string, RemoteUser>;
  mergeUsers: (users: RemoteUser[]) => void;
  /** True once the moderation fold has run at least once. */
  moderationReady: boolean;
  isAdmin: boolean;
  iAmBanned: boolean;
  admins: string[];
  bannedAddresses: string[];
  bannedBy: Record<string, string[]>;
  bannedReason: Record<string, string>;
  reports: ModerationState['reports'];
  genesis?: { address: string; docId: string };
  moderateDelete: (target: string) => void;
  moderateBan: (subject: string, reason?: string) => void;
  moderateUnban: (subject: string) => void;
  moderateAdmin: (action: 'add' | 'remove', subject: string) => void;
  reportContent: (target: string, targetType: 'message' | 'comment', reason?: string) => void;
};

const StoreContext = createContext<Store | null>(null);

export const StoreProvider = ({ children }: { children: React.ReactNode }) => {
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [dismissed, setDismissed] = useState<Dismissed>(DEFAULT_DISMISSED);
  const [comments, setComments] = useState<Comment[]>([]);
  const [likedComments, setLikedComments] = useState<string[]>([]);
  const [authOpen, setAuthOpen] = useState(false);
  const [chainNotice, setChainNotice] = useState<string | null>(null);
  const [moderation, setModeration] = useState<ModerationState | null>(null);
  const [moderationReady, setModerationReady] = useState(false);
  /** Deletes this client published, honoured until the chain fold confirms them. */
  const [localDeletes, setLocalDeletes] = useState<string[]>([]);
  const [users, setUsers] = useState<Record<string, RemoteUser>>({});
  const [sessionReady, setSessionReady] = useState(false);
  const [chatOpen, setChatOpenState] = useState(false);
  const [chatOpenedAt, setChatOpenedAt] = useState(0);
  const [chatSyncedAt, setChatSyncedAt] = useState(0);

  const accountRef = useRef<Account | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const commentsRef = useRef<Comment[]>([]);
  const progressRef = useRef<Progress[]>([]);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  /** Where the current settings came from (vault beats the public profile). */
  const settingsSource = useRef<'none' | 'vault' | 'profile'>('none');
  /** False on a device that never stored settings â€” safe to adopt the profile's. */
  const hadStoredSettings = useRef(false);
  /** JSON of the last settings copy published, so nothing is republished twice. */
  const pushedSettings = useRef<string | null>(null);
  /** Prevents a loop while healing a profile minted before settings existed. */
  const healedProfileSettings = useRef(false);
  /** True once the viewer changed a setting on this device (local wins then). */
  const settingsTouched = useRef(false);
  /** Progress keys already merged from the cloud, so it never overwrites newer local data. */
  const cloudProgress = useRef(new Set<string>());
  const failuresRef = useRef(0);
  const chatOpenRef = useRef(false);
  const syncCursor = useRef<{ chat: number; mod: number; users: number } | null>(null);
  const pendingProgress = useRef(new Map<string, Progress>());
  const progressTimer = useRef<number | undefined>(undefined);
  /** Last re-publish attempt per pending local id (throttles the retry). */
  const postingRef = useRef(new Map<string, number>());

  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
  }, [chatOpen]);

  useEffect(() => {
    const storedAccount = read<Account | null>(STORAGE.account, null);
    // Legacy local-only accounts (no chain address) are not signed in.
    setAccount(storedAccount && storedAccount.address ? storedAccount : null);
    if (storedAccount && !storedAccount.address) {
      try {
        localStorage.removeItem(STORAGE.account);
      } catch {
        /* ignore */
      }
    }

    try {
      hadStoredSettings.current = localStorage.getItem(STORAGE.settings) !== null;
    } catch {
      hadStoredSettings.current = false;
    }

    setProgress(read<Progress[]>(STORAGE.progress, []));
    setLibrary(read<LibraryEntry[]>(STORAGE.library, []));
    setMessages(
      read<Message[]>(STORAGE.messages, []).filter((message) => Boolean(message.address))
    );
    setComments(
      read<Comment[]>(STORAGE.comments, []).filter((comment) => Boolean(comment.address))
    );
    setLikedComments(read<string[]>(STORAGE.commentLikes, []));
    setLocalDeletes(read<string[]>(STORAGE.deletes, []));
    setDismissed({ ...DEFAULT_DISMISSED, ...read<Dismissed>(STORAGE.dismissed, DEFAULT_DISMISSED) });
    setReady(true);
  }, []);

  // Deletes this client published are durable: they never come back, even after
  // a reload, and do not depend on the indexer re-serving the delete document.
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE.deletes, JSON.stringify(localDeletes));
    } catch {
      /* storage unavailable or full */
    }
  }, [ready, localDeletes]);

  // Restore the wrapped session (memory-only keys come back without the password).
  useEffect(() => {
    if (!ready) return;
    let active = true;

    restoreSession()
      .then((wallet) => {
        if (!active) return;
        if (wallet) {
          setSessionReady(true);
          setAccount((prev) =>
            prev && prev.username.toLowerCase() === wallet.username.toLowerCase()
              ? { ...prev, address: wallet.address }
              : { username: wallet.username, address: wallet.address, createdAt: Date.now() }
          );
        } else {
          setAccount((prev) => {
            if (!prev) return prev;
            try {
              localStorage.removeItem(STORAGE.account);
            } catch {
              /* ignore */
            }
            return null;
          });
        }
      })
      .catch(() => {
        /* session unavailable */
      });

    return () => {
      active = false;
    };
  }, [ready]);

  useEffect(() => {
    // Runs before `ready` too: the settings were loaded synchronously, so the
    // custom theme/accent applies on the very first paint.
    write(STORAGE.settings, settings);

    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    // Tailwind v4 compiles `bg-twist-red` to var(--color-twist-red), so
    // overriding these at runtime re-themes every accent usage at once.
    root.style.setProperty('--color-twist-red', settings.accent);
    root.style.setProperty('--color-twist-redlight', shade(settings.accent, 26));
    root.style.setProperty('--color-twist-reddark', shade(settings.accent, -26));
    root.style.setProperty('--accent', settings.accent);
    // Page width is shared by every route through `.content-column`.
    root.style.setProperty('--content-width', `${settings.homeWidth}px`);
  }, [settings]);

  useEffect(() => {
    if (!ready) return;
    write(STORAGE.messages, messages);
  }, [ready, messages]);

  useEffect(() => {
    if (!ready) return;
    write(STORAGE.progress, progress);
  }, [ready, progress]);

  useEffect(() => {
    if (!ready) return;
    write(STORAGE.dismissed, dismissed);
  }, [ready, dismissed]);

  useEffect(() => {
    if (!ready || !account) return;
    write(STORAGE.account, account);
  }, [ready, account]);

  useEffect(() => {
    if (!ready) return;
    write(STORAGE.comments, comments);
  }, [ready, comments]);

  useEffect(() => {
    if (!ready) return;
    write(STORAGE.commentLikes, likedComments);
  }, [ready, likedComments]);

  /* ------------------------------ account ------------------------------ */

  const signUp = useCallback(async (username: string, password: string) => {
    const nameProblem = usernameProblem(username);
    if (nameProblem) return nameProblem;

    const passProblem = passwordProblem(password);
    if (passProblem) return passProblem;

    // First-come usernames: the local ledger must cover the history first
    // (with a fresh look at the newest chunk), then the claim is final.
    if (!(await ensureNameClaims(40, true))) {
      return 'Could not check that username right now â€” try again in a moment.';
    }

    try {
      if (await isUsernameClaimed(username)) {
        return 'That username is already taken.';
      }
    } catch {
      return 'Could not check that username right now â€” try again in a moment.';
    }

    const wallet = await deriveWallet(username, password);
    beginSession(wallet);
    await persistSession(wallet);
    setSessionReady(true);
    setAccount({
      username: wallet.username,
      address: wallet.address,
      createdAt: Date.now(),
    });
    noteClaim(wallet.username, Date.now(), wallet.address);

    // Mint the account: genesis + default profile (with the default
    // appearance/playback settings) + initial stats.
    try {
      await publishAccount(
        wallet,
        { settings: profileSettingsOf(settingsRef.current) },
        { level: 1, xp: 0, watched: 0 }
      );
      pushedSettings.current = JSON.stringify(settingsRef.current);
      setChainNotice(null);
    } catch {
      setChainNotice(
        'Welcome! We will finish setting up your account when you are back online.'
      );
    }

    return null;
  }, []);

  const signIn = useCallback(async (username: string, password: string) => {
    const nameProblem = usernameProblem(username);
    if (nameProblem) return nameProblem;

    const wallet = await deriveWallet(username, password);
    const cached = read<Account | null>(STORAGE.account, null);
    const matchesCache =
      Boolean(cached?.address) &&
      cached!.username.toLowerCase() === wallet.username.toLowerCase();

    if (matchesCache && cached!.address!.toLowerCase() !== wallet.address.toLowerCase()) {
      return 'Unknown username or wrong password.';
    }

    if (!matchesCache) {
      // Fresh device: any signed document by the derived address proves the
      // credentials are correct (a wrong password derives another address).
      try {
        const exists = await accountExistsOnChain(wallet);
        if (!exists) return 'Unknown username or wrong password.';
      } catch {
        return 'Could not verify your account â€” check your connection and try again.';
      }
    }

    beginSession(wallet);
    await persistSession(wallet);
    setSessionReady(true);
    setAccount({
      username: wallet.username,
      address: wallet.address,
      createdAt: cached?.createdAt ?? Date.now(),
      avatar: cached?.avatar,
      card: cached?.card,
    });

    // Heal on-chain records (accounts created before publishing worked).
    void (async () => {
      try {
        await publishGenesis(wallet);
        await publishProfile(wallet, {
          avatar: cached?.avatar,
          card: cached?.card,
          settings: profileSettingsOf(settingsRef.current),
        });
        pushedSettings.current = JSON.stringify(settingsRef.current);
      } catch {
        /* offline â€” retried on the next sign-in */
      }
    })();

    setChainNotice(null);
    return null;
  }, []);

  const signOut = useCallback(() => {
    setSessionReady(false);
    setAccount(null);
    setChainNotice(null);
    try {
      localStorage.removeItem(STORAGE.account);
    } catch {
      /* ignore */
    }
    void clearSession();
  }, []);

  const updateAccount = useCallback(
    (patch: Partial<Pick<Account, 'avatar' | 'card'>>) => {
      setAccount((prev) => (prev ? { ...prev, ...patch } : prev));

      const wallet = getSession();
      const current = accountRef.current;
      if (wallet && current) {
        const merged = { ...current, ...patch };
        void publishProfile(wallet, {
          avatar: merged.avatar,
          card: merged.card,
          settings: profileSettingsOf(settingsRef.current),
        }).catch(() => {
          setChainNotice('Profile saved on this device â€” it will update when you are back online.');
        });
      }
    },
    []
  );

  /* ------------------------------ settings ----------------------------- */

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    // A deliberate change on this device outranks whatever the cloud holds.
    settingsTouched.current = true;
    settingsRef.current = { ...settingsRef.current, ...patch };
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  /* ------------------------------ progress ----------------------------- */

  const flushProgress = useCallback(() => {
    window.clearTimeout(progressTimer.current);
    progressTimer.current = undefined;
    const entries = [...pendingProgress.current.values()];
    pendingProgress.current.clear();
    if (entries.length === 0) return;
    const wallet = getSession();
    if (!wallet) {
      queueVaultUpload('progress', entries);
      return;
    }
    publishVaultProgress(wallet, entries).catch(() => queueVaultUpload('progress', entries));
  }, []);

  const queueProgressPush = useCallback(
    (entry: Progress) => {
      pendingProgress.current.set(`${entry.slug}:${entry.episode}`, entry);
      // Only start the debounce when nothing is pending. Clearing and
      // restarting it on every tick meant playback (which saves every 5s)
      // never reached the cloud.
      if (progressTimer.current !== undefined) return;
      progressTimer.current = window.setTimeout(flushProgress, 5000);
    },
    [flushProgress]
  );

  // Leaving the page or closing the window must not drop the last position.
  useEffect(() => {
    const flush = () => flushProgress();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flushProgress]);

  const saveProgress = useCallback(
    (entry: Omit<Progress, 'updatedAt'>) => {
      const existing = progressRef.current.find(
        (p) => p.episode === entry.episode && sameTitle(p.slug, entry.slug)
      );

      // Writing identical data would re-render every subscriber; bail out so
      // effect-driven saves cannot loop.
      if (
        existing &&
        existing.currentTime === entry.currentTime &&
        existing.duration === entry.duration &&
        existing.completed === entry.completed
      ) {
        return;
      }

      const stamped: Progress = {
        ...entry,
        // Keep the canonical key already on record for this title.
        slug: existing?.slug ?? entry.slug,
        // Playing an episode again must never clear its watched state.
        completed: entry.completed || existing?.completed === true,
        updatedAt: Date.now(),
      };
      setProgress((prev) => {
        const next = [
          ...prev.filter((p) => !(p.episode === entry.episode && sameTitle(p.slug, stamped.slug))),
          stamped,
        ];
        // Local storage is the source of truth for resume; the cloud copy is
        // only a backup, so write it now instead of waiting for the effect.
        write(STORAGE.progress, next);
        return next;
      });
      queueProgressPush(stamped);
    },
    [queueProgressPush]
  );

  const toggleCompleted = useCallback(
    (slug: string, episode: number) => {
      const found = progressRef.current.find(
        (p) => p.episode === episode && sameTitle(p.slug, slug)
      );
      if (!found) return;

      const changed: Progress = {
        ...found,
        completed: !found.completed,
        updatedAt: Date.now(),
      };
      setProgress((prev) => {
        const next = [
          ...prev.filter((p) => !(p.episode === episode && sameTitle(p.slug, slug))),
          changed,
        ];
        write(STORAGE.progress, next);
        return next;
      });
      queueProgressPush(changed);
    },
    [queueProgressPush]
  );

  const getProgress = useCallback(
    (slug: string, episode: number) =>
      progress.find((p) => p.episode === episode && sameTitle(p.slug, slug)),
    [progress]
  );

  const resetProgress = useCallback(() => {
    setProgress([]);
    try {
      localStorage.removeItem(STORAGE.progress);
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * Deleting one episode.
   *
   * The vault is an append-only set of documents that are folded by timestamp,
   * so simply dropping the entry locally would bring it back on the next sync.
   * Instead a tombstone (a progress entry with `removed: true`) is written: the
   * fold keeps the newest record per episode, and tombstones are filtered out
   * when the history is loaded.
   */
  const removeProgress = useCallback(
    (slug: string, episode: number) => {
      const found = progressRef.current.find(
        (entry) => entry.episode === episode && sameTitle(entry.slug, slug)
      );
      const key = found?.slug ?? slug;

      setProgress((prev) => {
        const next = prev.filter(
          (entry) => !(entry.episode === episode && sameTitle(entry.slug, slug))
        );
        write(STORAGE.progress, next);
        return next;
      });

      const tombstone: Progress = {
        slug: key,
        episode,
        currentTime: 0,
        duration: 0,
        completed: false,
        updatedAt: Date.now(),
        removed: true,
      };
      pendingProgress.current.set(`${tombstone.slug}:${tombstone.episode}`, tombstone);
      if (progressTimer.current === undefined) {
        progressTimer.current = window.setTimeout(flushProgress, 1200);
      }
    },
    [flushProgress]
  );

  /* ------------------------------ library ------------------------------ */

  const inLibrary = useCallback(
    (slug: string) => library.some((entry) => sameTitle(entry.slug, slug)),
    [library]
  );

  const toggleLibrary = useCallback((entry: Omit<LibraryEntry, 'addedAt'>) => {
    setLibrary((prev) => {
      const exists = prev.some((item) => sameTitle(item.slug, entry.slug));
      const next = exists
        ? prev.filter((item) => !sameTitle(item.slug, entry.slug))
        : [{ ...entry, addedAt: Date.now() }, ...prev];
      write(STORAGE.library, next);
      return next;
    });
  }, []);

  const removeFromLibrary = useCallback((slug: string) => {
    setLibrary((prev) => {
      const next = prev.filter((item) => !sameTitle(item.slug, slug));
      write(STORAGE.library, next);
      return next;
    });
  }, []);

  /* -------------------------------- chat ------------------------------- */

  const postMessage = useCallback(
    (
      body: string,
      options?: { gif?: string; replyTo?: { username: string; body: string } }
    ) => {
      const text = body.trim();
      if (!account) return;

      if (account.address && bannedSet.has(account.address.toLowerCase())) {
        setChainNotice('Your account is banned â€” posting is disabled.');
        return;
      }

      // The composer blocks disallowed links before sending; this guard makes
      // sure nothing bypassing it can persist a blocked link either.
      if (!options?.gif && (!text || blockedHosts(text).length > 0)) return;

      const localId = `${Date.now()}-${account.username}`;
      setMessages((prev) => [
        ...prev,
        {
          id: localId,
          username: account.username,
          address: account.address,
          body: text,
          gif: options?.gif,
          replyTo: options?.replyTo,
          at: Date.now(),
          mine: true,
        },
      ]);

      const wallet = getSession();
      if (!wallet) {
        setChainNotice('Session locked â€” sign in again to sync new messages.');
        return;
      }

      publishChatMessage(wallet, text, options)
        .then((docId) => {
          setMessages((prev) =>
            prev.map((message) => (message.id === localId ? { ...message, id: docId } : message))
          );
          setChainNotice(null);
        })
        .catch(() => {
          setChainNotice('Message saved on this device â€” retrying to publish it.');
        });
    },
    [account]
  );

  const mergeUsers = useCallback((incoming: RemoteUser[]) => {
    if (incoming.length === 0) return;

    // Profile documents double as claims: the ledger learns name â†’ address.
    for (const user of incoming) {
      if (user.username) {
        noteClaim(user.username, user.profileTs ?? user.updatedAt, user.address);
      }
    }

    // Our own profile carries the public copy of the appearance/playback
    // settings: adopt it on a fresh device, or fill it in when missing.
    const me = accountRef.current?.address?.toLowerCase();
    const own = me ? incoming.find((user) => user.address.toLowerCase() === me) : undefined;
    if (own) {
      const patch = sanitizeProfileSettings(own.settings);

      if (Object.keys(patch).length === 0) {
        // Minted before settings existed â€” publish ours once per session.
        if (!healedProfileSettings.current) {
          const wallet = getSession();
          if (wallet) {
            healedProfileSettings.current = true;
            const payload = JSON.stringify(settingsRef.current);
            void publishProfile(wallet, {
              avatar: accountRef.current?.avatar ?? own.avatar,
              card: accountRef.current?.card ?? own.card,
              settings: profileSettingsOf(settingsRef.current),
            })
              .then(() => {
                pushedSettings.current = payload;
              })
              .catch(() => {
                healedProfileSettings.current = false; // retried next session
              });
          }
        }
      } else if (settingsSource.current === 'none' && !settingsTouched.current) {
        // No vault copy: the public profile copy is adopted when it differs
        // from what this device stored, unless the viewer already saved a
        // change here.
        settingsSource.current = 'profile';
        const merged = { ...DEFAULT_SETTINGS, ...settingsRef.current, ...patch };
        pushedSettings.current = JSON.stringify(merged);
        settingsRef.current = merged;
        setSettings(merged);
      }
    }

    setUsers((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const user of incoming) {
        const existing = next[user.address];
        if (!existing || user.updatedAt > existing.updatedAt) {
          next[user.address] = user;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const mergeRemoteMessages = useCallback((incoming: RemoteMessage[]) => {
    if (incoming.length === 0) return;

    setMessages((prev) => {
      const known = new Set(prev.map((message) => message.id));
      const fresh = incoming
        .filter((message) => !known.has(message.id))
        .map<Message>((message) => ({
          id: message.id,
          username: message.username,
          body: message.body,
          gif: message.gif,
          replyTo: message.replyTo,
          at: message.at,
          address: message.author,
          mine: accountRef.current?.address
            ? message.author.toLowerCase() === accountRef.current.address.toLowerCase()
            : false,
        }));

      if (fresh.length === 0) return prev;
      return [...prev, ...fresh].sort(
        (a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)
      );
    });
  }, []);

  const foldDocs = useCallback((docs: ModerationDocs) => {
    // First fold gives us the admin set; tombstones are only valid from a
    // current admin or from the author of the targeted document itself.
    const partial = foldModeration({ ...docs, deletes: [] });
    const adminSet = new Set(partial.admins);
    const byId = new Map<string, string | undefined>();
    for (const message of messagesRef.current) byId.set(message.id, message.address);
    for (const comment of commentsRef.current) byId.set(comment.id, comment.address);

    const deletes = docs.deletes.filter((doc) => {
      if (adminSet.has(doc.author.toLowerCase())) return true;
      const targetAuthor = byId.get(doc.payload.target);
      return Boolean(
        targetAuthor && targetAuthor.toLowerCase() === doc.author.toLowerCase()
      );
    });

    return foldModeration({ ...docs, deletes });
  }, []);

  const refreshModeration = useCallback(async () => {
    const docs = await syncModeration(Date.now() - 90 * 24 * 60 * 60 * 1000);
    setModeration(foldDocs(docs));
    setModerationReady(true);
  }, [foldDocs]);

  /**
   * Re-publishes anything that was only ever saved locally.
   *
   * A post is optimistic: it shows up immediately with a local id, then the id
   * becomes the on-chain one when the upload lands. If that upload failed, the
   * message stayed a local phantom (visible only to the author) forever. This
   * retries those until they reach the chain, so everyone sees them.
   */
  const flushPendingPosts = useCallback(() => {
    const wallet = getSession();
    if (!wallet) return;
    const now = Date.now();

    for (const message of messagesRef.current) {
      if (!message.mine || !message.address || !LOCAL_ID.test(message.id)) continue;
      if (now - (postingRef.current.get(message.id) ?? 0) < RETRY_GAP_MS) continue;
      postingRef.current.set(message.id, now);
      const localId = message.id;
      publishChatMessage(wallet, message.body, { gif: message.gif, replyTo: message.replyTo })
        .then((docId) =>
          setMessages((prev) =>
            prev.map((m) => (m.id === localId ? { ...m, id: docId } : m))
          )
        )
        .catch(() => undefined);
    }

    for (const comment of commentsRef.current) {
      if (!comment.address || !LOCAL_ID.test(comment.id)) continue;
      if (now - (postingRef.current.get(comment.id) ?? 0) < RETRY_GAP_MS) continue;
      postingRef.current.set(comment.id, now);
      const localId = comment.id;
      publishComment(wallet, {
        slug: comment.slug,
        episode: comment.episode,
        parentId: comment.parentId,
        replyToId: comment.replyToId,
        body: comment.body,
      })
        .then((docId) =>
          setComments((prev) =>
            prev.map((c) => (c.id === localId ? { ...c, id: docId } : c))
          )
        )
        .catch(() => undefined);
    }
  }, []);

  /** One chat pull: verifies and merges anything new since `since`. */
  const pullChat = useCallback(
    async (since: number) => {
      const known = new Set(messagesRef.current.map((message) => message.id));
      const remote = await syncChat(known, since);
      if (remote.length > 0) mergeRemoteMessages(remote);
      setChatSyncedAt(Date.now());
    },
    [mergeRemoteMessages]
  );

  /**
   * Opening the panel immediately catches up on the backlog; closing it stops
   * the polling altogether (the background loop skips chat while it is shut).
   */
  const setChatOpen = useCallback(
    (open: boolean) => {
      setChatOpenState(open);
      if (!open) return;
      setChatOpenedAt(Date.now());

      const since = syncCursor.current?.chat ?? Date.now() - 14 * 24 * 60 * 60 * 1000;
      void pullChat(since)
        .then(() => {
          syncCursor.current = {
            chat: Date.now() - 60_000,
            mod: syncCursor.current?.mod ?? Date.now() - 90 * 24 * 60 * 60 * 1000,
            users: syncCursor.current?.users ?? Date.now() - 14 * 24 * 60 * 60 * 1000,
          };
        })
        .catch(() => undefined);
    },
    [pullChat]
  );

  // Live sync (chat + moderation + public profiles) â€” public reads, so it
  // runs signed in or out; pauses when hidden and backs off on failures.
  // Sources are staggered and only advance their own cursor, so one slow
  // query (the indexer is shared and throttles) never blocks the others.
  useEffect(() => {
    if (!ready) return;
    const DAY = 24 * 60 * 60 * 1000;
    let active = true;
    let timer: number | undefined;
    let ticks = 0;

    const tick = async () => {
      if (!document.hidden) {
        // Retry anything still only saved locally (failed uploads).
        flushPendingPosts();
        const now = Date.now();
        // Initial windows stay narrow â€” wide ones time the indexer out; the
        // local claim ledger backfills older history (`names.ts`).
        const cursors = syncCursor.current ?? {
          chat: now - 14 * DAY,
          mod: now - 90 * DAY,
          users: now - 14 * DAY,
        };
        const next = { ...cursors };

        // Re-scan an overlapping window for moderation: a delete can be
        // indexed seconds after it was queried, and a forward-only cursor would
        // step past it and never see it (leaving the message visible). Bucketed
        // to the hour so the indexer query stays cacheable.
        const hourFloor = Math.floor(now / 3_600_000) * 3_600_000;
        const modFrom = Math.min(cursors.mod, hourFloor - 3_600_000);

        const chatTask = chatOpenRef.current
          ? (async () => {
              await pullChat(cursors.chat);
              next.chat = Date.now() - 60_000;
            })()
          : Promise.resolve();

        // Heavier feeds are staggered so the query budget stays low.
        const usersTask =
          ticks % 2 === 0
            ? (async () => {
                const remoteUsers = await syncProfiles(cursors.users);
                if (active) mergeUsers(remoteUsers);
                next.users = Date.now() - 60_000;
              })()
            : Promise.resolve();

        const modTask =
          ticks % 3 === 0
            ? (async () => {
                const modDocs = await syncModeration(modFrom);
                if (active) {
                  setModeration(foldDocs(modDocs));
                  setModerationReady(true);
                }
                next.mod = Date.now() - 60_000;
              })()
            : Promise.resolve();

        // One page of the username-claims walk per tick; self-throttled
        // once the ledger is complete.
        const walkTask = syncNameClaims().catch(() => false);

        ticks += 1;
        const results = await Promise.allSettled([chatTask, usersTask, modTask, walkTask]);
        if (!active) return;

        syncCursor.current = next;

        if (results.some((result) => result.status === 'rejected')) {
          failuresRef.current += 1;
          // A single flaky query is normal; only warn once content is stale.
          if (failuresRef.current >= 2) {
            setChainNotice('You are offline â€” showing cached content.');
          }
        } else {
          setChainNotice(null);
          failuresRef.current = 0;
        }
      }

      if (!active) return;
      // Chat should feel live: poll faster while the panel is open.
      const base = chatOpenRef.current ? 5_000 : 10_000;
      const delay = Math.min(base * 2 ** Math.min(failuresRef.current, 3), 60_000);
      timer = window.setTimeout(tick, delay);
    };

    void tick();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [ready, mergeRemoteMessages, mergeUsers, foldDocs, flushPendingPosts]);

  // Hydrate vaults (settings + progress) once per session, then flush any
  // uploads that were queued while offline.
  useEffect(() => {
    if (!ready || !sessionReady) return;
    const wallet = getSession();
    if (!wallet) return;
    let active = true;

    (async () => {
      try {
        const [vaultSettings, vaultProgress] = await Promise.all([
          fetchVaultSettings(wallet),
          fetchVaultProgress(wallet),
        ]);
        if (!active) return;

        if (vaultSettings) {
          // Local storage is applied first (the UI is already painted with it);
          // the cloud copy is adopted when it disagrees — unless the viewer
          // changed settings on this device, in which case local wins and the
          // cloud copy is replaced by ours on the next publish.
          settingsSource.current = 'vault';
          if (!settingsTouched.current) {
            const merged = { ...DEFAULT_SETTINGS, ...settingsRef.current, ...vaultSettings };
            pushedSettings.current = JSON.stringify(merged);
            settingsRef.current = merged;
            setSettings(merged);
          } else {
            pushedSettings.current = null;
          }
        }

        if (vaultProgress.length > 0) {
          setProgress((prev) => {
            const next = [...prev];
            for (const entry of vaultProgress) {
              const key = `${entry.slug}:${entry.episode}`;
              // Only ever fold a cloud entry in once: afterwards local writes
              // are newer by definition and must not be rolled back.
              if (cloudProgress.current.has(key)) continue;
              cloudProgress.current.add(key);
              const index = next.findIndex(
                (local) => local.episode === entry.episode && sameTitle(local.slug, entry.slug)
              );
              // A tombstone deletes the episode rather than showing it: the
              // fold keeps the newest record, so a delete on another device
              // must win over an older saved position.
              if (entry.removed) {
                if (index !== -1 && entry.updatedAt > next[index].updatedAt) next.splice(index, 1);
                continue;
              }
              if (index === -1) {
                next.push(entry);
              } else if (entry.updatedAt > next[index].updatedAt) {
                next[index] = entry;
              }
            }
            // Tombstones are sync bookkeeping, never history rows.
            const visible = next.filter((entry) => !entry.removed);
            write(STORAGE.progress, visible);
            return visible;
          });
        }
      } catch {
        if (active) setChainNotice('Could not load your saved data â€” using this device\'s copy.');
      }

      if (active) void flushVaultQueue(wallet).catch(() => {});
    })();

    // A fresh session is the best moment to republish anything left local.
    flushPendingPosts();

    return () => {
      active = false;
    };
  }, [ready, sessionReady, flushPendingPosts]);

  // Push settings to the vault (private) and to the profile (public copy, so
  // a fresh device without the vault still gets the same look). Debounced;
  // vault uploads are queued when offline.
  useEffect(() => {
    if (!ready || !sessionReady) return;
    const wallet = getSession();
    if (!wallet) return;

    const payload = JSON.stringify(settings);
    if (payload === pushedSettings.current) return;

    const id = window.setTimeout(() => {
      pushedSettings.current = payload;
      publishVaultSettings(wallet, settings).catch(() =>
        queueVaultUpload('settings', settings)
      );
      // The public profile copy is what other devices (and a lost vault) read,
      // so it is published on the same schedule as the vault.
      publishProfile(wallet, {
        avatar: accountRef.current?.avatar,
        card: accountRef.current?.card,
        settings: profileSettingsOf(settings),
      }).catch(() => {
        /* offline — the next change or sign-in republishes */
      });
    }, 800);
    return () => window.clearTimeout(id);
  }, [ready, sessionReady, settings]);

  /* ---------------------------- moderation ------------------------------ */

  const moderateDelete = useCallback(
    (target: string) => {
      const wallet = getSession();
      if (!wallet) return;
      // Hide it right away (the fold may not have the delete doc yet); undo if
      // the upload itself fails.
      setLocalDeletes((prev) =>
        prev.includes(target) ? prev : [...prev, target].slice(-500)
      );
      publishDelete(wallet, target)
        .then(() => refreshModeration())
        .catch(() => {
          setLocalDeletes((prev) => prev.filter((id) => id !== target));
          setChainNotice('Could not publish that delete â€” try again.');
        });
    },
    [refreshModeration]
  );

  const moderateBan = useCallback(
    (subject: string, reason?: string) => {
      if (isRootAddress(subject)) {
        setChainNotice("The root admin can't be banned.");
        return;
      }
      const wallet = getSession();
      if (!wallet) return;
      publishBan(wallet, subject, reason)
        .then(() => refreshModeration())
        .catch(() => setChainNotice('Could not publish that ban â€” try again.'));
    },
    [refreshModeration]
  );

  const moderateUnban = useCallback(
    (subject: string) => {
      const wallet = getSession();
      if (!wallet) return;
      publishUnban(wallet, subject)
        .then(() => refreshModeration())
        .catch(() => setChainNotice('Could not publish that unban â€” try again.'));
    },
    [refreshModeration]
  );

  const moderateAdmin = useCallback(
    (action: 'add' | 'remove', subject: string) => {
      const wallet = getSession();
      if (!wallet) return;
      publishRegistry(wallet, action, subject)
        .then(() => refreshModeration())
        .catch(() => setChainNotice('Could not update the admin list â€” try again.'));
    },
    [refreshModeration]
  );

  const reportContent = useCallback(
    (target: string, targetType: 'message' | 'comment', reason?: string) => {
      const wallet = getSession();
      if (!wallet) return;
      publishReport(wallet, { target, targetType, reason })
        .then(() => setChainNotice('Report sent to the moderators.'))
        .catch(() => setChainNotice('Could not send the report â€” try again.'));
    },
    []
  );

  /* ------------------------------ comments ----------------------------- */

  const postComment = useCallback(
    (input: {
      slug: string;
      episode: number;
      parentId?: string;
      replyToId?: string;
      body: string;
    }) => {
      if (!account) return false;

      if (account.address && bannedSet.has(account.address.toLowerCase())) {
        setChainNotice('Your account is banned â€” posting is disabled.');
        return false;
      }

      const text = input.body.trim();
      if (!text || blockedHosts(text).length > 0) return false;

      const localId = `${Date.now()}-${account.username}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;

      setComments((prev) => [
        ...prev,
        {
          id: localId,
          slug: input.slug,
          episode: input.episode,
          parentId: input.parentId,
          replyToId: input.replyToId,
          username: account.username,
          address: account.address,
          body: text,
          at: Date.now(),
        },
      ]);

      const wallet = getSession();
      if (wallet) {
        publishComment(wallet, {
          slug: input.slug,
          episode: input.episode,
          parentId: input.parentId,
          replyToId: input.replyToId,
          body: text,
        })
          .then((docId) => {
            setComments((prev) =>
              prev.map((comment) =>
                comment.id === localId ? { ...comment, id: docId } : comment
              )
            );
            setChainNotice(null);
          })
          .catch(() => {
            setChainNotice('Comment saved on this device â€” retrying to publish it.');
          });
      }

      return true;
    },
    [account]
  );

  const mergeRemoteComments = useCallback((incoming: RemoteComment[]) => {
    if (incoming.length === 0) return;

    setComments((prev) => {
      const known = new Set(prev.map((comment) => comment.id));
      const fresh = incoming.filter((comment) => !known.has(comment.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, []);

  const toggleCommentLike = useCallback(
    (id: string) => {
      if (!account) return;
      setLikedComments((prev) =>
        prev.includes(id) ? prev.filter((liked) => liked !== id) : [...prev, id]
      );
    },
    [account]
  );

  /* ------------------------------ banners ------------------------------ */

  const dismiss = useCallback((key: keyof Dismissed) => {
    setDismissed((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);

  const restore = useCallback((key: keyof Dismissed) => {
    setDismissed((prev) => (prev[key] ? { ...prev, [key]: false } : prev));
  }, []);

  const openAuth = useCallback(() => setAuthOpen(true), []);
  const closeAuth = useCallback(() => setAuthOpen(false), []);

  /* ------------------------------- value ------------------------------- */

  const xp = useMemo(() => xpFromProgress(progress), [progress]);
  const level = useMemo(() => levelFromXp(xp), [xp]);
  const watched = useMemo(() => progress.filter((p) => p.completed).length, [progress]);

  const squatters = useMemo(() => {
    // Usernames are first-come: the OLDEST profile claim stays valid, every
    // newer wallet using the same name is treated as banned.
    const byName = new Map<string, { address: string; profileTs: number }[]>();
    for (const user of Object.values(users)) {
      if (!user.username || user.profileTs === undefined) continue;
      const key = user.username.toLowerCase();
      const list = byName.get(key) ?? [];
      list.push({ address: user.address, profileTs: user.profileTs });
      byName.set(key, list);
    }

    const banned: string[] = [];
    for (const entries of byName.values()) {
      if (entries.length < 2) continue;
      const sorted = [...entries].sort(
        (a, b) => a.profileTs - b.profileTs || (a.address < b.address ? -1 : 1)
      );
      for (const entry of sorted.slice(1)) banned.push(entry.address);
    }
    return banned;
  }, [users]);

  const bannedSet = useMemo(
    () => new Set([...(moderation?.banned ?? []), ...squatters]),
    [moderation, squatters]
  );

  const bannedReasonMerged = useMemo(() => {
    const merged: Record<string, string> = { ...(moderation?.bannedReason ?? {}) };
    for (const address of squatters) {
      if (!merged[address]) merged[address] = 'duplicate username';
    }
    return merged;
  }, [moderation, squatters]);

  const tombstoneSet = useMemo(
    () => new Set([...(moderation?.tombstones ?? []), ...localDeletes]),
    [moderation, localDeletes]
  );

  const visibleMessages = useMemo(() => {
    const filtered = messages.filter(
      (message) =>
        !tombstoneSet.has(message.id) &&
        !(message.address && bannedSet.has(message.address.toLowerCase()))
    );
    return applyRateLimits(filtered);
  }, [messages, tombstoneSet, bannedSet]);

  const visibleComments = useMemo(
    () =>
      comments.filter(
        (comment) =>
          !tombstoneSet.has(comment.id) &&
          !(comment.address && bannedSet.has(comment.address.toLowerCase()))
      ),
    [comments, tombstoneSet, bannedSet]
  );

  const isAdmin = useMemo(
    () =>
      Boolean(
        account?.address &&
          // The pinned root is an admin the moment it signs in â€” no chain round-trip.
          (isRootAddress(account.address) ||
            moderation?.admins.includes(account.address.toLowerCase()))
      ),
    [account, moderation]
  );

  const iAmBanned = useMemo(
    () => Boolean(account?.address && bannedSet.has(account.address.toLowerCase())),
    [account, bannedSet]
  );

  // Publish public stats (debounced) for profile cards.
  useEffect(() => {
    if (!ready || !sessionReady) return;
    const wallet = getSession();
    if (!wallet) return;

    const id = window.setTimeout(() => {
      publishStats(wallet, { level, xp, watched }).catch(() => {});
    }, 30_000);
    return () => window.clearTimeout(id);
  }, [ready, sessionReady, level, xp, watched]);

  const value = useMemo<Store>(
    () => ({
      ready,
      account,
      settings,
      progress,
      messages: visibleMessages,
      chatOpen,
      setChatOpen,
      chatOpenedAt,
      chatSyncedAt,
      level,
      xp,
      watched,
      signUp,
      signIn,
      signOut,
      updateSettings,
      saveProgress,
      toggleCompleted,
      removeProgress,
      getProgress,
      postMessage,
      resetProgress,
      library,
      inLibrary,
      toggleLibrary,
      removeFromLibrary,
      dismissed,
      dismiss,
      restore,
      updateAccount,
      comments: visibleComments,
      likedComments,
      postComment,
      toggleCommentLike,
      authOpen,
      openAuth,
      closeAuth,
      chainNotice,
      mergeRemoteMessages,
      mergeRemoteComments,
      users,
      mergeUsers,
      moderationReady,
      isAdmin,
      iAmBanned,
      admins: moderation?.admins ?? [],
      bannedAddresses: [...bannedSet],
      bannedBy: moderation?.bannedBy ?? {},
      bannedReason: bannedReasonMerged,
      reports: moderation?.reports ?? [],
      genesis: moderation?.genesis,
      moderateDelete,
      moderateBan,
      moderateUnban,
      moderateAdmin,
      reportContent,
    }),
    [
      ready,
      account,
      settings,
      progress,
      visibleMessages,
      chatOpen,
      setChatOpen,
      chatOpenedAt,
      chatSyncedAt,
      level,
      xp,
      watched,
      signUp,
      signIn,
      signOut,
      updateSettings,
      saveProgress,
      toggleCompleted,
      removeProgress,
      getProgress,
      postMessage,
      resetProgress,
      library,
      inLibrary,
      toggleLibrary,
      removeFromLibrary,
      dismissed,
      dismiss,
      restore,
      updateAccount,
      visibleComments,
      likedComments,
      postComment,
      toggleCommentLike,
      authOpen,
      openAuth,
      closeAuth,
      chainNotice,
      mergeRemoteMessages,
      mergeRemoteComments,
      users,
      mergeUsers,
      moderationReady,
      isAdmin,
      iAmBanned,
      moderation,
      bannedSet,
      bannedReasonMerged,
      moderateDelete,
      moderateBan,
      moderateUnban,
      moderateAdmin,
      reportContent,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
};

export const useStore = () => {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
};
