import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';

const Index = () => {
  const navigate = useNavigate();
  const [joinCode, setJoinCode] = useState('');

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    if (joinCode.trim()) {
      navigate(`/client/${joinCode.trim()}`);
    }
  };

  return (
    <div className="min-h-screen bg-background grid-bg flex items-center justify-center p-6 relative overflow-hidden">
      {/* Ambient glow effects */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-accent/5 rounded-full blur-[100px] pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 25 }}
        className="max-w-lg w-full space-y-14 relative z-10"
      >
        {/* Logo & Branding */}
        <div className="text-center space-y-4">
          <motion.div 
            className="flex justify-center mb-8"
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          >
            <div className="relative">
              <div className="h-20 w-20 rounded-xl border border-primary/30 flex items-center justify-center bg-card/50 backdrop-blur-sm">
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                  <circle cx="20" cy="8" r="4" fill="hsl(195, 100%, 50%)" />
                  <circle cx="8" cy="30" r="3" fill="hsl(160, 70%, 45%)" />
                  <circle cx="32" cy="30" r="3" fill="hsl(160, 70%, 45%)" />
                  <circle cx="20" cy="24" r="3" fill="hsl(280, 70%, 60%)" />
                  <line x1="20" y1="12" x2="20" y2="21" stroke="hsl(195, 100%, 50%)" strokeWidth="1.5" strokeDasharray="3 2" opacity="0.6" />
                  <line x1="18" y1="26" x2="10" y2="28" stroke="hsl(280, 70%, 60%)" strokeWidth="1.5" strokeDasharray="3 2" opacity="0.6" />
                  <line x1="22" y1="26" x2="30" y2="28" stroke="hsl(280, 70%, 60%)" strokeWidth="1.5" strokeDasharray="3 2" opacity="0.6" />
                </svg>
              </div>
              <div className="absolute -inset-1 rounded-xl bg-primary/10 blur-md -z-10" />
            </div>
          </motion.div>

          <h1 className="text-4xl font-bold font-display tracking-tight">
            <span className="text-gradient">AetherGrid</span>
          </h1>
          <p className="text-sm text-muted-foreground font-medium">Decentralized Mesh Internet Sharing</p>
          <p className="text-xs text-muted-foreground/70 max-w-sm mx-auto leading-relaxed">
            Turn every device into a relay node. Share internet access through encrypted peer-to-peer mesh networks — zero installs required.
          </p>
        </div>

        {/* Node types */}
        <div className="flex justify-center gap-8">
          {[
            { type: 'Gateway', color: 'text-primary', desc: 'Has internet' },
            { type: 'Relay', color: 'text-[hsl(280,70%,60%)]', desc: 'Forwards traffic' },
            { type: 'Client', color: 'text-accent', desc: 'Consumes access' },
          ].map(n => (
            <div key={n.type} className="text-center space-y-1">
              <div className={`text-xs font-mono font-semibold ${n.color}`}>{n.type}</div>
              <div className="text-[10px] text-muted-foreground">{n.desc}</div>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="space-y-4">
          <button
            onClick={() => navigate('/host')}
            className="w-full bg-primary text-primary-foreground font-display font-semibold text-sm py-3.5 rounded-md mechanical-press signal-glow hover:brightness-110 transition-all"
          >
            Start Gateway Node →
          </button>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="status-label">or join a mesh</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <form onSubmit={handleJoin} className="flex gap-2">
            <input
              type="text"
              value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              placeholder="SESSION CODE"
              maxLength={6}
              className="flex-1 bg-card border border-border px-4 py-3.5 text-sm font-mono tracking-widest text-center rounded-md outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20 transition-all placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              disabled={!joinCode.trim()}
              className="bg-secondary text-secondary-foreground font-display font-semibold text-sm px-6 py-3.5 rounded-md mechanical-press border border-border hover:bg-muted transition-colors disabled:opacity-30"
            >
              Join
            </button>
          </form>
        </div>

        {/* Footer */}
        <div className="grid grid-cols-4 gap-4 text-center">
          {[
            { label: 'Protocol', value: 'WebRTC' },
            { label: 'Encryption', value: 'DTLS' },
            { label: 'Topology', value: 'Mesh' },
            { label: 'Max Nodes', value: '10' },
          ].map(item => (
            <div key={item.label}>
              <div className="text-xs font-mono font-semibold">{item.value}</div>
              <div className="status-label">{item.label}</div>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
};

export default Index;
