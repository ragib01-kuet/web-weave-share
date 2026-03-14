import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';

export type SignalType = 'offer' | 'answer' | 'ice-candidate' | 'peer-joined' | 'peer-left' | 'proxy-request' | 'proxy-response';

export interface SignalMessage {
  type: SignalType;
  from: string;
  to?: string;
  payload: any;
}

export class SignalingService {
  private channel: RealtimeChannel | null = null;
  private sessionCode: string;
  private localId: string;
  private onMessage: (msg: SignalMessage) => void;

  constructor(sessionCode: string, localId: string, onMessage: (msg: SignalMessage) => void) {
    this.sessionCode = sessionCode;
    this.localId = localId;
    this.onMessage = onMessage;
  }

  connect() {
    this.channel = supabase.channel(`session:${this.sessionCode}`, {
      config: { broadcast: { self: false } },
    });

    this.channel
      .on('broadcast', { event: 'signal' }, ({ payload }) => {
        const msg = payload as SignalMessage;
        // Only process messages meant for us or broadcast
        if (!msg.to || msg.to === this.localId) {
          this.onMessage(msg);
        }
      })
      .subscribe();
  }

  send(message: Omit<SignalMessage, 'from'>) {
    if (!this.channel) return;
    this.channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: { ...message, from: this.localId },
    });
  }

  disconnect() {
    if (this.channel) {
      supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }
}
