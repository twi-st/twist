import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import emojiData from '@emoji-mart/data';

/* Deferred to the client: emoji-mart's picker extends HTMLElement. */
const Picker = dynamic(() => import('@emoji-mart/react'), { ssr: false });

/*
 * emoji-mart does not officially support React 19 yet; if it ever fails to
 * render, show a note instead of taking the whole app down.
 */
class PickerBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="p-4 font-body text-xs text-twist-lightgray">
          Emoji picker failed to load.
        </p>
      );
    }

    return this.props.children;
  }
}

/** Small emoji button with a popover picker; used by chat and comments. */
export const EmojiPickerButton = ({
  onSelect,
  disabled,
}: {
  onSelect: (emoji: string) => void;
  disabled?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside clicks and Escape.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        disabled={disabled}
        aria-label="Insert emoji"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded text-base leading-none transition duration-150 hover:bg-twist-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        🙂
      </button>

      {open && (
        <div className="chat-emoji absolute bottom-full right-0 z-30 mb-2 flex justify-center overflow-hidden rounded-lg border border-twist-700 bg-twist-900 shadow-xl">
          <PickerBoundary>
            <Picker
              data={emojiData}
              theme="dark"
              perLine={7}
              emojiSize={20}
              emojiButtonSize={32}
              previewPosition="none"
              skinTonePosition="search"
              navPosition="top"
              onEmojiSelect={(emoji: { native: string }) => onSelect(emoji.native)}
            />
          </PickerBoundary>
        </div>
      )}
    </div>
  );
};
