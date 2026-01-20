'use client';

import { useEffect } from 'react';
import { socketClient } from '@/lib/websocket/socket';

export function useWebSocket() {
  useEffect(() => {
    socketClient.connect();

    return () => {
      // Don't disconnect on unmount, keep connection alive
    };
  }, []);

  const subscribe = (event: string, callback: Function) => {
    socketClient.on(event, callback);
  };

  const unsubscribe = (event: string, callback: Function) => {
    socketClient.off(event, callback);
  };

  return { subscribe, unsubscribe };
}
