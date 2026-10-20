import { lazy, Suspense, type ComponentType } from 'react';

type Module = { default: ComponentType<never> };

/** next/dynamic replacement; `ssr` is meaningless outside Next and ignored. */
export default function dynamic(loader: () => Promise<Module>, _options?: { ssr?: boolean }) {
  const Lazy = lazy(loader as () => Promise<{ default: ComponentType<Record<string, unknown>> }>);
  return function DynamicComponent(props: Record<string, unknown>) {
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}
