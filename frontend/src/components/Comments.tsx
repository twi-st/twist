import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type Comment } from '../lib/store';
import { ALLOWED_LINK_DOMAINS, blockedHosts } from '../lib/links';
import { syncComments } from '../lib/chain';
import { avatarSeed, avatarUrl } from '../lib/profile';
import { RichText } from './RichText';
import { EmojiPickerButton } from './EmojiPicker';

type DisplayComment = Comment & { likes: number };
type Quote = { username: string; body: string };

const timeAgo = (at: number) => {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const QuoteBlock = ({ quote }: { quote: Quote }) => (
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
      {quote.username}
    </span>
    <span className="min-w-0 flex-1 truncate font-body text-[11px] text-twist-lightgray">
      {quote.body}
    </span>
  </div>
);

const CommentItem = ({
  comment,
  displayLevel,
  avatarSrc,
  likes,
  liked,
  quote,
  replyActive,
  canDelete,
  onToggleLike,
  onReply,
  onDelete,
}: {
  comment: DisplayComment;
  displayLevel?: number;
  avatarSrc: string;
  likes: number;
  liked: boolean;
  quote?: Quote;
  replyActive: boolean;
  canDelete?: boolean;
  onToggleLike: () => void;
  onReply: () => void;
  onDelete?: () => void;
}) => (
  <div className="flex gap-2.5">
    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-twist-700 bg-twist-800">
      <img
        src={avatarSrc}
        alt={comment.username}
        loading="lazy"
        className="h-full w-full object-cover"
      />
    </span>

    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="truncate font-body text-sm font-bold text-gray-100">
          {comment.username}
        </span>
        {displayLevel !== undefined && (
          <span className="shrink-0 rounded bg-twist-red px-1 text-[9px] font-bold leading-4 text-white">
            {displayLevel}
          </span>
        )}
        <span className="shrink-0 font-body text-[10px] text-twist-lightgray">
          {timeAgo(comment.at)}
        </span>
      </div>

      {quote && <QuoteBlock quote={quote} />}

      <p className="mt-0.5 wrap-break-word font-body text-sm leading-relaxed text-gray-300">
        <RichText text={comment.body} />
      </p>

      <div className="mt-1.5 flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleLike}
          aria-pressed={liked}
          aria-label="Like"
          className={`flex h-6 items-center gap-1 rounded-full px-2 transition duration-150 ${
            liked
              ? 'bg-twist-red/15 text-twist-red'
              : 'text-twist-lightgray hover:bg-twist-800 hover:text-gray-200'
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill={liked ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
            />
          </svg>
          <span className="font-body text-[11px] tabular-nums">{likes}</span>
        </button>

        <button
          type="button"
          onClick={onReply}
          aria-pressed={replyActive}
          className={`flex h-6 items-center rounded-full px-2 font-body text-[11px] transition duration-150 ${
            replyActive
              ? 'bg-twist-red/15 text-twist-red'
              : 'text-twist-lightgray hover:bg-twist-800 hover:text-gray-200'
          }`}
        >
          {replyActive ? 'Cancel' : 'Reply'}
        </button>

        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete comment"
            className="flex h-6 w-6 items-center justify-center rounded-full text-twist-lightgray transition duration-150 hover:bg-twist-800 hover:text-twist-redlight"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
            </svg>
          </button>
        )}
      </div>
    </div>
  </div>
);

const InlineReply = ({
  username,
  quote,
  value,
  onChange,
  onEmoji,
  onSubmit,
  onCancel,
  canSubmit,
  blocked,
  inputRef,
}: {
  username: string;
  quote?: Quote;
  value: string;
  onChange: (value: string) => void;
  onEmoji: (emoji: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
  canSubmit: boolean;
  blocked: string[];
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) => (
  <div className="ml-9 mt-3 border-l border-twist-800 pl-4">
    <form onSubmit={onSubmit}>
      {quote && <QuoteBlock quote={quote} />}

      <div className="relative">
        <textarea
          ref={inputRef}
          autoFocus
          rows={2}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={`Reply to ${username}…`}
          aria-label={`Reply to ${username}`}
          className="w-full resize-none rounded bg-twist-800 p-3 pr-12 text-sm text-gray-100 placeholder-twist-lightgray focus:outline-none focus:border-twist-red border border-transparent transition duration-200"
        />
        <span className="absolute right-2 top-2">
          <EmojiPickerButton onSelect={onEmoji} />
        </span>
      </div>

      {blocked.length > 0 && (
        <p className="mt-2 font-body text-[11px] leading-relaxed text-twist-redlight">
          Links from {blocked.join(', ')} aren&apos;t allowed here. Allowed:{' '}
          {ALLOWED_LINK_DOMAINS.join(', ')}.
        </p>
      )}

      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="focus:outline-none flex h-8 items-center rounded bg-twist-800 px-3 border border-transparent transition duration-200 hover:border-twist-gray"
        >
          <span className="font-body text-xs text-gray-300">Cancel</span>
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="focus:outline-none flex h-8 items-center rounded bg-twist-red px-3 border border-transparent transition duration-300 hover:bg-twist-reddark disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-twist-red"
        >
          <span className="font-body text-xs text-gray-100">Reply</span>
        </button>
      </div>
    </form>
  </div>
);

/** Episode comments: two levels, inline replies, likes, text + emoji. */
export const Comments = ({ slug, episode }: { slug: string; episode: number }) => {
  const {
    account,
    level,
    ready,
    comments,
    likedComments,
    postComment,
    toggleCommentLike,
    openAuth,
    mergeRemoteComments,
    isAdmin,
    iAmBanned,
    moderateDelete,
    users,
  } = useStore();

  const [draft, setDraft] = useState('');
  const [replyTarget, setReplyTarget] = useState<{
    rootId: string;
    targetId: string;
  } | null>(null);
  const [replyDraft, setReplyDraft] = useState('');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);

  // Pull verified comments for this episode from Irys (once per view).
  useEffect(() => {
    if (!ready) return;
    let active = true;

    const known = new Set(comments.map((comment) => comment.id));
    syncComments(slug, episode, known)
      .then((remote) => {
        if (active && remote.length > 0) mergeRemoteComments(remote);
      })
      .catch(() => {
        /* offline — local comments only */
      });

    return () => {
      active = false;
    };
  }, [ready, slug, episode, mergeRemoteComments]);

  const all = useMemo<DisplayComment[]>(
    () =>
      comments
        .filter((comment) => comment.slug === slug && comment.episode === episode)
        .map((comment) => ({
          ...comment,
          // The published profile name wins over the name frozen into the
          // document; authors with neither show as "anon", never an address.
          username:
            (comment.address ? users[comment.address.toLowerCase()]?.username : undefined) ||
            comment.username ||
            'anon',
          likes: 0,
        })),
    [comments, slug, episode, users]
  );

  const byId = useMemo(
    () => new Map<string, DisplayComment>(all.map((comment) => [comment.id, comment])),
    [all]
  );

  const roots = useMemo(
    () =>
      all
        .filter((comment) => !comment.parentId)
        .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)),
    [all]
  );

  const repliesOf = (rootId: string) =>
    all
      .filter((comment) => comment.parentId === rootId)
      .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

  const quoteFor = (comment: DisplayComment): Quote | undefined => {
    if (!comment.replyToId) return undefined;
    const target = byId.get(comment.replyToId);
    return target ? { username: target.username, body: target.body } : undefined;
  };

  const levelOf = (comment: DisplayComment) => {
    if (
      account?.address &&
      comment.address?.toLowerCase() === account.address.toLowerCase()
    ) {
      return level;
    }
    const key = comment.address?.toLowerCase();
    return key ? users[key]?.level : undefined;
  };

  const avatarFor = (comment: DisplayComment) =>
    avatarUrl(
      avatarSeed(
        comment.username,
        comment.address ? users[comment.address.toLowerCase()]?.avatar : undefined
      )
    );

  const likesOf = (comment: DisplayComment) =>
    comment.likes + (likedComments.includes(comment.id) ? 1 : 0);

  const addText = (
    target: HTMLTextAreaElement | null,
    current: string,
    setValue: (next: string) => void,
    text: string
  ) => {
    if (!target) {
      setValue(current + text);
      return;
    }

    const start = target.selectionStart ?? current.length;
    const end = target.selectionEnd ?? start;
    setValue(current.slice(0, start) + text + current.slice(end));

    requestAnimationFrame(() => {
      target.focus();
      const position = start + text.length;
      target.setSelectionRange(position, position);
    });
  };

  const blocked = blockedHosts(draft);
  const canPost =
    Boolean(account) && !iAmBanned && draft.trim().length > 0 && blocked.length === 0;

  const replyBlocked = blockedHosts(replyDraft);
  const canReply =
    Boolean(account) && replyDraft.trim().length > 0 && replyBlocked.length === 0;

  const startReply = (comment: DisplayComment, rootId: string) => {
    if (!account) {
      openAuth();
      return;
    }

    if (replyTarget?.targetId === comment.id) {
      setReplyTarget(null);
      return;
    }

    setReplyTarget({ rootId, targetId: comment.id });
    setReplyDraft('');
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!account) {
      openAuth();
      return;
    }
    if (!canPost) return;

    const posted = postComment({ slug, episode, body: draft });
    if (posted) setDraft('');
  };

  const submitReply = (event: React.FormEvent) => {
    event.preventDefault();
    if (!account || !replyTarget) return;
    if (!canReply) return;

    const posted = postComment({
      slug,
      episode,
      parentId: replyTarget.rootId,
      replyToId: replyTarget.targetId,
      body: replyDraft,
    });

    if (posted) {
      setReplyDraft('');
      setReplyTarget(null);
    }
  };

  if (!ready) return null;

  return (
    <div className="mt-8 border-t border-twist-800 pt-5">
      <span className="font-body text-xs font-bold uppercase tracking-wide text-twist-red">
        Comments ({all.length})
      </span>

      {/* Top-level composer */}
      <form onSubmit={submit} className="mt-3">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!account || iAmBanned}
            rows={2}
            placeholder={
              iAmBanned
                ? 'Banned — posting disabled'
                : account
                  ? 'Add a comment…'
                  : 'Sign in to comment'
            }
            aria-label="Comment"
            className="w-full resize-none rounded bg-twist-800 p-3 pr-12 text-sm text-gray-100 placeholder-twist-lightgray focus:outline-none focus:border-twist-red border border-transparent transition duration-200 disabled:opacity-60"
          />
          <span className="absolute right-2 top-2">
            <EmojiPickerButton
              onSelect={(emoji) => addText(inputRef.current, draft, setDraft, emoji)}
              disabled={!account}
            />
          </span>
        </div>

        {blocked.length > 0 && (
          <p className="mt-2 font-body text-[11px] leading-relaxed text-twist-redlight">
            Links from {blocked.join(', ')} aren&apos;t allowed here. Allowed:{' '}
            {ALLOWED_LINK_DOMAINS.join(', ')}.
          </p>
        )}

        <div className="mt-2 flex items-center justify-between">
          <span className="font-body text-[10px] text-twist-lightgray">
            {account
              ? `Commenting as ${account.username}`
              : 'Sign in to join the discussion.'}
          </span>
          <button
            type="submit"
            disabled={!canPost}
            className="focus:outline-none flex h-8 items-center rounded bg-twist-red px-3 border border-transparent transition duration-300 hover:bg-twist-reddark disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-twist-red"
          >
            <span className="font-body text-xs text-gray-100">Comment</span>
          </button>
        </div>
      </form>

      {roots.length === 0 ? (
        <p className="mt-6 text-center font-body text-xs text-twist-lightgray">
          No comments yet — be the first.
        </p>
      ) : (
        <div className="mt-5 flex flex-col gap-5">
          {roots.map((root) => {
            const replies = repliesOf(root.id);
            const replyingToRoot =
              replyTarget?.rootId === root.id && replyTarget.targetId === root.id;
            const replyingToReply =
              replyTarget?.rootId === root.id && replyTarget.targetId !== root.id;
            const endTarget = replyingToReply ? byId.get(replyTarget.targetId) : undefined;

            return (
              <div key={root.id}>
                <CommentItem
                  comment={root}
                  displayLevel={levelOf(root)}
                  avatarSrc={avatarFor(root)}
                  likes={likesOf(root)}
                  liked={likedComments.includes(root.id)}
                  replyActive={replyingToRoot}
                  canDelete={isAdmin && Boolean(root.address)}
                  onDelete={() => moderateDelete(root.id)}
                  onToggleLike={() =>
                    account ? toggleCommentLike(root.id) : openAuth()
                  }
                  onReply={() => startReply(root, root.id)}
                />

                {/* Replying to the level-1 comment: input sits right under it. */}
                {replyingToRoot && (
                  <InlineReply
                    username={root.username}
                    value={replyDraft}
                    onChange={setReplyDraft}
                    onEmoji={(emoji) =>
                      addText(replyInputRef.current, replyDraft, setReplyDraft, emoji)
                    }
                    onSubmit={submitReply}
                    onCancel={() => setReplyTarget(null)}
                    canSubmit={canReply}
                    blocked={replyBlocked}
                    inputRef={replyInputRef}
                  />
                )}

                {replies.length > 0 && (
                  <div className="ml-9 mt-3 flex flex-col gap-4 border-l border-twist-800 pl-4">
                    {replies.map((reply) => (
                      <CommentItem
                        key={reply.id}
                        comment={reply}
                        displayLevel={levelOf(reply)}
                        avatarSrc={avatarFor(reply)}
                        likes={likesOf(reply)}
                        liked={likedComments.includes(reply.id)}
                        quote={quoteFor(reply)}
                        replyActive={replyTarget?.targetId === reply.id}
                        canDelete={isAdmin && Boolean(reply.address)}
                        onDelete={() => moderateDelete(reply.id)}
                        onToggleLike={() =>
                          account ? toggleCommentLike(reply.id) : openAuth()
                        }
                        onReply={() => startReply(reply, root.id)}
                      />
                    ))}
                  </div>
                )}

                {/* Replying to a reply: input goes to the very end, still under level 1. */}
                {replyingToReply && (
                  <InlineReply
                    username={endTarget?.username ?? root.username}
                    quote={
                      endTarget
                        ? { username: endTarget.username, body: endTarget.body }
                        : undefined
                    }
                    value={replyDraft}
                    onChange={setReplyDraft}
                    onEmoji={(emoji) =>
                      addText(replyInputRef.current, replyDraft, setReplyDraft, emoji)
                    }
                    onSubmit={submitReply}
                    onCancel={() => setReplyTarget(null)}
                    canSubmit={canReply}
                    blocked={replyBlocked}
                    inputRef={replyInputRef}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
