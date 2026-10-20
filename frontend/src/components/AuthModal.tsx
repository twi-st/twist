import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { isUsernameClaimed } from '../lib/chain';
import { usernameProblem } from '../lib/wallet';

const FIELD =
  'w-full rounded bg-twist-800 p-3 text-sm text-gray-100 placeholder-twist-lightgray focus:outline-none focus:border-twist-red border border-transparent transition duration-200 disabled:opacity-60';

/** Pause after the last keystroke before a username is checked online. */
const CHECK_DEBOUNCE_MS = 600;

type NameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'error';

/**
 * Sign-in / sign-up modal.
 *
 * Accounts are brain wallets: the password is turned into an Ethereum-style
 * key pair locally (Argon2id → HKDF). Nothing is sent anywhere; the password
 * itself is never stored — see `lib/identity.ts` for the session design.
 *
 * Username availability is checked as soon as the field is left (or after a
 * short typing pause, so the disabled button cannot trap a click) and the
 * sign-up button stays disabled until the name comes back clean.
 */
export const AuthModal = () => {
  const { authOpen, closeAuth, signIn, signUp, account } = useStore();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameStatus, setNameStatus] = useState<NameStatus>('idle');
  const [nameNote, setNameNote] = useState<string | null>(null);
  const checkToken = useRef(0);
  /** Latest field value — readable from async callbacks. */
  const usernameRef = useRef('');
  /** Last name confirmed available (or the sign-up pre-check would deny). */
  const verifiedName = useRef<string | null>(null);

  // Close as soon as an account exists (covers sign-up auto-login too).
  useEffect(() => {
    if (account) closeAuth();
  }, [account, closeAuth]);

  useEffect(() => {
    if (!authOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) closeAuth();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [authOpen, closeAuth, busy]);

  const checkUsername = async (): Promise<boolean> => {
    if (mode !== 'signup') return true;

    const normalized = usernameRef.current.trim().toLowerCase();
    if (!normalized) {
      setNameStatus('idle');
      setNameNote(null);
      return false;
    }

    const formatProblem = usernameProblem(normalized);
    if (formatProblem) {
      setNameStatus('idle');
      setNameNote(formatProblem);
      return false;
    }

    const token = ++checkToken.current;
    setNameStatus('checking');
    setNameNote(null);

    const current = () => usernameRef.current.trim().toLowerCase() === normalized;

    try {
      const claimed = await isUsernameClaimed(normalized);
      if (checkToken.current !== token || !current()) return false;

      setNameStatus(claimed ? 'taken' : 'available');
      setNameNote(claimed ? 'That username is already taken.' : null);
      if (!claimed) verifiedName.current = normalized;
      return !claimed;
    } catch {
      if (checkToken.current !== token || !current()) return false;
      setNameStatus('error');
      setNameNote('Could not check that username right now.');
      return false;
    }
  };

  // Debounced check while typing: the button can enable without a blur, so
  // clicking the (disabled) sign-up button is no longer a dead end.
  useEffect(() => {
    if (!authOpen || mode !== 'signup') return;

    const normalized = username.trim().toLowerCase();
    if (!normalized || usernameProblem(normalized)) return;
    if (verifiedName.current === normalized) return;

    const timer = window.setTimeout(() => void checkUsername(), CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authOpen, mode, username]);

  if (!authOpen) return null;

  const onUsernameChange = (value: string) => {
    setUsername(value);
    usernameRef.current = value;
    setError(null);

    const normalized = value.trim().toLowerCase();
    if (verifiedName.current === normalized) {
      setNameStatus('available');
      setNameNote(null);
    } else {
      setNameStatus('idle');
      setNameNote(null);
    }
  };

  const nameReady = mode === 'signin' || nameStatus === 'available';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (mode === 'signup') {
      if (password !== confirm) {
        setError('Passwords do not match.');
        return;
      }

      // The button waits for a clean name; Enter can still submit, so make
      // sure the check ran (and passed) before minting anything.
      setBusy(true);
      if (!nameReady) {
        const ok = await checkUsername();
        setBusy(false);
        if (!ok) return;
      }
    }

    setBusy(true);
    try {
      const problem =
        mode === 'signup' ? await signUp(username, password) : await signIn(username, password);

      if (problem) {
        setError(problem);
        if (problem === 'That username is already taken.') {
          setNameStatus('taken');
          setNameNote(problem);
        }
        return;
      }

      setPassword('');
      setConfirm('');
      closeAuth();
    } catch {
      setError(
        mode === 'signup'
          ? 'Could not create your account — try again.'
          : 'Could not log you in — try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  const statusMark =
    nameStatus === 'checking' ? (
      <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-twist-gray/40 border-t-twist-lightgray" />
    ) : nameStatus === 'available' ? (
      <span className="font-body text-sm text-emerald-400">✓</span>
    ) : nameStatus === 'taken' || nameStatus === 'error' ? (
      <span className="font-body text-sm text-twist-redlight">✕</span>
    ) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'signup' ? 'Sign up' : 'Sign in'}
      onClick={() => {
        if (!busy) closeAuth();
      }}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-twist-700 bg-twist-900 p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between">
          <div className="flex flex-col">
            <span className="font-body text-lg text-gray-100">
              {mode === 'signup' ? 'Create an account' : 'Welcome back'}
            </span>
            <span className="mt-1 font-body text-xs leading-relaxed text-twist-lightgray">
              {mode === 'signup'
                ? 'Your username and password are the only keys to your account — choose them carefully.'
                : 'Sign in to chat, keep your progress and customise your profile.'}
            </span>
          </div>
          <button
            onClick={closeAuth}
            disabled={busy}
            aria-label="Close"
            className="focus:outline-none cursor-default flex h-8 w-8 shrink-0 items-center justify-center rounded bg-twist-800 border border-transparent transition duration-200 hover:border-twist-gray disabled:opacity-40"
          >
            <span className="font-body text-gray-300">✕</span>
          </button>
        </div>

        <form onSubmit={submit} className="mt-5 flex flex-col">
          <div className="relative">
            <input
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              onBlur={() => void checkUsername()}
              placeholder="Username"
              aria-label="Username"
              autoComplete="username"
              disabled={busy}
              className={`${FIELD} ${mode === 'signup' ? 'pr-10' : ''}`}
            />
            {mode === 'signup' && (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                {statusMark}
              </span>
            )}
          </div>

          {mode === 'signup' &&
            (nameNote !== null || nameStatus === 'checking' || nameStatus === 'available') && (
              <span
                className={`mt-1.5 flex items-center gap-2 font-body text-[11px] ${
                  nameStatus === 'available' ? 'text-emerald-400' : 'text-twist-redlight'
                }`}
              >
                <span>
                  {nameStatus === 'checking'
                    ? 'Checking availability…'
                    : nameStatus === 'available'
                      ? 'Username is available'
                      : nameNote}
                </span>
                {nameStatus === 'error' && (
                  <button
                    type="button"
                    onClick={() => void checkUsername()}
                    className="font-bold underline transition duration-200 hover:text-gray-200"
                  >
                    Retry
                  </button>
                )}
              </span>
            )}

          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            disabled={busy}
            className={`${FIELD} mt-3`}
          />

          {mode === 'signup' && (
            <>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Confirm password"
                aria-label="Confirm password"
                autoComplete="new-password"
                disabled={busy}
                className={`${FIELD} mt-3`}
              />
              <span className="mt-2 font-body text-[11px] leading-relaxed text-twist-lightgray">
                8+ characters with an uppercase letter, a lowercase letter, a number and
                a special character. There is no password reset — write it down.
              </span>
            </>
          )}

          {error && (
            <span className="mt-2 font-body text-xs text-twist-redlight">{error}</span>
          )}

          <button
            type="submit"
            disabled={busy || !nameReady}
            className="focus:outline-none cursor-default mt-4 flex h-10 items-center justify-center rounded bg-twist-red border border-transparent transition duration-300 hover:bg-twist-reddark disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-twist-red"
          >
            <span className="font-body text-sm text-gray-100">
              {busy
                ? mode === 'signup'
                  ? 'Creating account…'
                  : 'Logging in…'
                : mode === 'signup'
                  ? 'Sign up'
                  : 'Sign in'}
            </span>
          </button>
        </form>

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setMode(mode === 'signup' ? 'signin' : 'signup');
            setError(null);
            setNameStatus('idle');
            setNameNote(null);
          }}
          className="focus:outline-none cursor-default mt-4 w-full text-center font-body text-xs text-twist-red transition duration-200 hover:text-twist-redlight disabled:opacity-40"
        >
          {mode === 'signup'
            ? 'Already have an account? Sign in'
            : "Don't have an account? Sign up"}
        </button>
      </div>
    </div>
  );
};
