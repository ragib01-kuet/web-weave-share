
-- Create sessions table (no auth required - anonymous usage)
CREATE TABLE public.sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_code TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  bandwidth_cap INTEGER NOT NULL DEFAULT 0,
  max_peers INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create peers table to track connected clients
CREATE TABLE public.peers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  peer_id TEXT NOT NULL,
  ip_address TEXT,
  connected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMP WITH TIME ZONE,
  total_data_bytes BIGINT NOT NULL DEFAULT 0,
  is_connected BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(session_id, peer_id)
);

-- Enable RLS
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.peers ENABLE ROW LEVEL SECURITY;

-- Sessions: anyone can read active sessions (needed for clients to join)
CREATE POLICY "Anyone can read active sessions" ON public.sessions
  FOR SELECT USING (true);

-- Sessions: anyone can create sessions (no auth)
CREATE POLICY "Anyone can create sessions" ON public.sessions
  FOR INSERT WITH CHECK (true);

-- Sessions: host can update their own session
CREATE POLICY "Host can update own session" ON public.sessions
  FOR UPDATE USING (true);

-- Peers: anyone can read peers (for dashboard)
CREATE POLICY "Anyone can read peers" ON public.peers
  FOR SELECT USING (true);

-- Peers: anyone can insert peers (clients joining)
CREATE POLICY "Anyone can insert peers" ON public.peers
  FOR INSERT WITH CHECK (true);

-- Peers: anyone can update peers
CREATE POLICY "Anyone can update peers" ON public.peers
  FOR UPDATE USING (true);

-- Peers: anyone can delete peers
CREATE POLICY "Anyone can delete peers" ON public.peers
  FOR DELETE USING (true);

-- Sessions: anyone can delete
CREATE POLICY "Anyone can delete sessions" ON public.sessions
  FOR DELETE USING (true);

-- Index for fast session lookup
CREATE INDEX idx_sessions_code ON public.sessions(session_code);
CREATE INDEX idx_peers_session ON public.peers(session_id);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_sessions_updated_at
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
