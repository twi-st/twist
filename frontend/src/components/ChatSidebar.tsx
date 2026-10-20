import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useStore, type Message } from '../lib/store';
import { ALLOWED_LINK_DOMAINS, blockedHosts } from '../lib/links';
import { searchGifs, type Gif } from '../lib/gifApi';
import { avatarSeed, avatarUrl } from '../lib/profile';
import { ProfileCard } from './ProfileCard';
import { RichText } from './RichText';
import { EmojiPickerButton } from './EmojiPicker';

const CHAT_WIDTH_KEY = 'twist:chat-width';
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 260;
const MAX_WIDTH = 520;
const SNAP_RANGE = 24;
const GIF_DEBOUNCE_MS = 1500;

const LevelBadge = ({ level }: { level: number }) => (
  <span className="ml-1 shrink-0 rounded bg-twist-red px-1 text-[10px] font-bold leading-4 text-white align-middle">
    {level}
  </span>
);

const FIELD =
  'w-full rounded bg-twist-800 p-3 text-sm text-gray-100 placeholder-twist-lightgray focus:outline-none focus:border-twist-red border border-transparent transition duration-200';

const CloseIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

export const ChatSidebar = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const {
    account,
    messages,
    postMessage,
    level,
    xp,
    ready,
    openAuth,
    chainNotice,
    iAmBanned,
    isAdmin,
    moderateDelete,
    reportContent,
    users,
    chatOpenedAt,
    chatSyncedAt,
  } = useStore();
  const [draft, setDraft] = useState('');
  const [reportFor, setReportFor] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gifInputRef = useRef<HTMLInputElement>(null);

  const [reply, setReply] = useState<{ id: string; username: string; body: string } | null>(
    null
  );
  const [hoverCard, setHoverCard] = useState<{
    username: string;
    address: string;
    top: number;
    left: number;
    above: boolean;
  } | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [gifOpen, setGifOpen] = useState(false);
  const [gifQuery, setGifQuery] = useState('');
  const [gifResults, setGifResults] = useState<Gif[]>([]);
  const [gifLoading, setGifLoading] = useState(false);

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const widthRef = useRef(DEFAULT_WIDTH);

  const readOnly = !account;
  const blocked = blockedHosts(draft);
  // Messages on screen are from the cache until the sync that runs when the
  // panel opens comes back — they pulse until then.
  const stale = chatSyncedAt < chatOpenedAt;

  // Restore the saved chat width.
  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem(CHAT_WIDTH_KEY));
      if (stored) {
        const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, stored));
        setWidth(clamped);
        widthRef.current = clamped;
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  // The resizable width only applies on large screens; below `lg` the panel
  // is the slide-in drawer and its classes govern the size. Inline styles are
  // used on purpose so a stale stylesheet can never collapse the layout.
  useEffect(() => {
    const query = window.matchMedia('(min-width: 64rem)');
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, open, gifOpen]);

  // GIF search: the bundled set shows instantly for an empty query, typed
  // queries run 1.5s after typing stops.
  useEffect(() => {
    if (!gifOpen) return;
    let active = true;

    if (!gifQuery.trim()) {
      setGifLoading(false);
      searchGifs('').then((results) => {
        if (active) setGifResults(results);
      });
      return () => {
        active = false;
      };
    }

    setGifLoading(true);
    const id = window.setTimeout(() => {
      searchGifs(gifQuery).then((results) => {
        if (!active) return;
        setGifResults(results);
        setGifLoading(false);
      });
    }, GIF_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(id);
    };
  }, [gifOpen, gifQuery]);

  const openGif = (query: string) => {
    setGifOpen(true);
    setGifQuery(query);
    requestAnimationFrame(() => gifInputRef.current?.focus());
  };

  const closeGif = () => {
    setGifOpen(false);
    setGifQuery('');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (readOnly || !text) return;
    if (blocked.length > 0) return;

    postMessage(text, {
      replyTo: reply ? { username: reply.username, body: reply.body } : undefined,
    });
    setDraft('');
    setReply(null);
  };

  const changeDraft = (value: string) => {
    // Typing `/gif` jumps straight into the picker; anything after it becomes
    // the search query (like a Discord slash command).
    if (/^\/gif\b/i.test(value.trimStart())) {
      openGif(value.trimStart().slice(4).trim());
      setDraft('');
      return;
    }

    setDraft(value);
  };

  const pickGif = (gif: Gif) => {
    if (readOnly) return;
    postMessage(gif.title, {
      gif: gif.url,
      replyTo: reply ? { username: reply.username, body: reply.body } : undefined,
    });
    setReply(null);
    closeGif();
  };

  // Enter in the search field sends the first result.
  const submitGifSearch = () => {
    if (readOnly || gifResults.length === 0) return;
    pickGif(gifResults[0]);
  };

  const insertAtCursor = (text: string) => {
    const input = inputRef.current;
    if (!input) {
      setDraft((prev) => prev + text);
      return;
    }

    const start = input.selectionStart ?? draft.length;
    const end = input.selectionEnd ?? start;
    setDraft(draft.slice(0, start) + text + draft.slice(end));

    requestAnimationFrame(() => {
      input.focus();
      const position = start + text.length;
      input.setSelectionRange(position, position);
    });
  };

  const startReply = (message: Message) => {
    if (readOnly) return;
    setReply((prev) =>
      prev?.id === message.id
        ? null
        : {
            id: message.id,
            username: message.username,
            body: message.gif ? 'GIF' : message.body,
          }
    );
  };

  const showProfileCard = (username: string, address: string | undefined, element: HTMLElement) => {
    const aside = asideRef.current;
    if (!aside || !address) return;

    // Only show cards for accounts that actually exist (you, or a published profile).
    const key = address.toLowerCase();
    const known =
      account?.address?.toLowerCase() === key || Boolean(users[key]);
    if (!known) return;

    window.clearTimeout(hideTimer.current);
    const nameRect = element.getBoundingClientRect();
    const asideRect = aside.getBoundingClientRect();
    const top = nameRect.top - asideRect.top;
    const above = top >= 170;

    setHoverCard({
      username,
      address,
      top: above ? top - 6 : top + 26,
      left: Math.max(8, nameRect.left - asideRect.left),
      above,
    });
  };

  const scheduleHideProfileCard = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHoverCard(null), 140);
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      const raw = window.innerWidth - moveEvent.clientX;
      const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw));
      // Snap to the default width when dragging near it.
      const next =
        Math.abs(clamped - DEFAULT_WIDTH) <= SNAP_RANGE ? DEFAULT_WIDTH : clamped;
      widthRef.current = next;
      setWidth(next);
    };

    const onUp = () => {
      setResizing(false);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try {
        localStorage.setItem(CHAT_WIDTH_KEY, String(widthRef.current));
      } catch {
        /* storage unavailable */
      }
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  };

  return (
    <>
      {/* Dimmer behind the drawer on small screens. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/60 transition-opacity duration-300 ease-in-out lg:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      {/*
       * Desktop: a flex column that animates its width (resizable via the
       * drag handle). Small screens: a fixed drawer that slides in from the
       * right. The inner wrapper keeps a fixed width so the content does not
       * reflow mid-animation.
       */}
      <aside
        ref={asideRef}
        aria-label="Chat"
        inert={!open}
        style={
          desktop
            ? {
                width: open ? width : 0,
                maxWidth: 'none',
                transition: resizing ? 'none' : undefined,
              }
            : undefined
        }
        className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-sm shrink-0 flex-col overflow-hidden border-l border-twist-800 bg-twist-900 shadow-2xl transition-[transform,width,opacity] duration-300 ease-in-out lg:relative lg:z-auto lg:max-w-none lg:shadow-none ${
          open
            ? 'translate-x-0 opacity-100 lg:w-80'
            : 'translate-x-full opacity-0 lg:translate-x-0 lg:w-0'
        }`}
      >
        {/* Drag handle to resize the panel (large screens only). */}
        <div
          onPointerDown={startResize}
          aria-hidden="true"
          className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize touch-none transition-colors duration-200 hover:bg-twist-red/40 lg:block"
        />

        {/* Floating profile card while a username is hovered. */}
        {hoverCard && (
          <div
            onMouseEnter={() => window.clearTimeout(hideTimer.current)}
            onMouseLeave={scheduleHideProfileCard}
            style={{
              top: hoverCard.top,
              left: hoverCard.left,
              transform: hoverCard.above ? 'translateY(-100%)' : undefined,
            }}
            className="absolute z-30"
          >
            <ProfileCard
              address={hoverCard.address}
              username={hoverCard.username}
              onNavigate={() => setHoverCard(null)}
            />
          </div>
        )}

        <div
          className="flex h-full w-full flex-col lg:w-80"
          style={desktop ? { width } : undefined}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full text-twist-lightgray transition duration-200 hover:bg-twist-800 hover:text-gray-100 lg:hidden"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {account && (
            <div className="border-b border-twist-800 p-4 pr-12 lg:pr-4">
              <div className="flex flex-col">
                <span className="font-body text-[11px] uppercase tracking-wide text-twist-lightgray">
                  Signed in
                </span>

                <div className="mt-3 flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-twist-700 bg-twist-800">
                    <img
                      src={avatarUrl(avatarSeed(account.username, account.avatar))}
                      alt={account.username}
                      className="h-full w-full object-cover"
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="flex items-center font-body text-sm text-gray-100">
                      <span className="truncate">{account.username}</span>
                      <LevelBadge level={level} />
                    </span>
                    <span className="mt-0.5 block font-body text-[11px] text-twist-lightgray">
                      Level {level} · {xp} XP
                    </span>
                  </div>
                </div>

                <Link
                  href="/profile"
                  className="group mt-3 flex h-9 items-center justify-between rounded bg-twist-800 px-3 border border-transparent transition duration-200 hover:border-twist-gray"
                >
                  <span className="font-body text-xs text-gray-300 transition-colors duration-200 group-hover:text-gray-100">
                    View profile
                  </span>
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                    className="h-3.5 w-3.5 text-twist-lightgray transition duration-200 group-hover:translate-x-0.5 group-hover:text-gray-100"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            </div>
          )}

          {gifOpen ? (
            <div className="main-content flex-1 overflow-y-auto px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="flex h-11 shrink-0 items-center rounded border border-twist-700 bg-twist-800 px-2.5 font-body text-xs text-twist-lightgray">
                  /gif
                </span>
                <input
                  ref={gifInputRef}
                  autoFocus
                  value={gifQuery}
                  onChange={(e) => setGifQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitGifSearch();
                    } else if (e.key === 'Escape') {
                      closeGif();
                    }
                  }}
                  placeholder="Search GIFs"
                  aria-label="Search GIFs"
                  className={`${FIELD} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  onClick={closeGif}
                  aria-label="Close GIF picker"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-twist-lightgray transition duration-200 hover:bg-twist-800 hover:text-gray-100"
                >
                  <CloseIcon />
                </button>
              </div>

              {readOnly && (
                <p className="mt-2 font-body text-[11px] text-twist-lightgray">
                  Login to send GIFs.
                </p>
              )}

              {gifLoading && gifResults.length === 0 ? (
                <p className="mt-6 text-center font-body text-xs text-twist-lightgray">
                  Searching…
                </p>
              ) : gifResults.length === 0 ? (
                <p className="mt-6 text-center font-body text-xs text-twist-lightgray">
                  No GIFs for &ldquo;{gifQuery}&rdquo;.
                </p>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {gifResults.map((gif) => (
                    <button
                      key={gif.id}
                      type="button"
                      onClick={() => pickGif(gif)}
                      disabled={readOnly}
                      title={gif.title}
                      className="overflow-hidden rounded border border-twist-800 bg-twist-800/40 transition duration-200 hover:border-twist-gray disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-twist-800"
                    >
                      <img
                        src={gif.preview}
                        alt={gif.title}
                        loading="lazy"
                        className="h-24 w-full object-contain p-1"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div
              ref={scrollRef}
              className={`main-content flex-1 overflow-y-auto px-4 py-3 transition-opacity duration-300 ${
                stale ? 'animate-pulse opacity-60' : ''
              }`}
            >
              {ready &&
                messages.map((message) => {
                  const authorKey = message.address?.toLowerCase();
                  const authorLevel = authorKey ? users[authorKey]?.level : undefined;
                  const authorName =
                    (authorKey ? users[authorKey]?.username : undefined) ||
                    message.username ||
                    'anon';

                  return (
                  <div
                    key={message.id}
                    onClick={() => startReply(message)}
                    className={`group/message relative mb-3 -mx-2 cursor-pointer rounded px-2 py-1 font-body text-sm transition-colors duration-150 hover:bg-twist-800/40 ${
                      reply?.id === message.id ? 'bg-twist-800/60' : ''
                    }`}
                  >
                    {message.address && account && (
                      <span className="absolute right-0 top-0.5 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100">
                        {!message.mine && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setReportFor(reportFor === message.id ? null : message.id);
                            }}
                            aria-label="Report message"
                            className="flex h-5 w-5 items-center justify-center rounded bg-twist-900/90 text-twist-lightgray transition duration-150 hover:text-gray-100"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v18M6 4h11l-1.5 3.5L17 11H6" />
                            </svg>
                          </button>
                        )}
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              moderateDelete(message.id);
                            }}
                            aria-label="Delete message"
                            className="flex h-5 w-5 items-center justify-center rounded bg-twist-900/90 text-twist-lightgray transition duration-150 hover:text-twist-redlight"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                            </svg>
                          </button>
                        )}
                      </span>
                    )}
                    {message.replyTo && (
                      <div className="mb-1 flex items-center gap-1.5 overflow-hidden rounded bg-twist-800/70 px-2 py-1">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden="true"
                          className="h-3 w-3 shrink-0 text-twist-lightgray"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 14L4 9l5-5" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 9h8a7 7 0 0 1 7 7v3" />
                        </svg>
                        <span className="shrink-0 font-body text-[11px] font-bold text-gray-200">
                          {message.replyTo.username}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-body text-[11px] text-twist-lightgray">
                          {message.replyTo.body}
                        </span>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!readOnly) insertAtCursor(`@${authorName} `);
                      }}
                      onMouseEnter={(event) =>
                        showProfileCard(message.username, message.address, event.currentTarget)
                      }
                      onMouseLeave={scheduleHideProfileCard}
                      className={`-ml-1 rounded px-1 font-bold transition-colors duration-150 ${
                        message.mine
                          ? 'text-twist-redlight hover:bg-twist-redlight/10'
                          : 'text-gray-100 hover:bg-twist-800'
                      }`}
                    >
                      {authorName}
                    </button>
                    {!message.mine && authorLevel !== undefined && (
                      <LevelBadge level={authorLevel} />
                    )}

                    {message.gif ? (
                      <img
                        src={message.gif}
                        alt={message.body || 'GIF'}
                        loading="lazy"
                        className="mt-1 block w-44 rounded border border-twist-800"
                      />
                    ) : (
                      <p
                        className={`mt-0.5 wrap-break-word ${
                          message.mine ? 'text-twist-white' : 'text-gray-300'
                        }`}
                      >
                        <RichText text={message.body} />
                      </p>
                    )}

                    {reportFor === message.id && (
                      <div
                        onClick={(event) => event.stopPropagation()}
                        className="mt-1 flex items-center gap-2 rounded bg-twist-800/70 px-2 py-1"
                      >
                        <span className="font-body text-[11px] text-twist-lightgray">
                          Send this message to the moderators?
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            reportContent(message.id, 'message');
                            setReportFor(null);
                          }}
                          className="font-body text-[11px] font-bold text-twist-redlight transition duration-150 hover:text-twist-red"
                        >
                          Report
                        </button>
                        <button
                          type="button"
                          onClick={() => setReportFor(null)}
                          className="font-body text-[11px] text-twist-lightgray transition duration-150 hover:text-gray-200"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                  );
                })}

              {ready && messages.length === 0 && (
                <p className="mt-6 text-center font-body text-xs text-twist-lightgray">
                  No messages yet — say hi.
                </p>
              )}
            </div>
          )}

          {iAmBanned && (
            <p className="border-t border-twist-800 bg-twist-red/10 px-3 py-2 font-body text-[10px] leading-relaxed text-twist-redlight">
              Your account is banned — you can read the chat but posting is disabled.
            </p>
          )}

          {chainNotice && (
            <p className="border-t border-twist-800 px-3 py-2 font-body text-[10px] leading-relaxed text-twist-redlight">
              {chainNotice}
            </p>
          )}

          <form onSubmit={submit} className="relative border-t border-twist-800 p-3">
            {reply && (
              <div className="mb-2 flex items-center gap-2 rounded border-l-2 border-twist-red bg-twist-800/70 px-2.5 py-1.5">
                <span className="shrink-0 font-body text-[11px] text-twist-lightgray">
                  Replying to
                </span>
                <span className="shrink-0 font-body text-[11px] font-bold text-gray-200">
                  {reply.username}
                </span>
                <span className="min-w-0 flex-1 truncate font-body text-[11px] text-twist-lightgray">
                  {reply.body}
                </span>
                <button
                  type="button"
                  onClick={() => setReply(null)}
                  aria-label="Cancel reply"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-twist-lightgray transition duration-150 hover:bg-twist-700 hover:text-gray-100"
                >
                  <CloseIcon />
                </button>
              </div>
            )}

            <div className="relative">
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => changeDraft(e.target.value)}
                disabled={readOnly || iAmBanned}
                placeholder={
                  iAmBanned
                    ? 'Banned — posting disabled'
                    : readOnly
                      ? 'Login to chat'
                      : 'Message or type /gif'
                }
                aria-label={readOnly ? 'Login to chat' : 'Message'}
                className={`${FIELD} w-full ${readOnly ? 'pr-20 disabled:opacity-60' : 'pr-11'}`}
              />

              {readOnly && (
                <button
                  type="button"
                  onClick={openAuth}
                  className="absolute right-1.5 top-1/2 flex h-8 -translate-y-1/2 items-center justify-center rounded bg-twist-red px-2.5 transition duration-200 hover:bg-twist-reddark"
                >
                  <span className="font-body text-xs text-gray-100">Login</span>
                </button>
              )}

              {!readOnly && !iAmBanned && (
                <span className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2">
                  <EmojiPickerButton onSelect={(emoji) => insertAtCursor(emoji)} />
                </span>
              )}
            </div>

            {blocked.length > 0 && (
              <p className="mt-2 font-body text-[11px] leading-relaxed text-twist-redlight">
                Links from {blocked.join(', ')} aren&apos;t allowed here. Allowed:{' '}
                {ALLOWED_LINK_DOMAINS.join(', ')}.
              </p>
            )}
          </form>
        </div>
      </aside>
    </>
  );
};
