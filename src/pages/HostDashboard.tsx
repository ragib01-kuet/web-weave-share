import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { formatDuration, formatBytes } from '@/lib/mock-data';
import { generateSessionCode, generateAnonymousId, createSession, endSession, addPeer, removePeer as dbRemovePeer, proxyFetch } from '@/lib/session-manager';
import { hostFetchUrl } from '@/lib/host-proxy';
import { SignalingService } from '@/lib/signaling';
import { WebRTCManager, type PeerConnectionState } from '@/lib/webrtc';
import Metric from '@/components/Metric';
import LiveIndicator from '@/components/LiveIndicator';
import NodeTypeBadge from '@/components/NodeTypeBadge';
import NetworkTopology, { type TopologyNode, type TopologyLink } from '@/components/NetworkTopology';

interface PeerDisplay {
  id: string;
  ip: string;
  connectedAt: number;
  downlink: number;
  uplink: number;
  totalData: number;
  status: 'active' | 'idle' | 'throttled';
  nodeType: 'relay' | 'client';
  /** If this peer is connected through a relay, the relay's peerId */
  connectedVia?: string;
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

  const signalingRef = useRef<SignalingService | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  /** Set of peer IDs that have been promoted to relay */
  const relayPeersRef = useRef<Set<string>>(new Set());
  /** Map of client → relay assignment */
  const relayAssignmentsRef = useRef<Map<string, string>>(new Map());

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
      status: p.state === 'connected' ? 'active' : 'idle',
      nodeType: relayPeersRef.current.has(p.peerId) ? 'relay' : 'client',
      connectedVia: relayAssignmentsRef.current.get(p.peerId),
    }));
    setPeers(displayPeers);
  }, []);

  const handleProxyRequest = useCallback(async (peerId: string, requestId: string, url: string) => {
    try {
      // PRIMARY: Use host's own browser fetch
      console.log(`[HOST] Fetching via host internet: ${url}`);
      const result = await hostFetchUrl(url);
      webrtcRef.current?.sendProxyResponse(peerId, requestId, result.body, result.status, result.contentType);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Proxy failed';

      // FALLBACK: If CORS blocks direct fetch, use edge function
      if (errorMsg.startsWith('CORS_BLOCKED:')) {
        console.log(`[HOST] CORS blocked, falling back to edge proxy for: ${url}`);
        try {
          const fallback = await proxyFetch(url);
          webrtcRef.current?.sendProxyResponse(peerId, requestId, fallback.body, fallback.status, fallback.contentType);
          return;
        } catch (fallbackErr) {
          const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : 'Fallback proxy failed';
          webrtcRef.current?.sendProxyResponse(peerId, requestId, JSON.stringify({ error: fbMsg }), 500, 'application/json');
          return;
        }
      }

      webrtcRef.current?.sendProxyResponse(peerId, requestId, JSON.stringify({ error: errorMsg }), 500, 'application/json');
    }
  }, []);

  /**
   * Promote a directly-connected peer to relay status.
   * After promotion, new joiners may be routed through this relay.
   */
  const promotePeerToRelay = useCallback((peerId: string) => {
    if (relayPeersRef.current.has(peerId)) return;
    relayPeersRef.current.add(peerId);
    console.log(`[HOST] Promoting ${peerId} to relay`);

    // Tell the peer it's now a relay
    signalingRef.current?.send({
      type: 'relay-promote',
      to: peerId,
      payload: {},
    });

    // Update UI
    const webrtc = webrtcRef.current;
    if (webrtc) updatePeersFromWebRTC(webrtc.getPeers());
  }, [updatePeersFromWebRTC]);

  /**
   * Get an available relay for a new joiner (round-robin)
   */
  const getAvailableRelay = useCallback((): string | null => {
    const relays = Array.from(relayPeersRef.current);
    if (relays.length === 0) return null;

    // Find relay with fewest assigned clients
    const assignmentCounts = new Map<string, number>();
    for (const relay of relays) assignmentCounts.set(relay, 0);
    for (const [, relay] of relayAssignmentsRef.current) {
      assignmentCounts.set(relay, (assignmentCounts.get(relay) || 0) + 1);
    }

    // Pick relay with fewest clients (max 3 per relay)
    let best: string | null = null;
    let bestCount = Infinity;
    for (const [relay, count] of assignmentCounts) {
      if (count < 3 && count < bestCount) {
        best = relay;
        bestCount = count;
      }
    }
    return best;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        const session = await createSession(hostId, sessionCode);
        if (cancelled) return;
        setSessionId(session.id);

        const signaling = new SignalingService(sessionCode, hostId, (msg) => {
          if (msg.type === 'peer-joined') {
            addPeer(session.id, msg.from).catch(console.error);

            // Check if we should route this peer through a relay
            const relayId = getAvailableRelay();
            if (relayId) {
              console.log(`[HOST] Routing ${msg.from} through relay ${relayId}`);
              relayAssignmentsRef.current.set(msg.from, relayId);

              // Tell the new client to connect through the relay
              signaling.send({
                type: 'relay-assign',
                to: msg.from,
                payload: { relayId },
              });

              // Tell the relay to expect the new client
              signaling.send({
                type: 'relay-incoming',
                to: relayId,
                payload: { clientId: msg.from },
              });

              return; // Don't let WebRTC handle this directly
            }
          }

          // Pass all other signals to WebRTC
          webrtcRef.current?.handleSignal(msg);
        });
        signalingRef.current = signaling;

        const webrtc = new WebRTCManager(signaling, hostId, true, updatePeersFromWebRTC, handleProxyRequest);
        webrtcRef.current = webrtc;

        signaling.connect();
        setBroadcasting(true);
        setInitializing(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to initialize');
          setInitializing(false);
        }
      }
    };
    init();
    return () => { cancelled = true; };
  }, [hostId, sessionCode, updatePeersFromWebRTC, handleProxyRequest, getAvailableRelay]);

  // Auto-promote first connected peer to relay after 8 seconds of being connected
  useEffect(() => {
    if (!broadcasting) return;
    const interval = setInterval(() => {
      const webrtc = webrtcRef.current;
      if (!webrtc) return;

      const connectedPeers = Array.from(webrtc.getPeers().values())
        .filter(p => p.state === 'connected' && p.direction === 'downstream');

      for (const peer of connectedPeers) {
        if (!relayPeersRef.current.has(peer.peerId) && Date.now() - peer.connectedAt > 8000) {
          promotePeerToRelay(peer.peerId);
          break; // Promote one at a time
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [broadcasting, promotePeerToRelay]);

  useEffect(() => {
    if (!broadcasting) return;
    const interval = setInterval(() => setUptime(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [broadcasting]);

  useEffect(() => {
    if (!broadcasting) return;
    const interval = setInterval(() => {
      const webrtc = webrtcRef.current;
      if (webrtc) updatePeersFromWebRTC(webrtc.getPeers());
    }, 2000);
    return () => clearInterval(interval);
  }, [broadcasting, updatePeersFromWebRTC]);

  const handleTerminate = useCallback((peerId: string) => {
    webrtcRef.current?.terminatePeer(peerId);
    relayPeersRef.current.delete(peerId);
    relayAssignmentsRef.current.delete(peerId);
    if (sessionId) dbRemovePeer(sessionId, peerId).catch(console.error);
  }, [sessionId]);

  const handleToggleRelay = useCallback((peerId: string) => {
    if (relayPeersRef.current.has(peerId)) {
      relayPeersRef.current.delete(peerId);
      console.log(`[HOST] Demoted ${peerId} from relay`);
    } else {
      promotePeerToRelay(peerId);
    }
    const webrtc = webrtcRef.current;
    if (webrtc) updatePeersFromWebRTC(webrtc.getPeers());
  }, [promotePeerToRelay, updatePeersFromWebRTC]);

  const handleShutdown = useCallback(async () => {
    setBroadcasting(false);
    webrtcRef.current?.disconnectAll();
    signalingRef.current?.disconnect();
    if (sessionId) await endSession(sessionId).catch(console.error);
    setTimeout(() => navigate('/'), 1000);
  }, [sessionId, navigate]);

  // Build topology data — show relay chains
  const topoNodes: TopologyNode[] = [
    { id: hostId, label: 'You (Gateway)', type: 'gateway', status: 'active' },
    ...peers.map(p => ({
      id: p.id,
      label: p.ip,
      type: p.nodeType as 'client' | 'relay',
      status: p.status === 'active' ? 'active' as const : 'connecting' as const,
    })),
  ];

  const topoLinks: TopologyLink[] = peers.map(p => ({
    // If connected via relay, link to relay; otherwise link to host
    source: p.connectedVia || hostId,
    target: p.id,
    bandwidth: p.downlink,
  }));

  if (initializing) {
    return (
      <div className="min-h-screen bg-background grid-bg flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="h-14 w-14 rounded-xl bg-primary signal-glow animate-pulse-glow mx-auto flex items-center justify-center">
            <div className="h-4 w-4 bg-primary-foreground rounded-full" />
          </div>
          <p className="text-sm font-display font-semibold">Initializing Gateway...</p>
          <p className="status-label">Fetching TURN credentials and creating session</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background grid-bg flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-sm font-display font-semibold text-destructive">Initialization Failed</p>
          <p className="status-label">{error}</p>
          <button onClick={() => navigate('/')} className="text-xs font-mono text-primary mechanical-press">
            ← Back to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background grid-bg p-4 md:p-6">
      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 border-b border-border pb-5 gap-4">
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
            <div className="h-3 w-3 rounded-full bg-primary animate-pulse-glow" />
          </div>
          <div>
            <h1 className="text-lg md:text-xl font-display font-bold tracking-tight flex items-center gap-3">
              AetherGrid
              <NodeTypeBadge type="gateway" />
            </h1>
            <div className="flex items-center gap-3 mt-0.5">
              {broadcasting ? (
                <>
                  <LiveIndicator />
                  <span className="status-label">Session: {sessionCode}</span>
                </>
              ) : (
                <span className="status-label text-destructive">Shutting down...</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <Metric label="Uptime" value={formatDuration(uptime * 1000)} />
          <Metric label="Data" value={formatBytes(totalData)} />
          <Metric label="Nodes" value={`${activePeers + 1}`} />
          <Metric label="Relays" value={`${relayPeersRef.current.size}`} />
        </div>
      </header>

      <main className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Network Topology */}
        <section className="lg:col-span-8 bg-card border border-border rounded-md overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-display font-semibold">Network Topology</h2>
            <div className="flex gap-4">
              {['Gateway', 'Relay', 'Client'].map(t => (
                <div key={t} className="flex items-center gap-1.5">
                  <div className={`h-2 w-2 rounded-full ${t === 'Gateway' ? 'bg-primary' : t === 'Relay' ? 'bg-[hsl(280,70%,60%)]' : 'bg-accent'}`} />
                  <span className="text-[10px] text-muted-foreground">{t}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="h-[280px]">
            <NetworkTopology nodes={topoNodes} links={topoLinks} />
          </div>
        </section>

        {/* QR & Session Info */}
        <section className="lg:col-span-4 space-y-5">
          <div className="bg-card border border-border rounded-md p-5">
            <h3 className="text-sm font-display font-semibold mb-4">Invite Peers</h3>
            <div className="flex justify-center mb-4 p-3 bg-background rounded-md">
              <QRCodeSVG
                value={sessionLink}
                size={140}
                bgColor="transparent"
                fgColor="hsl(195, 100%, 50%)"
                level="M"
              />
            </div>
            <div className="bg-background border border-border p-2 rounded-sm mb-3">
              <code className="text-[10px] text-primary break-all block">{sessionLink}</code>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(sessionLink)}
              className="w-full bg-secondary text-secondary-foreground text-xs font-display font-semibold py-2.5 rounded-md mechanical-press border border-border hover:bg-muted transition-colors"
            >
              Copy Invite Link
            </button>
          </div>

          <div className="bg-card border border-border rounded-md p-5">
            <h3 className="text-sm font-display font-semibold mb-3">Session Details</h3>
            <div className="space-y-2.5">
              {[
                ['Session', sessionCode],
                ['Protocol', 'WebRTC / DTLS'],
                ['NAT', 'STUN + TURN'],
                ['Encryption', 'AES-256-GCM'],
                ['Max Nodes', '10'],
                ['Mesh', relayPeersRef.current.size > 0 ? 'Multi-hop' : 'Direct'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="status-label">{k}</span>
                  <span className="text-xs font-mono text-primary">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Connected Peers */}
        <section className="lg:col-span-12 space-y-3">
          <h2 className="text-sm font-display font-semibold">Connected Nodes ({peers.length})</h2>
          <AnimatePresence>
            {peers.map(peer => (
              <motion.div
                key={peer.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20, height: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              >
                <div className="bg-card border border-border rounded-md p-4 flex items-center justify-between group">
                  <div className="flex items-center gap-4">
                    <div className={`h-2.5 w-2.5 rounded-full ${peer.status === 'active' ? 'bg-accent mesh-glow' : 'bg-muted-foreground'}`} />
                    <div>
                      <div className="text-sm font-mono tracking-tight flex items-center gap-2">
                        {peer.ip}
                        {peer.connectedVia && (
                          <span className="text-[9px] text-muted-foreground">
                            via {peer.connectedVia.slice(0, 8)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <NodeTypeBadge type={peer.nodeType} />
                        <span className="status-label">— {formatDuration(Date.now() - peer.connectedAt)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-6 items-center">
                    <div className="text-right min-w-[60px]">
                      <div className="text-xs font-mono tabular">{peer.downlink.toFixed(1)} Mb/s</div>
                      <div className="status-label">Down</div>
                    </div>
                    <div className="text-right min-w-[60px]">
                      <div className="text-xs font-mono tabular">{peer.uplink.toFixed(1)} Mb/s</div>
                      <div className="status-label">Up</div>
                    </div>
                    <div className="text-right min-w-[50px]">
                      <div className="text-xs font-mono tabular">{peer.totalData.toFixed(1)} MB</div>
                      <div className="status-label">Total</div>
                    </div>
                    {peer.status === 'active' && !peer.connectedVia && (
                      <button
                        onClick={() => handleToggleRelay(peer.id)}
                        className={`text-[10px] font-mono mechanical-press transition-colors ${
                          peer.nodeType === 'relay'
                            ? 'text-[hsl(280,70%,60%)]'
                            : 'text-muted-foreground hover:text-primary'
                        }`}
                      >
                        {peer.nodeType === 'relay' ? '⬡ RELAY' : '⬡ Promote'}
                      </button>
                    )}
                    <button
                      onClick={() => handleTerminate(peer.id)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-xs font-mono text-destructive mechanical-press"
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {peers.length === 0 && (
            <div className="bg-card border border-border rounded-md p-10 text-center">
              <p className="text-sm text-muted-foreground mb-1">Waiting for peers to join...</p>
              <p className="status-label">Share the invite link or QR code</p>
            </div>
          )}
        </section>

        {/* Shutdown */}
        <section className="lg:col-span-12">
          <button
            onClick={handleShutdown}
            className="w-full max-w-xs bg-destructive/10 border border-destructive/30 text-destructive text-xs font-display font-semibold py-3 rounded-md mechanical-press hover:bg-destructive/20 transition-colors"
          >
            Shutdown Gateway
          </button>
        </section>
      </main>
    </div>
  );
};

export default HostDashboard;
