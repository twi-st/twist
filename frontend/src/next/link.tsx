import { Link as RouterLink } from 'react-router-dom';
import type { AnchorHTMLAttributes } from 'react';

type LinkProps = { href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

/** Compatibility shim so components written against next/link stay unchanged. */
export default function Link({ href, ...rest }: LinkProps) {
  return <RouterLink to={href} {...rest} />;
}
