import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { formatDuration, formatBytes } from '@/lib/mock-data';
import { generateSessionCode, generateAnonymousId, createSession, endSession, addPeer, removePeer as dbRemovePeer, proxyFetch } from '@/lib/session-manager';
import { SignalingService } from '@/lib/signaling';
import { WebRTCManager, type PeerConnectionState } from '@/lib/webrtc';
import Metric from '@/components/Metric';
import LiveIndicator from '@/components/LiveIndicator';

interface PeerDisplay {
  id: string;
  ip: string;
  connectedAt: number;
  downlink: number;
  uplink: number;
  totalData: number;
  status: 'active' | 'idle' | 'throttled';
  bandwidthCap: number;
}

const HostDashboard = () => {
  const navigate = useNavigate();
  const [sessionCode] = useState(generateSessionCode);
  const [hostId] = useState(generateAnonymousId);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [peers, setPeers] = useState<PeerDisplay[]>([]);
  const [uptime, setUptime] = useState(0);
  const [broadcasting, setBroadcasting] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [peerCount, setPeerCount] = useState(0);

  const signalingRef = useRef<SignalingService | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);

  const sessionLink = `${window.location.origin}/client/${sessionCode}`;
  const totalData = peers.reduce((s, p) => s + p.totalData, 0);
  const activePeers = peers.filter(p => p.status === 'active').length;

  const updatePeersFromWebRTC = useCallback((peerMap: Map<string, PeerConnectionState>) => {
    const displayPeers: PeerDisplay[] = Array.from(peerMap.values()).map(p => ({
      id: p.peerId,
      ip: p.peerId.slice(0, 12),
      connectedAt: p.connectedAt,
      downlink: p.downlink,
      uplink: p.uplink,
      totalData: p.totalData / (1024 * 1024),
      status: p.state === 'connected' ? 'active' : p.state === 'connecting' ? 'idle' : 'idle',
      bandwidthCap: 0,
    }));
    setPeers(displayPeers);
    setPeerCount(displayPeers.length);
  }, []);

  const handleProxyRequest = useCallback(async (peerId: string, requestId: string, url: string) => {
    try {
      console.log(`[HOST] Proxying: ${url} for peer ${peerId.slice(0, 8)}`);
      const result = await proxyFetch(url);
      webrtcRef.current?.sendProxyResponse(peerId, requestId, result.body, result.status, result.contentType);
      console.log(`[HOST] Proxy response sent: ${result.body.length} bytes`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Proxy failed';
      console.error(`[HOST] Proxy error:`, errorMsg);
      webrtcRef.current?.sendProxyResponse(peerId, requestId, JSON.stringify({ error: errorMsg }), 500, 'application/json');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const session = await createSession(hostId, sessionCode);
        if (cancelled) return;
        setSessionId(session.id);

        const signaling = new SignalingService(sessionCode, hostId, (msg) => {
          console.log(`[HOST] Signal received: ${msg.type} from ${msg.from.slice(0, 8)}`);
          webrtcRef.current?.handleSignal(msg);

          if (msg.type === 'peer-joined') {
            addPeer(session.id, msg.from).catch(console.error);
          }
        });
        signalingRef.current = signaling;

        const webrtc = new WebRTCManager(signaling, hostId, true, updatePeersFromWebRTC, handleProxyRequest);
        webrtcRef.current = webrtc;

        signaling.connect();
        setBroadcasting(true);
        setInitializing(false);
        console.log(`[HOST] Session ${sessionCode} created and broadcasting`);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to initialize');
          setInitializing(false);
        }
      }
    };

    init();
    return () => { cancelled = true; };
  }, [hostId, sessionCode, updatePeersFromWebRTC, handleProxyRequest]);

  useEffect(() => {
    if (!broadcasting) return;
    const interval = setInterval(() => setUptime(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [broadcasting]);

  // Refresh peer display periodically for bandwidth updates
  useEffect(() => {
    if (!broadcasting) return;
    const interval = setInterval(() => {
      const webrtc = webrtcRef.current;
      if (webrtc) {
        updatePeersFromWebRTC(webrtc.getPeers());
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [broadcasting, updatePeersFromWebRTC]);

  const handleTerminate = useCallback((peerId: string) => {
    webrtcRef.current?.terminatePeer(peerId);
    if (sessionId) {
      dbRemovePeer(sessionId, peerId).catch(console.error);
    }
  }, [sessionId]);

  const handleShutdown = useCallback(async () => {
    setBroadcasting(false);
    webrtcRef.current?.disconnectAll();
    signalingRef.current?.disconnect();
    if (sessionId) {
      await endSession(sessionId).catch(console.error);
    }
    setTimeout(() => navigate('/'), 1000);
  }, [sessionId, navigate]);

  if (initializing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="h-12 w-12 rounded-full bg-primary signal-glow animate-pulse-glow mx-auto" />
          <p className="text-sm font-mono">INITIALIZING_NODE...</p>
          <p className="status-label">Creating session and fetching TURN credentials</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-sm font-mono text-destructive">INITIALIZATION_FAILED</p>
          <p className="status-label">{error}</p>
          <button onClick={() => navigate('/')} className="text-xs font-mono text-primary mechanical-press">
            RETURN_HOME
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 md:p-8">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 border-b border-border pb-6 gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-[-0.04em] font-mono">
            AETHER_GATEWAY_v1.0
          </h1>
          <div className="flex items-center gap-3 mt-1">
            {broadcasting ? (
              <>
                <LiveIndicator />
                <span className="status-label">Broadcasting — {sessionCode}</span>
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

      <main className="grid grid-cols-1 lg:grid-cols-12 gap-6">
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
                <div className="bg-card border border-border p-4 flex items-center justify-between group">
                  <div className="flex items-center gap-4">
                    <div className={`h-2 w-2 rounded-full ${peer.status === 'active' ? 'bg-accent mesh-glow' : 'bg-muted-foreground'}`} />
                    <div>
                      <div className="text-sm font-mono tracking-tight">{peer.ip}</div>
                      <div className="status-label">
                        {peer.status === 'active' ? 'Connected' : 'Connecting'} — {formatDuration(Date.now() - peer.connectedAt)}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-6 items-center">
                    <div className="text-right min-w-[60px]">
                      <div className="text-xs font-mono tabular">{peer.downlink.toFixed(1)} Mb/s</div>
                      <div className="status-label">Downlink</div>
                    </div>
                    <div className="text-right min-w-[60px]">
                      <div className="text-xs font-mono tabular">{peer.uplink.toFixed(1)} Mb/s</div>
                      <div className="status-label">Uplink</div>
                    </div>
                    <div className="text-right min-w-[50px]">
                      <div className="text-xs font-mono tabular">{peer.totalData.toFixed(1)} MB</div>
                      <div className="status-label">Total</div>
                    </div>
                    <button
                      onClick={() => handleTerminate(peer.id)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-xs font-mono text-destructive mechanical-press tracking-wide"
                    >
                      TERMINATE_
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {peers.length === 0 && (
            <div className="bg-card border border-border p-12 text-center">
              <div className="status-label mb-2">Waiting for peers...</div>
              <p className="text-sm text-muted-foreground">Share the session link or scan the QR code from another device</p>
            </div>
          )}
        </section>

        <section className="lg:col-span-4 space-y-6">
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

          <div className="bg-card border border-border p-6">
            <h3 className="text-sm font-bold mb-4 font-mono tracking-tight">Session</h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="status-label">Session ID</span>
                <span className="text-xs font-mono text-primary">{sessionCode}</span>
              </div>
              <div className="flex justify-between">
                <span className="status-label">Protocol</span>
                <span className="text-xs font-mono">WebRTC / DTLS</span>
              </div>
              <div className="flex justify-between">
                <span className="status-label">NAT Traversal</span>
                <span className="text-xs font-mono text-accent">STUN + TURN</span>
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
