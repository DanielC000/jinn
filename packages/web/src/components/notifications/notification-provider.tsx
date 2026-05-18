
import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useGateway } from "@/hooks/use-gateway";
import {
  type AppNotification,
  loadNotifications,
  saveNotifications,
  generateId,
  wsEventToNotification,
} from "@/lib/notifications";
import { NotificationContext } from "@/hooks/use-notifications";

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const initialized = useRef(false);

  // Load from localStorage on mount
  useEffect(() => {
    setNotifications(loadNotifications());
  }, []);

  // Persist whenever notifications change (skip initial empty state)
  useEffect(() => {
    if (initialized.current) {
      saveNotifications(notifications);
    } else if (notifications.length > 0) {
      initialized.current = true;
    }
  }, [notifications]);

  const addNotification = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      const template = wsEventToNotification(event, payload);
      if (!template) return;

      const notif: AppNotification = {
        ...template,
        id: generateId(),
        timestamp: Date.now(),
        read: false,
      };

      // Add to persistent notifications
      setNotifications((prev) => [notif, ...prev].slice(0, 50));
      initialized.current = true;

    },
    [],
  );

  // Subscribe to WebSocket events via the shared GatewayProvider — no new socket.
  const addNotificationRef = useRef(addNotification);
  addNotificationRef.current = addNotification;
  const { subscribe } = useGateway();

  useEffect(() => {
    return subscribe((event, payload) => {
      addNotificationRef.current(event, payload as Record<string, unknown>);
    });
  }, [subscribe]);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => {
      const updated = prev.map((n) => (n.read ? n : { ...n, read: true }));
      saveNotifications(updated);
      return updated;
    });
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => {
      const updated = prev.map((n) => (n.id === id ? { ...n, read: true } : n));
      saveNotifications(updated);
      return updated;
    });
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    saveNotifications([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        pushFromEvent: addNotification,
        markAllRead,
        markRead,
        clearAll,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
