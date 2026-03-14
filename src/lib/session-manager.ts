import { supabase } from '@/integrations/supabase/client';

// Generate a 6-char session code
export const generateSessionCode = (): string => {
  return Array.from({ length: 6 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('');
};

// Generate anonymous ID for host/client
export const generateAnonymousId = (): string => {
  const stored = sessionStorage.getItem('aether_anon_id');
  if (stored) return stored;
  const id = crypto.randomUUID();
  sessionStorage.setItem('aether_anon_id', id);
  return id;
};

// Create a new session
export const createSession = async (hostId: string, sessionCode: string) => {
  const { data, error } = await supabase
    .from('sessions')
    .insert({ session_code: sessionCode, host_id: hostId })
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Get session by code
export const getSession = async (code: string) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('session_code', code)
    .eq('is_active', true)
    .single();
  if (error) throw error;
  return data;
};

// End session
export const endSession = async (sessionId: string) => {
  const { error } = await supabase
    .from('sessions')
    .update({ is_active: false })
    .eq('id', sessionId);
  if (error) throw error;
};

// Add peer to session
export const addPeer = async (sessionId: string, peerId: string) => {
  const { data, error } = await supabase
    .from('peers')
    .upsert(
      { session_id: sessionId, peer_id: peerId, is_connected: true, connected_at: new Date().toISOString() },
      { onConflict: 'session_id,peer_id' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Remove peer
export const removePeer = async (sessionId: string, peerId: string) => {
  const { error } = await supabase
    .from('peers')
    .update({ is_connected: false, disconnected_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .eq('peer_id', peerId);
  if (error) throw error;
};

// Get connected peers for session
export const getSessionPeers = async (sessionId: string) => {
  const { data, error } = await supabase
    .from('peers')
    .select('*')
    .eq('session_id', sessionId)
    .eq('is_connected', true);
  if (error) throw error;
  return data || [];
};

// Proxy fetch via edge function
export const proxyFetch = async (url: string): Promise<{ body: string; status: number; contentType: string }> => {
  const { data, error } = await supabase.functions.invoke('proxy-fetch', {
    body: { url },
  });

  if (error) throw error;

  // The edge function returns the raw response
  // When invoked via supabase client, data is already parsed
  if (typeof data === 'string') {
    return { body: data, status: 200, contentType: 'text/html' };
  }
  
  // If it's an error response
  if (data?.error) {
    throw new Error(data.error);
  }

  return { body: JSON.stringify(data), status: 200, contentType: 'application/json' };
};
