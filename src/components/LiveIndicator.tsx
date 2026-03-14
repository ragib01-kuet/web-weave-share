const LiveIndicator = () => (
  <div className="flex items-center gap-2">
    <div className="h-3 w-3 rounded-full bg-primary signal-glow animate-pulse-glow" />
    <span className="status-label text-primary">Live</span>
  </div>
);

export default LiveIndicator;
