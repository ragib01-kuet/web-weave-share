import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import Metric from '@/components/Metric';

type ConnectionState = 'connecting' | 'handshaking' | 'connected' | 'disconnected';

const stateLabels: Record<ConnectionState, string> = {
  connecting: 'Resolving signaling server...',
  handshaking: 'WebRTC handshake in progress...',
  connected: 'Tunnel active. All traffic encrypted.',
  disconnected: 'Disconnected from mesh.',
};

const ClientBrowser = () => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<ConnectionState>('connecting');
  const [url, setUrl] = useState('');
  const [browsedUrl, setBrowsedUrl] = useState('');
  const [dataUsed, setDataUsed] = useState(0);

  // Simulate connection sequence
  useEffect(() => {
    const t1 = setTimeout(() => setState('handshaking'), 1500);
    const t2 = setTimeout(() => setState('connected'), 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // Simulate data usage
  useEffect(() => {
    if (state !== 'connected' || !browsedUrl) return;
    const interval = setInterval(() => {
      setDataUsed(d => d + Math.random() * 0.5);
    }, 1000);
    return () => clearInterval(interval);
  }, [state, browsedUrl]);

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    let target = url;
    if (!target.startsWith('http')) target = 'https://' + target;
    setBrowsedUrl(target);
  };

  const handleDisconnect = () => {
    setState('disconnected');
    setTimeout(() => navigate('/'), 1500);
  };

  const statusColor =
    state === 'connected' ? 'bg-accent mesh-glow' :
    state === 'disconnected' ? 'bg-destructive' :
    'bg-yellow-500 animate-pulse';

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top Bar */}
      <header className="border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`h-2 w-2 rounded-full ${statusColor}`} />
          <span className="text-xs font-mono tracking-tight">
            AETHER_CLIENT
          </span>
          <span className="status-label ml-2">
            Session: {sessionId}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {state === 'connected' && (
            <Metric label="Tunneled" value={`${dataUsed.toFixed(1)} MB`} />
          )}
          <button
            onClick={handleDisconnect}
            className="text-[10px] font-mono text-destructive mechanical-press tracking-wide"
          >
            DISCONNECT_
          </button>
        </div>
      </header>

      {/* Connection Status */}
      {state !== 'connected' && (
        <div className="flex-1 flex items-center justify-center">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center space-y-6"
          >
            {state !== 'disconnected' && (
              <div className="flex justify-center">
                <div className="h-16 w-16 rounded-full border-2 border-primary/30 flex items-center justify-center">
                  <div className="h-8 w-8 rounded-full bg-primary signal-glow animate-pulse-glow" />
                </div>
              </div>
            )}
            <div>
              <p className="text-sm font-mono tracking-tight mb-1">
                {state === 'connecting' && 'INITIALIZING_NODE'}
                {state === 'handshaking' && 'HANDSHAKE_IN_PROGRESS'}
                {state === 'disconnected' && 'SESSION_TERMINATED'}
              </p>
              <p className="status-label">{stateLabels[state]}</p>
            </div>

            {state !== 'disconnected' && (
              <div className="space-y-1">
                {['STUN resolution', 'ICE candidate gathering', 'DTLS handshake', 'Service Worker proxy'].map((step, i) => {
                  const done = state === 'handshaking' ? i < 2 : i < 4;
                  const active = state === 'handshaking' && i === 2;
                  return (
                    <div key={step} className="flex items-center gap-2 justify-center">
                      <div className={`h-1.5 w-1.5 rounded-full ${
                        done ? 'bg-accent' : active ? 'bg-yellow-500 animate-pulse' : 'bg-muted'
                      }`} />
                      <span className={`text-[10px] font-mono ${done ? 'text-accent' : 'text-muted-foreground'}`}>
                        {step}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </motion.div>
        </div>
      )}

      {/* Browser Chrome */}
      {state === 'connected' && (
        <>
          {/* URL Bar */}
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
              className="bg-primary text-primary-foreground text-xs font-mono px-4 mechanical-press"
            >
              GO_
            </button>
          </form>

          {/* Content Area */}
          <div className="flex-1 relative">
            {!browsedUrl ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center space-y-4 max-w-md">
                  <h2 className="text-lg font-mono tracking-[-0.04em]">Tunnel Active</h2>
                  <p className="text-sm text-muted-foreground">
                    Enter a URL above. All requests are encrypted and routed through the host node via WebRTC data channels.
                  </p>
                  <div className="flex gap-2 justify-center flex-wrap">
                    {['example.com', 'httpbin.org/ip', 'ifconfig.me'].map(site => (
                      <button
                        key={site}
                        onClick={() => { setUrl(site); }}
                        className="text-[10px] font-mono text-primary border border-primary/30 px-2 py-1 mechanical-press hover:bg-primary/10 transition-colors"
                      >
                        {site}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col">
                <div className="flex-1 flex items-center justify-center bg-surface">
                  <div className="text-center space-y-3 p-8">
                    <div className="skeleton-shimmer h-4 w-64 mx-auto rounded-sm" />
                    <div className="skeleton-shimmer h-3 w-48 mx-auto rounded-sm" />
                    <div className="skeleton-shimmer h-3 w-56 mx-auto rounded-sm" />
                    <p className="status-label mt-6">
                      Tunneling: {browsedUrl}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      In production, content would render here via the WebRTC proxy.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default ClientBrowser;
