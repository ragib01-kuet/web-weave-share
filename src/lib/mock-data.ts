export interface Peer {
  id: string;
  ip: string;
  connectedAt: number;
  downlink: number; // Mb/s
  uplink: number;
  totalData: number; // MB
  status: 'active' | 'idle' | 'throttled';
  bandwidthCap: number; // Mb/s, 0 = unlimited
}

export const generateSessionId = () => {
  return Array.from({ length: 6 }, () => 
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('');
};

export const mockPeers: Peer[] = [
  { id: 'p1', ip: '192.168.1.42', connectedAt: Date.now() - 720000, downlink: 1.2, uplink: 0.3, totalData: 45.2, status: 'active', bandwidthCap: 5 },
  { id: 'p2', ip: '10.0.0.17', connectedAt: Date.now() - 1440000, downlink: 0.8, uplink: 0.1, totalData: 120.8, status: 'active', bandwidthCap: 0 },
  { id: 'p3', ip: '172.16.0.5', connectedAt: Date.now() - 300000, downlink: 0.0, uplink: 0.0, totalData: 2.1, status: 'idle', bandwidthCap: 2 },
  { id: 'p4', ip: '192.168.1.88', connectedAt: Date.now() - 3600000, downlink: 2.4, uplink: 0.7, totalData: 340.5, status: 'active', bandwidthCap: 3 },
];

export const formatDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

export const formatBytes = (mb: number): string => {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
};
