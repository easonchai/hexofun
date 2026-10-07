/**
 * Shared ⓘ tooltip (referral-page spec.md "InfoTip"; Figma tooltip
 * `230:17717`, placed as in `204:15702`): a focusable button whose bubble is
 * linked with `aria-describedby`. Opens on hover, focus or tap; closes on
 * Esc, blur or an outside tap. The bubble stays mounted and toggles
 * `.open` (opacity + pointer-events) instead of unmounting, the same way
 * `.nav-item[data-tip]` does in styles.css, so `aria-describedby` always
 * resolves to a real node. Outside-tap/Escape follow WalletMenu.tsx's
 * pattern.
 */
import { useEffect, useRef, useState } from "react";

type Props = {
  /** Unique per instance: becomes the bubble's id for `aria-describedby`. */
  id: string;
  /** One `<p>` per paragraph (the Figma copy uses a blank line between two). */
  paragraphs: readonly string[];
};

export function InfoTip({ id, paragraphs }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="info-tip" ref={rootRef}>
      <button
        type="button"
        className="info-tip-trigger"
        aria-label="More info"
        aria-describedby={id}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Always opens, never toggles closed: a mouse click fires after
        // onMouseEnter already opened it, so a toggle would immediately flip
        // it shut again. Closing is Esc / blur / an outside tap, below.
        onClick={() => setOpen(true)}
      >
        <InfoGlyph />
      </button>
      <span
        id={id}
        role="tooltip"
        className={`info-tip-bubble${open ? " open" : ""}`}
      >
        {paragraphs.map((text, index) => (
          // Index is fine: paragraphs are a fixed, static list per caller.
          <p key={index}>{text}</p>
        ))}
      </span>
    </span>
  );
}

export function InfoGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.75" stroke="currentColor" strokeWidth="1.1" fill="none" />
      <circle cx="8" cy="4.9" r="0.9" fill="currentColor" />
      <rect x="7.25" y="7" width="1.5" height="5" rx="0.75" fill="currentColor" />
    </svg>
  );
}
