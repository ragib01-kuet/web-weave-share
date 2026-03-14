import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

export interface TopologyNode {
  id: string;
  label: string;
  type: 'gateway' | 'relay' | 'client';
  status: 'active' | 'connecting' | 'idle';
}

export interface TopologyLink {
  source: string;
  target: string;
  bandwidth?: number;
}

interface Props {
  nodes: TopologyNode[];
  links: TopologyLink[];
  className?: string;
}

const nodeColors: Record<string, string> = {
  gateway: 'hsl(195, 100%, 50%)',
  relay: 'hsl(280, 70%, 60%)',
  client: 'hsl(160, 70%, 45%)',
};

const nodeGlows: Record<string, string> = {
  gateway: '0 0 20px hsl(195 100% 50% / 0.5)',
  relay: '0 0 15px hsl(280 70% 60% / 0.4)',
  client: '0 0 12px hsl(160 70% 45% / 0.4)',
};

const NetworkTopology = ({ nodes, links, className = '' }: Props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 400, height: 300 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([e]) => {
      setDimensions({ width: e.contentRect.width, height: e.contentRect.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Layout nodes in concentric circles by type
  const positions = new Map<string, { x: number; y: number }>();
  const cx = dimensions.width / 2;
  const cy = dimensions.height / 2;

  const gateways = nodes.filter(n => n.type === 'gateway');
  const relays = nodes.filter(n => n.type === 'relay');
  const clients = nodes.filter(n => n.type === 'client');

  // Gateway at center
  gateways.forEach((n, i) => {
    const angle = (i / Math.max(gateways.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const r = gateways.length > 1 ? 30 : 0;
    positions.set(n.id, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  });

  // Relays in middle ring
  const relayRadius = Math.min(dimensions.width, dimensions.height) * 0.25;
  relays.forEach((n, i) => {
    const angle = (i / Math.max(relays.length, 1)) * Math.PI * 2 - Math.PI / 2;
    positions.set(n.id, { x: cx + Math.cos(angle) * relayRadius, y: cy + Math.sin(angle) * relayRadius });
  });

  // Clients in outer ring
  const clientRadius = Math.min(dimensions.width, dimensions.height) * 0.4;
  clients.forEach((n, i) => {
    const angle = (i / Math.max(clients.length, 1)) * Math.PI * 2 - Math.PI / 4;
    positions.set(n.id, { x: cx + Math.cos(angle) * clientRadius, y: cy + Math.sin(angle) * clientRadius });
  });

  return (
    <div ref={containerRef} className={`relative w-full h-full min-h-[250px] ${className}`}>
      <svg width={dimensions.width} height={dimensions.height} className="absolute inset-0">
        {/* Grid background circles */}
        {[0.2, 0.35, 0.5].map((r, i) => (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={Math.min(dimensions.width, dimensions.height) * r}
            fill="none"
            stroke="hsl(210 15% 20% / 0.3)"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
        ))}

        {/* Links */}
        {links.map((link, i) => {
          const s = positions.get(link.source);
          const t = positions.get(link.target);
          if (!s || !t) return null;
          return (
            <line
              key={i}
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
              stroke="hsl(195 100% 50% / 0.3)"
              strokeWidth="1.5"
              strokeDasharray="6 4"
              className="animate-dash"
            />
          );
        })}
      </svg>

      {/* Nodes */}
      {nodes.map((node) => {
        const pos = positions.get(node.id);
        if (!pos) return null;
        const color = nodeColors[node.type];
        const size = node.type === 'gateway' ? 20 : node.type === 'relay' ? 14 : 10;

        return (
          <motion.div
            key={node.id}
            initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            className="absolute flex flex-col items-center gap-1"
            style={{
              left: pos.x - size,
              top: pos.y - size,
            }}
          >
            <div
              className={`rounded-full ${node.status === 'active' ? 'animate-pulse-glow' : ''}`}
              style={{
                width: size * 2,
                height: size * 2,
                backgroundColor: color,
                boxShadow: node.status === 'active' ? nodeGlows[node.type] : 'none',
                opacity: node.status === 'connecting' ? 0.5 : 1,
              }}
            />
            <span className="text-[9px] font-mono whitespace-nowrap" style={{ color }}>
              {node.label}
            </span>
          </motion.div>
        );
      })}

      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="status-label">No nodes connected</p>
        </div>
      )}
    </div>
  );
};

export default NetworkTopology;
