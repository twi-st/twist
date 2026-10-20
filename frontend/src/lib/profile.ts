/**
 * Profile customisation data: anime-style avatars, profile-card backgrounds
 * and badge rules.
 *
 * Avatars come from DiceBear's keyless API (`lorelei` style) and are picked
 * by seed, so every username maps to a stable avatar even without an account.
 */
export const AVATAR_SEEDS = [
  'hoshino', 'akari', 'ren', 'yuki', 'kaito', 'sakura', 'haru', 'mio',
  'sora', 'rin', 'kaede', 'tsuki', 'izumi', 'aoi', 'kenji', 'nami',
  'hikari', 'rei', 'yuzu', 'kaze', 'momo', 'tora', 'shiro', 'kohaku',
];

const AVATAR_BACKGROUNDS = 'b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf';

export const avatarUrl = (seed: string) =>
  `https://api.dicebear.com/9.x/lorelei/svg?seed=${encodeURIComponent(
    seed
  )}&backgroundColor=${AVATAR_BACKGROUNDS}`;

const hash = (value: string) => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
};

/** Stable avatar seed for usernames without a stored choice. */
export const avatarSeedFor = (username: string) =>
  AVATAR_SEEDS[hash(username) % AVATAR_SEEDS.length];

/** Stored avatar choice, falling back to the deterministic seed. */
export const avatarSeed = (username: string, avatar?: string) =>
  avatar && AVATAR_SEEDS.includes(avatar) ? avatar : avatarSeedFor(username);

export type CardPreset = { id: string; label: string; style: string };

export const CARD_PRESETS: CardPreset[] = [
  { id: 'slate', label: 'Slate', style: 'linear-gradient(135deg, #3a3d45 0%, #1d1f22 100%)' },
  { id: 'crimson', label: 'Crimson', style: 'linear-gradient(135deg, #7f2420 0%, #1d1f22 100%)' },
  { id: 'sakura', label: 'Sakura', style: 'linear-gradient(135deg, #831843 0%, #1d1f22 100%)' },
  { id: 'violet', label: 'Violet', style: 'linear-gradient(135deg, #4c1d95 0%, #1d1f22 100%)' },
  { id: 'ocean', label: 'Ocean', style: 'linear-gradient(135deg, #0c4a6e 0%, #1d1f22 100%)' },
  { id: 'forest', label: 'Forest', style: 'linear-gradient(135deg, #14532d 0%, #1d1f22 100%)' },
  { id: 'ember', label: 'Ember', style: 'linear-gradient(135deg, #78350f 0%, #1d1f22 100%)' },
  { id: 'midnight', label: 'Midnight', style: 'linear-gradient(135deg, #1e1b4b 0%, #0f1116 100%)' },
];

export const cardPreset = (id?: string) =>
  CARD_PRESETS.find((preset) => preset.id === id) ?? CARD_PRESETS[0];

export type ProfileBadge = {
  id: string;
  label: string;
  icon: string;
  description: string;
  requirement: string;
  /** Tailwind gradient for the badge tile (written literally so it compiles). */
  gradient: string;
  /** 0..1 progress towards earning the badge. */
  progress: number;
  progressText: string;
  earned: boolean;
};

export type BadgeScope = 'full' | 'chat';

/** Badges are earned from the stats available for the user. */
export const badgesFor = ({
  level,
  xp,
  messages,
  watched,
  scope = 'full',
}: {
  level: number;
  xp: number;
  messages: number;
  watched: number;
  scope?: BadgeScope;
}): ProfileBadge[] => {
  const ratio = (value: number, target: number) => Math.min(1, value / target);

  const badges: ProfileBadge[] = [
    {
      id: 'newcomer',
      label: 'Newcomer',
      icon: '🌱',
      description: 'Joined the conversation for the first time.',
      requirement: 'Post your first chat message',
      gradient: 'from-emerald-400/40 to-teal-600/20',
      progress: ratio(messages, 1),
      progressText: `${Math.min(messages, 1)} / 1 messages`,
      earned: messages >= 1,
    },
    {
      id: 'chatterbox',
      label: 'Chatterbox',
      icon: '💬',
      description: 'Never short of something to say in the chat.',
      requirement: 'Post 25 chat messages',
      gradient: 'from-sky-400/40 to-blue-600/20',
      progress: ratio(messages, 25),
      progressText: `${Math.min(messages, 25)} / 25 messages`,
      earned: messages >= 25,
    },
    {
      id: 'legend',
      label: 'Chat Legend',
      icon: '📢',
      description: 'A cornerstone of every chat thread on the site.',
      requirement: 'Post 100 chat messages',
      gradient: 'from-orange-400/40 to-red-600/20',
      progress: ratio(messages, 100),
      progressText: `${Math.min(messages, 100)} / 100 messages`,
      earned: messages >= 100,
    },
    {
      id: 'veteran',
      label: 'Veteran',
      icon: '⭐',
      description: 'A long-time member with serious mileage on the site.',
      requirement: 'Reach level 25',
      gradient: 'from-amber-400/40 to-orange-600/20',
      progress: ratio(level, 25),
      progressText: `${Math.min(level, 25)} / 25 levels`,
      earned: level >= 25,
    },
    {
      id: 'elite',
      label: 'Elite',
      icon: '👑',
      description: 'Top of the ladder — few make it this far.',
      requirement: 'Reach level 50',
      gradient: 'from-fuchsia-400/40 to-purple-700/30',
      progress: ratio(level, 50),
      progressText: `${Math.min(level, 50)} / 50 levels`,
      earned: level >= 50,
    },
  ];

  if (scope === 'full') {
    badges.push(
      {
        id: 'binge',
        label: 'Binge Watcher',
        icon: '📺',
        description: 'Comfortably clears a full cour in a night.',
        requirement: 'Watch 20 episodes',
        gradient: 'from-violet-400/40 to-purple-600/20',
        progress: ratio(watched, 20),
        progressText: `${Math.min(watched, 20)} / 20 episodes`,
        earned: watched >= 20,
      },
      {
        id: 'completionist',
        label: 'Completionist',
        icon: '🏅',
        description: 'Finishes what they start — every single time.',
        requirement: 'Watch 100 episodes',
        gradient: 'from-amber-300/50 to-yellow-600/25',
        progress: ratio(watched, 100),
        progressText: `${Math.min(watched, 100)} / 100 episodes`,
        earned: watched >= 100,
      },
      {
        id: 'dedicated',
        label: 'Dedicated',
        icon: '🔥',
        description: 'Has given the site real hours of their life.',
        requirement: 'Earn 1000 XP',
        gradient: 'from-rose-400/40 to-red-700/20',
        progress: ratio(xp, 1000),
        progressText: `${Math.min(xp, 1000)} / 1000 XP`,
        earned: xp >= 1000,
      }
    );
  }

  return badges.sort(
    (a, b) => Number(b.earned) - Number(a.earned) || b.progress - a.progress
  );
};

export const earnedBadges = (badges: ProfileBadge[]) =>
  badges.filter((badge) => badge.earned);
