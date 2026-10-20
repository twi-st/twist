import { splitLinks, splitMentions } from '../lib/links';

/** Renders message/comment text with link and @mention highlighting. */
export const RichText = ({ text }: { text: string }) => (
  <>
    {splitLinks(text).map((part, index) =>
      part.href ? (
        <a
          key={index}
          href={part.href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-twist-redlight underline decoration-twist-redlight/40 underline-offset-2 transition duration-200 hover:decoration-twist-redlight"
        >
          {part.text}
        </a>
      ) : (
        splitMentions(part.text).map((piece, pieceIndex) =>
          piece.mention ? (
            <span
              key={`${index}-${pieceIndex}`}
              className="rounded bg-twist-red/15 px-1 font-bold text-twist-redlight"
            >
              {piece.text}
            </span>
          ) : (
            <span key={`${index}-${pieceIndex}`}>{piece.text}</span>
          )
        )
      )
    )}
  </>
);
