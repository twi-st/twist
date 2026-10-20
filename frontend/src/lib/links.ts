/**
 * Chat link policy.
 *
 * Messages may only carry links from the domains below. Anything else is
 * rejected while typing — the composer disables Send and explains why — and
 * checked again when the message is posted, so a disallowed link can never
 * reach the store.
 */
export const ALLOWED_LINK_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'giphy.com',
  'tenor.com',
  'imgur.com',
  'myanimelist.net',
  'anilist.co',
  'crunchyroll.com',
];

const LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()"'`]+/i;

const linksIn = (text: string) => text.match(new RegExp(LINK_PATTERN.source, 'gi')) ?? [];

const hostOf = (link: string) => {
  try {
    return new URL(link.startsWith('www.') ? `https://${link}` : link).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export const isAllowedHost = (host: string) =>
  ALLOWED_LINK_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));

/** Distinct hosts in `text` that are not on the allowlist. */
export const blockedHosts = (text: string) => {
  const blocked = new Set<string>();
  for (const link of linksIn(text)) {
    const host = hostOf(link);
    if (host && !isAllowedHost(host)) blocked.add(host);
  }
  return [...blocked];
};

export type MessagePart = { text: string; href?: string };

const MENTION_SOURCE = /(^|[^\w])@([\w]+)/g.source;

/** Splits a message body into plain text and link parts for rendering. */
export const splitLinks = (text: string): MessagePart[] => {
  const parts: MessagePart[] = [];
  const pattern = new RegExp(LINK_PATTERN.source, 'gi');
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    const link = match[0];
    parts.push({ text: link, href: link.startsWith('www.') ? `https://${link}` : link });
    last = match.index + link.length;
  }

  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
};

export type MentionPart = { text: string; mention?: boolean };

/** Splits text into plain pieces and `@name` mention tokens. */
export const splitMentions = (text: string): MentionPart[] => {
  const parts: MentionPart[] = [];
  const pattern = new RegExp(MENTION_SOURCE, 'g');
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const prefix = match[1];
    const name = match[2];
    const start = match.index + prefix.length;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: `@${name}`, mention: true });
    last = start + name.length + 1;
  }

  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
};
