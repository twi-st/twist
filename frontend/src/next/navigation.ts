import { useNavigate, useParams as useRouteParams } from 'react-router-dom';

/** next/navigation shim backed by React Router. */
export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href, { replace: true }),
    back: () => navigate(-1),
  };
}

export function useParams<T extends Record<string, string | undefined>>(): T {
  return useRouteParams() as T;
}
