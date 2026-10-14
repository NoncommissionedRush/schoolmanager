import { cn } from "cn";
import { Fragment } from "react";

const URL_PATTERN = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])/g;

/** Splits plain text into text and `http(s)` link parts. */
export function linkify(text: string): { text: string; href?: string }[] {
  return text
    .split(URL_PATTERN)
    .filter((part) => part !== "")
    .map((part) =>
      /^https?:\/\//.test(part) ? { text: part, href: part } : { text: part },
    );
}

/**
 * Plain text as typed by a teacher (lessons.md §5.2): line breaks kept, URLs
 * turned into links. No markup is ever interpreted.
 */
export function LinkifiedText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <p className={cn("break-words whitespace-pre-wrap", className)}>
      {linkify(text).map((part, i) =>
        part.href ? (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-primary underline underline-offset-2"
          >
            {part.text}
          </a>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </p>
  );
}
