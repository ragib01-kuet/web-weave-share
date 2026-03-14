import type { SignalingService, SignalMessage } from './signaling';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

export interface PeerConnectionState {
  peerId: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  state: 'connecting' | 'connected' | 'disconnected';
  downlink: number;
  uplink: number;
  totalData: number;
}

type OnPeerUpdate = (peers: Map<string, PeerConnectionState>) => void;
type OnProxyRequest = (peerId: string, requestId: string, url: string) => void;

export class WebRTCManager {
  private peers = new Map<string, PeerConnectionState>();
  private signaling: SignalingService;
  private localId: string;
  private isHost: boolean;
  private onPeerUpdate: OnPeerUpdate;
  private onProxyRequest?: OnProxyRequest;
  private bandwidthTrackers = new Map<string, { lastTime: number; bytes: number }>();

  constructor(
    signaling: SignalingService,
    localId: string,
    isHost: boolean,
    onPeerUpdate: OnPeerUpdate,
    onProxyRequest?: OnProxyRequest
  ) {
    this.signaling = signaling;
    this.localId = localId;
    this.isHost = isHost;
    this.onPeerUpdate = onPeerUpdate;
    this.onProxyRequest = onProxyRequest;
  }

  handleSignal(msg: SignalMessage) {
    switch (msg.type) {
      case 'peer-joined':
        if (this.isHost) this.createOffer(msg.from);
        break;
      case 'offer':
        this.handleOffer(msg.from, msg.payload);
        break;
      case 'answer':
        this.handleAnswer(msg.from, msg.payload);
        break;
      case 'ice-candidate':
        this.handleIceCandidate(msg.from, msg.payload);
        break;
      case 'peer-left':
        this.removePeer(msg.from);
        break;
    }
  }

  // Host: announce presence so clients know to join
  announceHost() {
    // Host just listens; no announcement needed
  }

  // Client: announce joining to trigger host to create offer
  announceJoin() {
    this.signaling.send({ type: 'peer-joined', payload: {} });
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'ice-candidate',
          to: peerId,
          payload: event.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = this.peers.get(peerId);
      if (!state) return;

      if (pc.connectionState === 'connected') {
        state.state = 'connected';
        this.startBandwidthTracking(peerId);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        state.state = 'disconnected';
      }
      this.notifyUpdate();
    };

    return pc;
  }

  private async createOffer(peerId: string) {
    const pc = this.createPeerConnection(peerId);

    // Host creates data channel
    const dc = pc.createDataChannel('aether-proxy', { ordered: true });
    this.setupDataChannel(dc, peerId);

    const peerState: PeerConnectionState = {
      peerId,
      connection: pc,
      dataChannel: dc,
      state: 'connecting',
      downlink: 0,
      uplink: 0,
      totalData: 0,
    };
    this.peers.set(peerId, peerState);
    this.notifyUpdate();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.signaling.send({
      type: 'offer',
      to: peerId,
      payload: pc.localDescription?.toJSON(),
    });
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit) {
    const pc = this.createPeerConnection(peerId);

    pc.ondatachannel = (event) => {
      this.setupDataChannel(event.channel, peerId);
      const state = this.peers.get(peerId);
      if (state) state.dataChannel = event.channel;
    };

    const peerState: PeerConnectionState = {
      peerId,
      connection: pc,
      dataChannel: null,
      state: 'connecting',
      downlink: 0,
      uplink: 0,
      totalData: 0,
    };
    this.peers.set(peerId, peerState);
    this.notifyUpdate();

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.signaling.send({
      type: 'answer',
      to: peerId,
      payload: pc.localDescription?.toJSON(),
    });
  }

  private async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit) {
    const state = this.peers.get(peerId);
    if (!state) return;
    await state.connection.setRemoteDescription(new RTCSessionDescription(answer));
  }

  private async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit) {
    const state = this.peers.get(peerId);
    if (!state) return;
    try {
      await state.connection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('Failed to add ICE candidate:', e);
    }
  }

  private setupDataChannel(dc: RTCDataChannel, peerId: string) {
    dc.onopen = () => {
      console.log(`Data channel open with ${peerId}`);
      const state = this.peers.get(peerId);
      if (state) {
        state.state = 'connected';
        state.dataChannel = dc;
      }
      this.notifyUpdate();
    };

    dc.onmessage = (event) => {
      this.trackBandwidth(peerId, event.data.length || 0, 'down');
      
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'FETCH_REQUEST' && this.isHost && this.onProxyRequest) {
          this.onProxyRequest(peerId, message.id, message.url);
        }

        if (message.type === 'FETCH_RESPONSE' && !this.isHost) {
          // Client receives proxied response
          const handler = this.responseHandlers.get(message.id);
          if (handler) {
            handler(message);
            this.responseHandlers.delete(message.id);
          }
        }
      } catch (e) {
        console.warn('Failed to parse data channel message:', e);
      }
    };

    dc.onclose = () => {
      console.log(`Data channel closed with ${peerId}`);
      const state = this.peers.get(peerId);
      if (state) state.state = 'disconnected';
      this.notifyUpdate();
    };
  }

  // Client-side: send proxy request and wait for response
  private responseHandlers = new Map<string, (data: any) => void>();

  sendProxyRequest(url: string): Promise<{ body: string; status: number; contentType: string }> {
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2);
      
      // Find a connected peer (host)
      const hostPeer = Array.from(this.peers.values()).find(p => p.state === 'connected' && p.dataChannel?.readyState === 'open');
      if (!hostPeer || !hostPeer.dataChannel) {
        reject(new Error('No connected host'));
        return;
      }

      const message = JSON.stringify({ type: 'FETCH_REQUEST', id: requestId, url });
      this.trackBandwidth(hostPeer.peerId, message.length, 'up');
      hostPeer.dataChannel.send(message);

      // Set timeout
      const timeout = setTimeout(() => {
        this.responseHandlers.delete(requestId);
        reject(new Error('Request timed out'));
      }, 30000);

      this.responseHandlers.set(requestId, (data) => {
        clearTimeout(timeout);
        resolve({ body: data.body, status: data.status, contentType: data.contentType });
      });
    });
  }

  // Host: send proxy response back to client
  sendProxyResponse(peerId: string, requestId: string, body: string, status: number, contentType: string) {
    const state = this.peers.get(peerId);
    if (!state?.dataChannel || state.dataChannel.readyState !== 'open') return;

    const message = JSON.stringify({ type: 'FETCH_RESPONSE', id: requestId, body, status, contentType });
    this.trackBandwidth(peerId, message.length, 'up');
    state.dataChannel.send(message);
  }

  removePeer(peerId: string) {
    const state = this.peers.get(peerId);
    if (state) {
      state.dataChannel?.close();
      state.connection.close();
      this.peers.delete(peerId);
      this.bandwidthTrackers.delete(peerId);
      this.notifyUpdate();
    }
  }

  terminatePeer(peerId: string) {
    this.signaling.send({ type: 'peer-left', to: peerId, payload: {} });
    this.removePeer(peerId);
  }

  disconnectAll() {
    this.signaling.send({ type: 'peer-left', payload: {} });
    this.peers.forEach((_, id) => this.removePeer(id));
  }

  getPeers() {
    return this.peers;
  }

  private notifyUpdate() {
    this.onPeerUpdate(new Map(this.peers));
  }

  private trackBandwidth(peerId: string, bytes: number, direction: 'up' | 'down') {
    const state = this.peers.get(peerId);
    if (!state) return;
    state.totalData += bytes;

    if (direction === 'down') {
      const tracker = this.bandwidthTrackers.get(peerId);
      if (tracker) {
        const elapsed = (Date.now() - tracker.lastTime) / 1000;
        if (elapsed > 0) {
          state.downlink = ((tracker.bytes + bytes) / elapsed) * 8 / 1_000_000; // Mb/s
        }
        tracker.bytes += bytes;
      }
    }
  }

  private startBandwidthTracking(peerId: string) {
    this.bandwidthTrackers.set(peerId, { lastTime: Date.now(), bytes: 0 });
    
    // Reset tracker periodically
    setInterval(() => {
      const tracker = this.bandwidthTrackers.get(peerId);
      if (tracker) {
        tracker.lastTime = Date.now();
        tracker.bytes = 0;
      }
    }, 3000);
  }
}
