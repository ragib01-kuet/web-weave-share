import type { SignalingService, SignalMessage } from './signaling';
import { supabase } from '@/integrations/supabase/client';

// Max size for a single DataChannel message (16KB to be safe across browsers)
const CHUNK_SIZE = 16 * 1024;

// Fetch ICE servers from edge function (includes TURN)
async function getIceServers(): Promise<RTCIceServer[]> {
  try {
    const { data, error } = await supabase.functions.invoke('get-ice-servers');
    if (error) throw error;
    return data?.iceServers || getFallbackIceServers();
  } catch (e) {
    console.warn('Failed to fetch ICE servers, using fallback:', e);
    return getFallbackIceServers();
  }
}

function getFallbackIceServers(): RTCIceServer[] {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
}

export interface PeerConnectionState {
  peerId: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  state: 'connecting' | 'connected' | 'disconnected';
  downlink: number;
  uplink: number;
  totalData: number;
  connectedAt: number;
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
  private iceServers: RTCIceServer[] = [];
  private iceServersReady = false;
  private pendingSignals: SignalMessage[] = [];
  private responseHandlers = new Map<string, (data: any) => void>();
  // Buffer for reassembling chunked messages
  private chunkBuffers = new Map<string, { chunks: string[]; total: number }>();

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
    this.initIceServers();
  }

  private async initIceServers() {
    this.iceServers = await getIceServers();
    this.iceServersReady = true;
    console.log(`[WebRTC] ICE servers loaded: ${this.iceServers.length} servers (${this.iceServers.filter(s => typeof s.urls === 'string' ? s.urls.startsWith('turn') : false).length} TURN)`);

    for (const msg of this.pendingSignals) {
      this.handleSignal(msg);
    }
    this.pendingSignals = [];
  }

  handleSignal(msg: SignalMessage) {
    if (!this.iceServersReady) {
      this.pendingSignals.push(msg);
      return;
    }

    switch (msg.type) {
      case 'peer-joined':
        if (this.isHost) {
          console.log(`[HOST] Peer joined: ${msg.from}`);
          this.createOffer(msg.from);
        }
        break;
      case 'offer':
        console.log(`[CLIENT] Received offer from: ${msg.from}`);
        this.handleOffer(msg.from, msg.payload);
        break;
      case 'answer':
        console.log(`[HOST] Received answer from: ${msg.from}`);
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

  announceHost() {
    // Host just listens
  }

  announceJoin() {
    console.log(`[CLIENT] Announcing join`);
    this.signaling.send({ type: 'peer-joined', payload: {} });
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 10,
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'ice-candidate',
          to: peerId,
          payload: event.candidate.toJSON(),
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE state for ${peerId}: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state for ${peerId}: ${pc.connectionState}`);
      const state = this.peers.get(peerId);
      if (!state) return;

      if (pc.connectionState === 'connected') {
        state.state = 'connected';
        state.connectedAt = Date.now();
        this.startBandwidthTracking(peerId);
      } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        state.state = 'disconnected';
      }
      this.notifyUpdate();
    };

    return pc;
  }

  private async createOffer(peerId: string) {
    const pc = this.createPeerConnection(peerId);

    // Use ordered + reliable data channel for proxy traffic
    const dc = pc.createDataChannel('aether-proxy', {
      ordered: true,
    });
    this.setupDataChannel(dc, peerId);

    const peerState: PeerConnectionState = {
      peerId,
      connection: pc,
      dataChannel: dc,
      state: 'connecting',
      downlink: 0,
      uplink: 0,
      totalData: 0,
      connectedAt: Date.now(),
    };
    this.peers.set(peerId, peerState);
    this.notifyUpdate();

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.signaling.send({
        type: 'offer',
        to: peerId,
        payload: pc.localDescription?.toJSON(),
      });
    } catch (e) {
      console.error(`[HOST] Failed to create offer for ${peerId}:`, e);
    }
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit) {
    const pc = this.createPeerConnection(peerId);

    pc.ondatachannel = (event) => {
      console.log(`[CLIENT] Data channel received from ${peerId}`);
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
      connectedAt: Date.now(),
    };
    this.peers.set(peerId, peerState);
    this.notifyUpdate();

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.signaling.send({
        type: 'answer',
        to: peerId,
        payload: pc.localDescription?.toJSON(),
      });
    } catch (e) {
      console.error(`[CLIENT] Failed to handle offer from ${peerId}:`, e);
    }
  }

  private async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit) {
    const state = this.peers.get(peerId);
    if (!state) return;
    try {
      await state.connection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
      console.error(`[HOST] Failed to set answer from ${peerId}:`, e);
    }
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
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      console.log(`[WebRTC] Data channel OPEN with ${peerId}`);
      const state = this.peers.get(peerId);
      if (state) {
        state.state = 'connected';
        state.dataChannel = dc;
        state.connectedAt = Date.now();
      }
      this.notifyUpdate();
    };

    dc.onmessage = (event) => {
      const size = typeof event.data === 'string' ? event.data.length : event.data.byteLength;
      this.trackBandwidth(peerId, size, 'down');

      try {
        const message = JSON.parse(event.data);

        // Handle chunked messages
        if (message.type === 'CHUNK') {
          this.handleChunk(peerId, message);
          return;
        }

        if (message.type === 'FETCH_REQUEST' && this.isHost && this.onProxyRequest) {
          console.log(`[HOST] Proxy request from ${peerId}: ${message.url}`);
          this.onProxyRequest(peerId, message.id, message.url);
        }

        if (message.type === 'FETCH_RESPONSE' && !this.isHost) {
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
      console.log(`[WebRTC] Data channel CLOSED with ${peerId}`);
      const state = this.peers.get(peerId);
      if (state) state.state = 'disconnected';
      this.notifyUpdate();
    };

    dc.onerror = (e) => {
      console.error(`[WebRTC] Data channel ERROR with ${peerId}:`, e);
    };
  }

  /**
   * Handle incoming chunk — reassemble into full message when all chunks received
   */
  private handleChunk(peerId: string, chunk: { chunkId: string; index: number; total: number; data: string }) {
    const key = chunk.chunkId;
    if (!this.chunkBuffers.has(key)) {
      this.chunkBuffers.set(key, { chunks: new Array(chunk.total), total: chunk.total });
    }

    const buffer = this.chunkBuffers.get(key)!;
    buffer.chunks[chunk.index] = chunk.data;

    // Check if all chunks received
    const received = buffer.chunks.filter(c => c !== undefined).length;
    if (received === buffer.total) {
      const fullData = buffer.chunks.join('');
      this.chunkBuffers.delete(key);

      try {
        const message = JSON.parse(fullData);
        // Re-dispatch the reassembled message
        if (message.type === 'FETCH_RESPONSE' && !this.isHost) {
          const handler = this.responseHandlers.get(message.id);
          if (handler) {
            handler(message);
            this.responseHandlers.delete(message.id);
          }
        }
        if (message.type === 'FETCH_REQUEST' && this.isHost && this.onProxyRequest) {
          this.onProxyRequest(peerId, message.id, message.url);
        }
      } catch (e) {
        console.error('Failed to parse reassembled chunked message:', e);
      }
    }
  }

  /**
   * Send a message over DataChannel, chunking if necessary
   */
  private sendChunked(dc: RTCDataChannel, peerId: string, message: string) {
    if (message.length <= CHUNK_SIZE) {
      this.trackBandwidth(peerId, message.length, 'up');
      dc.send(message);
      return;
    }

    // Split into chunks
    const chunkId = Math.random().toString(36).slice(2);
    const totalChunks = Math.ceil(message.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const chunkData = message.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const chunkMsg = JSON.stringify({
        type: 'CHUNK',
        chunkId,
        index: i,
        total: totalChunks,
        data: chunkData,
      });
      this.trackBandwidth(peerId, chunkMsg.length, 'up');
      dc.send(chunkMsg);
    }
  }

  sendProxyRequest(url: string): Promise<{ body: string; status: number; contentType: string }> {
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).slice(2);

      const hostPeer = Array.from(this.peers.values()).find(
        p => p.state === 'connected' && p.dataChannel?.readyState === 'open'
      );
      if (!hostPeer || !hostPeer.dataChannel) {
        reject(new Error('No connected host'));
        return;
      }

      const message = JSON.stringify({ type: 'FETCH_REQUEST', id: requestId, url });

      try {
        this.sendChunked(hostPeer.dataChannel, hostPeer.peerId, message);
      } catch (e) {
        reject(new Error('Failed to send via data channel'));
        return;
      }

      const timeout = setTimeout(() => {
        this.responseHandlers.delete(requestId);
        reject(new Error('Request timed out (30s)'));
      }, 30000);

      this.responseHandlers.set(requestId, (data) => {
        clearTimeout(timeout);
        resolve({ body: data.body, status: data.status, contentType: data.contentType });
      });
    });
  }

  /**
   * Send proxy response back to client — uses chunking for large payloads
   */
  sendProxyResponse(peerId: string, requestId: string, body: string, status: number, contentType: string) {
    const state = this.peers.get(peerId);
    if (!state?.dataChannel || state.dataChannel.readyState !== 'open') {
      console.warn(`[HOST] Cannot send response to ${peerId} - channel not open`);
      return;
    }

    const message = JSON.stringify({ type: 'FETCH_RESPONSE', id: requestId, body, status, contentType });

    try {
      this.sendChunked(state.dataChannel, peerId, message);
    } catch (e) {
      console.error(`[HOST] Failed to send proxy response to ${peerId}:`, e);
    }
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
    for (const id of Array.from(this.peers.keys())) {
      this.removePeer(id);
    }
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
        if (elapsed > 0.5) {
          state.downlink = (tracker.bytes / elapsed) * 8 / 1_000_000;
          tracker.lastTime = Date.now();
          tracker.bytes = bytes;
        } else {
          tracker.bytes += bytes;
        }
      }
    } else {
      state.uplink = (bytes * 8) / 1_000_000;
    }
  }

  private startBandwidthTracking(peerId: string) {
    this.bandwidthTrackers.set(peerId, { lastTime: Date.now(), bytes: 0 });
  }
}
