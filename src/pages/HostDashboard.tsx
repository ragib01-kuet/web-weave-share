import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { mockPeers, generateSessionId, formatDuration, formatBytes, type Peer } from '@/lib/mock-data';
import PeerCard from '@/components/PeerCard';
import Metric from '@/components/Metric';
import LiveIndicator from '@/components/LiveIndicator';

const HostDashboard = () => {
  const navigate = useNavigate();
  const [sessionId] = useState(generateSessionId);
  const [peers, setPeers] = useState<Peer[]>(mockPeers);
  const [uptime, setUptime] = useState(0);
  const [broadcasting, setBroadcasting] = useState(true);

  const sessionLink = `${window.location.origin}/client/${sessionId}`;
  const totalData = peers.reduce((s, p) => s + p.totalData, 0);
  const activePeers = peers.filter(p => p.status === 'active').length;

  useEffect(() => {
    const interval = setInterval(() => setUptime(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Simulate fluctuating bandwidth
  useEffect(() => {
    const interval = setInterval(() => {
      setPeers(prev =>
        prev.map(p => ({
          ...p,
          downlink: Math.max(0, p.downlink + (Math.random() - 0.5) * 0.4),
          uplink: Math.max(0, p.uplink + (Math.random() - 0.5) * 0.1),
          totalData: p.totalData + p.downlink * 0.1,
        }))
      );
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleTerminate = (id: string) => {
    setPeers(prev => prev.filter(p => p.id !== id));
  };

  const handleShutdown = () => {
    setBroadcasting(false);
    setTimeout(() => navigate('/'), 1500);
  };

  return (
    <div className="min-h-screen bg-background p-6 md:p-8">
      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 border-b border-border pb-6 gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-[-0.04em] font-mono">
            AETHER_GATEWAY_v1.0
          </h1>
          <div className="flex items-center gap-3 mt-1">
            {broadcasting ? (
              <>
                <LiveIndicator />
                <span className="status-label">Broadcasting</span>
              </>
            ) : (
              <span className="status-label text-destructive">Shutting down...</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-6">
          <Metric label="Uptime" value={formatDuration(uptime * 1000)} />
          <Metric label="Total Data" value={formatBytes(totalData)} />
          <Metric label="Peers" value={`${activePeers}/${peers.length}`} />
          <div className="h-10 w-10 rounded-full bg-primary signal-glow flex items-center justify-center">
            <div className="h-3 w-3 bg-primary-foreground rounded-full animate-pulse-glow" />
          </div>
        </div>
      </header>

      {/* Main Grid */}
      <main className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Peer List */}
        <section className="lg:col-span-8 space-y-3">
          <h2 className="status-label mb-4">Connected Peers ({peers.length})</h2>
          <AnimatePresence>
            {peers.map(peer => (
              <motion.div
                key={peer.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20, height: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              >
                <PeerCard peer={peer} onTerminate={handleTerminate} />
              </motion.div>
            ))}
          </AnimatePresence>

          {peers.length === 0 && (
            <div className="bg-card border border-border p-12 text-center">
              <div className="status-label mb-2">No peers connected</div>
              <p className="text-sm text-muted-foreground">Share the session link to invite clients</p>
            </div>
          )}
        </section>

        {/* Sidebar Controls */}
        <section className="lg:col-span-4 space-y-6">
          {/* QR / Session Link */}
          <div className="bg-card border border-border p-6">
            <h3 className="text-sm font-bold mb-4 font-mono tracking-tight">Access Control</h3>
            <div className="flex justify-center mb-4">
              <QRCodeSVG
                value={sessionLink}
                size={160}
                bgColor="transparent"
                fgColor="hsl(220, 80%, 55%)"
                level="M"
              />
            </div>
            <div className="bg-background border border-border p-2 mb-3">
              <code className="text-[10px] text-primary break-all block">{sessionLink}</code>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(sessionLink)}
              className="w-full bg-secondary text-secondary-foreground text-xs font-mono py-2 mechanical-press border border-border hover:bg-muted transition-colors"
            >
              COPY_LINK
            </button>
          </div>

          {/* Session Info */}
          <div className="bg-card border border-border p-6">
            <h3 className="text-sm font-bold mb-4 font-mono tracking-tight">Session</h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="status-label">Session ID</span>
                <span className="text-xs font-mono text-primary">{sessionId}</span>
              </div>
              <div className="flex justify-between">
                <span className="status-label">Protocol</span>
                <span className="text-xs font-mono">WebRTC / DTLS</span>
              </div>
              <div className="flex justify-between">
                <span className="status-label">Encryption</span>
                <span className="text-xs font-mono text-accent">AES-256-GCM</span>
              </div>
              <div className="flex justify-between">
                <span className="status-label">Max Peers</span>
                <span className="text-xs font-mono">10</span>
              </div>
            </div>
          </div>

          {/* Shutdown */}
          <button
            onClick={handleShutdown}
            className="w-full bg-destructive/10 border border-destructive/30 text-destructive text-xs font-mono py-3 mechanical-press hover:bg-destructive/20 transition-colors"
          >
            SHUTDOWN_GATEWAY
          </button>
        </section>
      </main>
    </div>
  );
};

export default HostDashboard;
