/**
 * Phone bet drawer: the vaul bottom sheet wrapping the control panel plus a
 * footer row with the sound toggle the topbar hides at phone width. Owns the
 * DEPOSIT / LAST WIN tab (Figma 358:3271 / 359:4924) and hands it to
 * `children` as a render prop; the tab resets to DEPOSIT on every open.
 * Controlled from App's `drawerOpen` state; closing (swipe, backdrop,
 * Escape, confirmed deploy, own-Position win takeover) is all
 * `onOpenChange(false)` or a parent effect setting the same state.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Drawer } from "vaul";

import { SoundIcon } from "../SoundIcon.js";
import type { PanelTab } from "./ControlPanel.js";

const TABS: { id: PanelTab; label: string }[] = [
  { id: "deposit", label: "Deposit" },
  { id: "lastwin", label: "Last win" },
];

/** Betting session state for the footer (off-chain-tickets ticket 15). */
export type DrawerSession = {
  active: boolean;
  busy: boolean;
  error: string | null;
  onRevoke: () => void;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  soundOn: boolean;
  onToggleSound: () => void;
  session: DrawerSession;
  children: (tab: PanelTab) => ReactNode;
};

export function BetDrawer({
  open,
  onOpenChange,
  soundOn,
  onToggleSound,
  session,
  children,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<PanelTab>("deposit");

  // Reopens on DEPOSIT, scrolled to the top.
  useEffect(() => {
    if (!open) return;
    setTab("deposit");
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [open]);

  const pickTab = (next: PanelTab): void => {
    setTab(next);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay
          className="bet-drawer-overlay"
          data-testid="bet-drawer-overlay"
        />
        <Drawer.Content className="bet-drawer-content" data-testid="bet-drawer">
          <Drawer.Handle className="bet-drawer-handle" />
          <Drawer.Title className="bet-drawer-title">
            Place a position
          </Drawer.Title>
          <Drawer.Description className="bet-drawer-title">
            Amount, tiles, deploy and vault controls
          </Drawer.Description>
          <div className="bet-drawer-tabs" role="tablist">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                className="bet-drawer-tab"
                data-testid={`drawer-tab-${item.id}`}
                aria-selected={tab === item.id}
                onClick={() => pickTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="bet-drawer-body" ref={bodyRef}>
            {children(tab)}
            <div className="bet-drawer-toggles">
              <button
                type="button"
                className="sound-toggle"
                data-testid="drawer-sound-toggle"
                onClick={onToggleSound}
                aria-pressed={soundOn}
                aria-label="Sound"
              >
                <SoundIcon on={soundOn} />
              </button>
              {session.active ? (
                <button
                  type="button"
                  className="session-revoke"
                  data-testid="session-revoke"
                  disabled={session.busy}
                  onClick={session.onRevoke}
                >
                  Revoke session
                </button>
              ) : null}
            </div>
            {session.busy || session.error ? (
              <p
                className={`session-status${session.error ? " err" : ""}`}
                data-testid="session-status"
                role="status"
              >
                {session.busy ? "Confirm the session in your wallet." : session.error}
              </p>
            ) : null}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
