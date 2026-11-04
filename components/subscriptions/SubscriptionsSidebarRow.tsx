"use client";

import { useI18n } from "@/hooks/useI18n";

interface Props {
  active: boolean;
  /** Events recorded since the page was last shown; lights the dot. */
  unread?: number;
  onOpen: () => void;
}

/** The Subscriptions entry under Artifacts: opens the event list. */
export function SubscriptionsSidebarRow({ active, unread = 0, onOpen }: Props) {
  const { t } = useI18n();
  const hasUnread = unread > 0;
  return (
    <button
      type="button"
      className={`sidebar-header-row sidebar-scheduled-row sidebar-subscriptions-row${active ? " is-active" : ""}`}
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={hasUnread ? t("sidebar.subscriptionsUnread", { count: unread }) : t("sidebar.subscriptions")}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 11a9 9 0 0 1 9 9" />
        <path d="M4 4a16 16 0 0 1 16 16" />
        <circle cx="5" cy="19" r="1.5" />
      </svg>
      <span className="sidebar-scheduled-label">{t("sidebar.subscriptions")}</span>
      {hasUnread && (
        <span
          className="sidebar-subscriptions-dot"
          aria-label={t("sidebar.subscriptionsUnread", { count: unread })}
        />
      )}
    </button>
  );
}
