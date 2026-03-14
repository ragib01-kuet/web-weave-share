import { motion } from 'framer-motion';
import type { Peer } from '@/lib/mock-data';
import { formatDuration } from '@/lib/mock-data';
import Sparkline from './Sparkline';

interface PeerCardProps {
  peer: Peer;
  onTerminate: (id: string) => void;
}

const statusColors: Record<string, string> = {
  active: 'bg-accent mesh-glow',
  idle: 'bg-muted-foreground',
  throttled: 'bg-yellow-500',
};

const PeerCard = ({ peer, onTerminate }: PeerCardProps) => {
  const sessionDuration = formatDuration(Date.now() - peer.connectedAt);

  return (
    <motion.div
      whileHover={{ x: 4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="bg-card border border-border p-4 flex items-center justify-between group"
    >
      <div className="flex items-center gap-4">
        <div className={`h-2 w-2 rounded-full ${statusColors[peer.status]}`} />
        <div>
          <div className="text-sm font-mono tracking-tight">{peer.ip}</div>
          <div className="status-label">Session: {sessionDuration}</div>
        </div>
      </div>

      <div className="flex gap-6 items-center">
        <Sparkline baseValue={peer.downlink} />
        <div className="text-right min-w-[60px]">
          <div className="text-xs font-mono tabular">{peer.downlink.toFixed(1)} Mb/s</div>
          <div className="status-label">Downlink</div>
        </div>
        <div className="text-right min-w-[60px]">
          <div className="text-xs font-mono tabular">{peer.uplink.toFixed(1)} Mb/s</div>
          <div className="status-label">Uplink</div>
        </div>
        <div className="text-right min-w-[50px]">
          <div className="text-xs font-mono tabular">{peer.totalData.toFixed(0)} MB</div>
          <div className="status-label">Total</div>
        </div>
        <button
          onClick={() => onTerminate(peer.id)}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-xs font-mono text-destructive mechanical-press tracking-wide"
        >
          TERMINATE_
        </button>
      </div>
    </motion.div>
  );
};

export default PeerCard;
