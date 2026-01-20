const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface SystemStatus {
  isRunning: boolean;
  symbols: string[];
  activePositions: number;
  currentRegime: any;
}

/**
 * Start the trading system
 */
export async function startSystem(): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_URL}/api/system/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to start system');
  }

  return response.json();
}

/**
 * Stop the trading system
 */
export async function stopSystem(): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_URL}/api/system/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to stop system');
  }

  return response.json();
}

/**
 * Get system status
 */
export async function getSystemStatus(): Promise<SystemStatus> {
  const response = await fetch(`${API_URL}/api/system/status`, {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error('Failed to fetch system status');
  }

  const data = await response.json();
  return data.data;
}
