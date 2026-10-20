import Link from 'next/link';
import { Shell } from './Shell';

/** Shared loading / not-found panels for the data-backed routes. */
export const RouteLoading = ({ label = 'Loading' }: { label?: string }) => (
  <Shell>
    <div className="content-column mx-auto w-full px-4 py-6">
      <div className="flex flex-col gap-6 sm:flex-row">
        <div className="mx-auto aspect-[3/4] w-40 shrink-0 animate-pulse rounded bg-twist-800 sm:mx-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="h-6 w-2/3 animate-pulse rounded bg-twist-800" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-twist-800" />
          <div className="mt-2 h-3 w-full animate-pulse rounded bg-twist-800" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-twist-800" />
          <div className="h-3 w-4/6 animate-pulse rounded bg-twist-800" />
          <span className="sr-only">{label}</span>
        </div>
      </div>
    </div>
  </Shell>
);

export const RouteNotFound = ({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) => (
  <Shell>
    <div className="content-column mx-auto w-full px-4 py-6">
      <div className="mt-6 rounded-lg border border-twist-800 bg-twist-800/40 p-6 text-center">
        <h1 className="font-body text-lg text-gray-100">{title}</h1>
        <p className="mx-auto mt-2 max-w-sm font-body text-xs leading-relaxed text-twist-lightgray">
          {detail}
        </p>
        <Link
          href="/"
          className="focus:outline-none cursor-default mt-5 inline-flex h-9 items-center rounded border border-transparent bg-twist-800 px-3 font-body text-xs text-gray-300 transition duration-200 hover:border-twist-gray"
        >
          Browse anime
        </Link>
      </div>
    </div>
  </Shell>
);
