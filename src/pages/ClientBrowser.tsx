import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { generateAnonymousId, getSession, addPeer, removePeer as dbRemovePeer, proxyFetch } from '@/lib/session-manager';
import { SignalingService } from '@/lib/signaling';
import { WebRTCManager, type PeerConnectionState } from '@/lib/webrtc';
import Metric from '@/components/Metric';

type ConnectionState = 'resolving' | 'connecting' | 'handshaking' | 'connected' | 'disconnected' | 'error';

const stateLabels: Record<ConnectionState, string> = {
  resolving: 'Looking up session...',
  connecting: 'Connecting to signaling server...',
  handshaking: 'WebRTC handshake in progress (STUN/TURN)...',
  connected: 'Tunnel active. All traffic encrypted via WebRTC.',
  disconnected: 'Disconnected from mesh.',
  error: 'Connection failed.',
};

const ClientBrowser = () => {
  const { sessionId: sessionCode } = useParams();
  const navigate = useNavigate();
  const [clientId] = useState(generateAnonymousId);
  const [state, setState] = useState<ConnectionState>('resolving');
  const [errorMsg, setErrorMsg] = useState('');
  const [url, setUrl] = useState('');
  const [browsedUrl, setBrowsedUrl] = useState('');
  const [pageContent, setPageContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [dataUsed, setDataUsed] = useState(0);
  const [useDirectProxy, setUseDirectProxy] = useState(false);
  const [connectionMode, setConnectionMode] = useState<'webrtc' | 'direct' | ''>('');

  const signalingRef = useRef<SignalingService | null>(null);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const sessionDbId = useRef<string | null>(null);
  const connectedRef = useRef(false);

  const onPeerUpdate = useCallback((peerMap: Map<string, PeerConnectionState>) => {
    const hasConnected = Array.from(peerMap.values()).some(p => p.state === 'connected');
    if (hasConnected && !connectedRef.current) {
      connectedRef.current = true;
      setConnectionMode('webrtc');
      setState('connected');
      console.log('[CLIENT] WebRTC P2P connection established!');
    }
  }, []);

  useEffect(() => {
    if (!sessionCode) return;
    let cancelled = false;

    const init = async () => {
      try {
        setState('resolving');
        const session = await getSession(sessionCode);
        if (cancelled) return;
        sessionDbId.current = session.id;

        await addPeer(session.id, clientId);
        if (cancelled) return;

        setState('connecting');
        const signaling = new SignalingService(sessionCode, clientId, (msg) => {
          webrtcRef.current?.handleSignal(msg);
        });
        signalingRef.current = signaling;

        const webrtc = new WebRTCManager(signaling, clientId, false, onPeerUpdate);
        webrtcRef.current = webrtc;

        signaling.connect();

        // Give signaling channel time to connect, then announce
        setTimeout(() => {
          if (!cancelled && !connectedRef.current) {
            setState('handshaking');
            webrtc.announceJoin();
            
            // Re-announce after 3s in case host missed it
            setTimeout(() => {
              if (!cancelled && !connectedRef.current) {
                console.log('[CLIENT] Re-announcing join...');
                webrtc.announceJoin();
              }
            }, 3000);
          }
        }, 1500);

        // Timeout: fall back to direct proxy after 20s
        setTimeout(() => {
          if (!cancelled && !connectedRef.current) {
            console.log('[CLIENT] WebRTC timeout, falling back to direct proxy');
            setUseDirectProxy(true);
            setConnectionMode('direct');
            setState('connected');
          }
        }, 20000);

      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to connect';
          console.error('[CLIENT] Init error:', msg);
          setErrorMsg(msg);
          setState('error');
        }
      }
    };

    init();
    return () => { cancelled = true; };
  }, [sessionCode, clientId, onPeerUpdate]);

  const handleNavigate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    let target = url;
    if (!target.startsWith('http')) target = 'https://' + target;
    setBrowsedUrl(target);
    setLoading(true);
    setPageContent('');

    try {
      let result;

      if (useDirectProxy || connectionMode === 'direct') {
        result = await proxyFetch(target);
      } else {
        try {
          result = await webrtcRef.current?.sendProxyRequest(target);
        } catch (webrtcErr) {
          console.warn('[CLIENT] WebRTC proxy failed, falling back to direct:', webrtcErr);
          result = await proxyFetch(target);
          setUseDirectProxy(true);
          setConnectionMode('direct');
        }
      }

      if (result) {
        setPageContent(result.body);
        setDataUsed(d => d + (result.body.length / (1024 * 1024)));
      }
    } catch (err) {
      setPageContent(`Error: ${err instanceof Error ? err.message : 'Failed to fetch'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    webrtcRef.current?.disconnectAll();
    signalingRef.current?.disconnect();
    if (sessionDbId.current) {
      await dbRemovePeer(sessionDbId.current, clientId).catch(console.error);
    }
    setState('disconnected');
    setTimeout(() => navigate('/'), 1500);
  };

  const statusColor =
    state === 'connected' ? 'bg-accent mesh-glow' :
    state === 'disconnected' || state === 'error' ? 'bg-destructive' :
    'bg-yellow-500 animate-pulse';

  const steps = [
    { label: 'Session resolution', done: !['resolving'].includes(state), active: state === 'resolving' },
    { label: 'Signaling channel', done: ['handshaking', 'connected'].includes(state), active: state === 'connecting' },
    { label: 'ICE candidates (STUN/TURN)', done: state === 'connected', active: state === 'handshaking' },
    { label: 'DTLS / Data channel', done: state === 'connected', active: state === 'handshaking' },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`h-2 w-2 rounded-full ${statusColor}`} />
          <span className="text-xs font-mono tracking-tight">AETHER_CLIENT</span>
          <span className="status-label ml-2">Session: {sessionCode}</span>
          {connectionMode === 'direct' && state === 'connected' && (
            <span className="status-label text-yellow-500 ml-2">[DIRECT PROXY]</span>
          )}
          {connectionMode === 'webrtc' && state === 'connected' && (
            <span className="status-label text-accent ml-2">[P2P TUNNEL]</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {state === 'connected' && (
            <Metric label="Tunneled" value={`${dataUsed.toFixed(2)} MB`} />
          )}
          <button
            onClick={handleDisconnect}
            className="text-[10px] font-mono text-destructive mechanical-press tracking-wide"
          >
            DISCONNECT_
          </button>
        </div>
      </header>

      {state !== 'connected' && (
        <div className="flex-1 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center space-y-6"
          >
            {!['disconnected', 'error'].includes(state) && (
              <div className="flex justify-center">
                <div className="h-16 w-16 rounded-full border-2 border-primary/30 flex items-center justify-center">
                  <div className="h-8 w-8 rounded-full bg-primary signal-glow animate-pulse-glow" />
                </div>
              </div>
            )}
            <div>
              <p className="text-sm font-mono tracking-tight mb-1">
                {state === 'resolving' && 'RESOLVING_SESSION'}
                {state === 'connecting' && 'CONNECTING_SIGNALING'}
                {state === 'handshaking' && 'HANDSHAKE_IN_PROGRESS'}
                {state === 'disconnected' && 'SESSION_TERMINATED'}
                {state === 'error' && 'CONNECTION_FAILED'}
              </p>
              <p className="status-label">{stateLabels[state]}</p>
              {state === 'error' && <p className="text-xs text-destructive mt-2">{errorMsg}</p>}
            </div>

            {!['disconnected', 'error'].includes(state) && (
              <div className="space-y-1">
                {steps.map((step) => (
                  <div key={step.label} className="flex items-center gap-2 justify-center">
                    <div className={`h-1.5 w-1.5 rounded-full ${
                      step.done ? 'bg-accent' : step.active ? 'bg-yellow-500 animate-pulse' : 'bg-muted'
                    }`} />
                    <span className={`text-[10px] font-mono ${step.done ? 'text-accent' : 'text-muted-foreground'}`}>
                      {step.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {state === 'error' && (
              <button onClick={() => navigate('/')} className="text-xs font-mono text-primary mechanical-press">
                RETURN_HOME
              </button>
            )}
          </motion.div>
        </div>
      )}

      {state === 'connected' && (
        <>
          <form onSubmit={handleNavigate} className="border-b border-border px-4 py-2 flex gap-2">
            <div className="flex-1 flex items-center bg-surface border border-border px-3">
              <span className="text-[10px] font-mono text-accent mr-2">🔒</span>
              <input
                type="text"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="Enter URL to tunnel through host..."
                className="flex-1 bg-transparent text-sm font-mono outline-none placeholder:text-muted-foreground py-1.5"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="bg-primary text-primary-foreground text-xs font-mono px-4 mechanical-press disabled:opacity-50"
            >
              {loading ? 'LOADING...' : 'GO_'}
            </button>
          </form>

          <div className="flex-1 relative overflow-auto">
            {!browsedUrl ? (
              <div className="flex items-center justify-center h-full min-h-[300px]">
                <div className="text-center space-y-4 max-w-md">
                  <h2 className="text-lg font-mono tracking-[-0.04em]">Tunnel Active</h2>
                  <p className="text-sm text-muted-foreground">
                    Enter a URL above. Requests are {connectionMode === 'webrtc' ? 'encrypted and routed P2P through the host via WebRTC' : 'routed through the server-side proxy'}.
                  </p>
                  <div className="flex gap-2 justify-center flex-wrap">
                    {['example.com', 'httpbin.org/ip', 'ifconfig.me'].map(site => (
                      <button
                        key={site}
                        onClick={() => setUrl(site)}
                        className="text-[10px] font-mono text-primary border border-primary/30 px-2 py-1 mechanical-press hover:bg-primary/10 transition-colors"
                      >
                        {site}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : loading ? (
              <div className="flex items-center justify-center h-64">
                <div className="text-center space-y-3">
                  <div className="skeleton-shimmer h-4 w-64 mx-auto rounded-sm" />
                  <div className="skeleton-shimmer h-3 w-48 mx-auto rounded-sm" />
                  <div className="skeleton-shimmer h-3 w-56 mx-auto rounded-sm" />
                  <p className="status-label mt-4">Tunneling: {browsedUrl}</p>
                </div>
              </div>
            ) : (
              <div className="h-full">
                {pageContent.startsWith('<') || pageContent.startsWith('<!') ? (
                  <iframe
                    srcDoc={pageContent}
                    className="w-full h-full min-h-[500px] border-0"
                    sandbox="allow-same-origin"
                    title="Proxied content"
                  />
                ) : (
                  <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-all text-secondary-foreground">
                    {pageContent}
                  </pre>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default ClientBrowser;
