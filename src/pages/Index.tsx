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
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="max-w-md w-full space-y-12"
      >
        {/* Logo */}
        <div className="text-center space-y-3">
          <div className="flex justify-center mb-6">
            <div className="h-16 w-16 rounded-full border-2 border-primary/40 flex items-center justify-center">
              <div className="h-6 w-6 rounded-full bg-primary signal-glow" />
            </div>
          </div>
          <h1 className="text-3xl font-bold font-mono tracking-[-0.04em]">AETHER</h1>
          <p className="text-sm text-muted-foreground">Mesh the Last Mile.</p>
          <p className="text-xs text-muted-foreground max-w-xs mx-auto">
            Browser-based mesh gateway. Share internet over WebRTC with zero installs.
          </p>
        </div>

        {/* Actions */}
        <div className="space-y-4">
          <button
            onClick={() => navigate('/host')}
            className="w-full bg-primary text-primary-foreground font-mono text-sm py-3 mechanical-press signal-glow hover:brightness-110 transition-all"
          >
            INITIALIZE_NODE →
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
              placeholder="SESSION_CODE"
              maxLength={6}
              className="flex-1 bg-card border border-border px-4 py-3 text-sm font-mono tracking-widest text-center outline-none focus:border-primary/50 transition-colors placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              disabled={!joinCode.trim()}
              className="bg-secondary text-secondary-foreground font-mono text-sm px-6 py-3 mechanical-press border border-border hover:bg-muted transition-colors disabled:opacity-30"
            >
              JOIN_
            </button>
          </form>
        </div>

        {/* Footer Info */}
        <div className="grid grid-cols-3 gap-4 text-center">
          {[
            { label: 'Protocol', value: 'WebRTC' },
            { label: 'Encryption', value: 'DTLS' },
            { label: 'Max Peers', value: '10' },
          ].map(item => (
            <div key={item.label}>
              <div className="text-xs font-mono">{item.value}</div>
              <div className="status-label">{item.label}</div>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
};

export default Index;
