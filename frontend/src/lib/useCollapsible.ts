import { useStore, type Dismissed } from './store';

/**
 * Banners collapse instead of disappearing: the wrapper keeps its height
 * transition and the header shows a small arrow next to the logo to open it
 * again. The collapsed flag is persisted with the rest of the dismissed state.
 */
export const useCollapsible = (key: keyof Dismissed) => {
  const { ready, dismissed, dismiss, restore } = useStore();

  return {
    /** False until storage has been read, so nothing flashes open. */
    ready,
    collapsed: dismissed[key],
    collapse: () => dismiss(key),
    expand: () => restore(key),
  };
};
