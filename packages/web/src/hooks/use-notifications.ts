
import { createContext, useContext } from "react";
import { type AppNotification } from "@/lib/notifications";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface NotificationContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  /** Push a new notification from a WS event */
  pushFromEvent: (event: string, payload: Record<string, unknown>) => void;
  /** Mark all as read */
  markAllRead: () => void;
  /** Mark one as read */
  markRead: (id: string) => void;
  /** Clear all history */
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  unreadCount: 0,
  pushFromEvent: () => {},
  markAllRead: () => {},
  markRead: () => {},
  clearAll: () => {},
});

export function useNotifications() {
  return useContext(NotificationContext);
}

// Re-export for use in provider component
export { NotificationContext };

// Re-export types
export type { AppNotification };
