import type { SignalingService, SignalMessage } from './signaling';
import { supabase } from '@/integrations/supabase/client';

// Max size for a single DataChannel message (16KB safe across browsers)
const CHUNK_SIZE = 16 * 1024;

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

export type NodeRole = 'gateway' | 'relay' | 'client';

export interface PeerConnectionState {
  peerId: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  state: 'connecting' | 'connected' | 'disconnected';
  downlink: number;
  uplink: number;
  totalData: number;
  connectedAt: number;
  /** Whether this peer is an upstream (host/relay) or downstream (client through us) */
  direction: 'upstream' | 'downstream';
}

type OnPeerUpdate = (peers: Map<string, PeerConnectionState>) => void;
type OnProxyRequest = (peerId: string, requestId: string, url: string) => void;
type OnRoleChange = (role: NodeRole) => void;

export class WebRTCManager {
  private peers = new Map<string, PeerConnectionState>();
  private signaling: SignalingService;
  private localId: string;
  private isHost: boolean;
  private onPeerUpdate: OnPeerUpdate;
  private onProxyRequest?: OnProxyRequest;
  private onRoleChange?: OnRoleChange;
  private bandwidthTrackers = new Map<string, { lastTime: number; bytes: number }>();
  private iceServers: RTCIceServer[] = [];
  private iceServersReady = false;
  private pendingSignals: SignalMessage[] = [];
  private responseHandlers = new Map<string, (data: any) => void>();
  private chunkBuffers = new Map<string, { chunks: string[]; total: number }>();

  // Relay state
  private isRelay = false;
  private upstreamPeerId: string | null = null;
  /** Maps relay-generated requestId → { downstreamPeerId, originalRequestId } */
  private relayRequestMap = new Map<string, { downstreamPeerId: string; originalRequestId: string }>();

  constructor(
    signaling: SignalingService,
    localId: string,
    isHost: boolean,
    onPeerUpdate: OnPeerUpdate,
    onProxyRequest?: OnProxyRequest,
    onRoleChange?: OnRoleChange
  ) {
    this.signaling = signaling;
    this.localId = localId;
    this.isHost = isHost;
    this.onPeerUpdate = onPeerUpdate;
    this.onProxyRequest = onProxyRequest;
    this.onRoleChange = onRoleChange;
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
          this.createOffer(msg.from, 'downstream');
        }
        break;

      case 'offer':
        console.log(`[${this.isHost ? 'HOST' : 'CLIENT'}] Received offer from: ${msg.from}`);
        this.handleOffer(msg.from, msg.payload);
        break;

      case 'answer':
        console.log(`[${this.isHost ? 'HOST' : 'RELAY'}] Received answer from: ${msg.from}`);
        this.handleAnswer(msg.from, msg.payload);
        break;

      case 'ice-candidate':
        this.handleIceCandidate(msg.from, msg.payload);
        break;

      case 'peer-left':
        this.removePeer(msg.from);
        break;

      // --- Relay signals ---
      case 'relay-promote':
        // Host is promoting us to relay
        console.log(`[CLIENT→RELAY] Promoted to relay by host`);
        this.isRelay = true;
        this.upstreamPeerId = msg.from; // The host is our upstream
        this.onRoleChange?.('relay');
        break;

      case 'relay-incoming':
        // Host tells us (relay) to expect a connection from a new client
        if (this.isRelay) {
          const clientId = msg.payload.clientId;
          console.log(`[RELAY] Incoming client: ${clientId}, creating offer`);
          this.createOffer(clientId, 'downstream');
        }
        break;

      case 'relay-assign':
        // Host tells us (new client) to connect through a relay
        // We DON'T announce peer-joined; just wait for the relay's offer
        console.log(`[CLIENT] Assigned to relay: ${msg.payload.relayId}`);
        this.upstreamPeerId = msg.payload.relayId;
        // The relay will send us an offer via relay-incoming
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

  getRole(): NodeRole {
    if (this.isHost) return 'gateway';
    if (this.isRelay) return 'relay';
    return 'client';
  }

  getIsRelay(): boolean {
    return this.isRelay;
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

  private async createOffer(peerId: string, direction: 'upstream' | 'downstream') {
    const pc = this.createPeerConnection(peerId);

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
      connectedAt: Date.now(),
      direction,
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
      console.error(`Failed to create offer for ${peerId}:`, e);
    }
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit) {
    const pc = this.createPeerConnection(peerId);

    pc.ondatachannel = (event) => {
      console.log(`Data channel received from ${peerId}`);
      this.setupDataChannel(event.channel, peerId);
      const state = this.peers.get(peerId);
      if (state) state.dataChannel = event.channel;
    };

    // Determine direction: if offer comes from a known upstream or host, it's upstream
    const direction: 'upstream' | 'downstream' =
      (this.upstreamPeerId === peerId || (!this.isHost && !this.isRelay)) ? 'upstream' : 'downstream';

    const peerState: PeerConnectionState = {
      peerId,
      connection: pc,
      dataChannel: null,
      state: 'connecting',
      downlink: 0,
      uplink: 0,
      totalData: 0,
      connectedAt: Date.now(),
      direction,
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
      console.error(`Failed to handle offer from ${peerId}:`, e);
    }
  }

  private async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit) {
    const state = this.peers.get(peerId);
    if (!state) return;
    try {
      await state.connection.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
      console.error(`Failed to set answer from ${peerId}:`, e);
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

        this.handleDataMessage(peerId, message);
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
   * Central message handler — handles FETCH_REQUEST/RESPONSE with relay forwarding
   */
  private handleDataMessage(fromPeerId: string, message: any) {
    if (message.type === 'FETCH_REQUEST') {
      if (this.isHost && this.onProxyRequest) {
        // Gateway: fetch the URL using host's internet
        console.log(`[HOST] Proxy request from ${fromPeerId}: ${message.url}`);
        this.onProxyRequest(fromPeerId, message.id, message.url);
      } else if (this.isRelay) {
        // Relay: forward upstream to host/upstream relay
        this.forwardRequestUpstream(fromPeerId, message);
      }
    }

    if (message.type === 'FETCH_RESPONSE') {
      if (this.isRelay) {
        // Check if this response is for a relayed request
        const relayInfo = this.relayRequestMap.get(message.id);
        if (relayInfo) {
          // Forward response back to the downstream client
          this.relayRequestMap.delete(message.id);
          this.sendProxyResponse(
            relayInfo.downstreamPeerId,
            relayInfo.originalRequestId,
            message.body,
            message.status,
            message.contentType
          );
          return;
        }
      }

      // Normal client: resolve the pending request
      const handler = this.responseHandlers.get(message.id);
      if (handler) {
        handler(message);
        this.responseHandlers.delete(message.id);
      }
    }
  }

  /**
   * Relay: forward a FETCH_REQUEST upstream
   */
  private forwardRequestUpstream(downstreamPeerId: string, originalMessage: any) {
    // Find upstream peer (host or upstream relay)
    const upstream = this.getUpstreamPeer();
    if (!upstream?.dataChannel || upstream.dataChannel.readyState !== 'open') {
      // No upstream — send error back
      this.sendProxyResponse(downstreamPeerId, originalMessage.id,
        JSON.stringify({ error: 'No upstream connection available' }), 502, 'application/json');
      return;
    }

    // Generate new requestId for upstream, map it back
    const upstreamRequestId = Math.random().toString(36).slice(2);
    this.relayRequestMap.set(upstreamRequestId, {
      downstreamPeerId,
      originalRequestId: originalMessage.id,
    });

    const forwardMsg = JSON.stringify({
      type: 'FETCH_REQUEST',
      id: upstreamRequestId,
      url: originalMessage.url,
    });

    console.log(`[RELAY] Forwarding request upstream: ${originalMessage.url}`);
    try {
      this.sendChunked(upstream.dataChannel, upstream.peerId, forwardMsg);
    } catch (e) {
      this.relayRequestMap.delete(upstreamRequestId);
      this.sendProxyResponse(downstreamPeerId, originalMessage.id,
        JSON.stringify({ error: 'Failed to forward upstream' }), 502, 'application/json');
    }
  }

  /**
   * Get the upstream peer (host or upstream relay)
   */
  private getUpstreamPeer(): PeerConnectionState | undefined {
    // If we know our upstream peer ID, use that
    if (this.upstreamPeerId) {
      const upstream = this.peers.get(this.upstreamPeerId);
      if (upstream?.state === 'connected') return upstream;
    }
    // Otherwise find any upstream peer
    return Array.from(this.peers.values()).find(
      p => p.direction === 'upstream' && p.state === 'connected' && p.dataChannel?.readyState === 'open'
    );
  }

  /**
   * Handle incoming chunk — reassemble into full message
   */
  private handleChunk(peerId: string, chunk: { chunkId: string; index: number; total: number; data: string }) {
    const key = chunk.chunkId;
    if (!this.chunkBuffers.has(key)) {
      this.chunkBuffers.set(key, { chunks: new Array(chunk.total), total: chunk.total });
    }

    const buffer = this.chunkBuffers.get(key)!;
    buffer.chunks[chunk.index] = chunk.data;

    const received = buffer.chunks.filter(c => c !== undefined).length;
    if (received === buffer.total) {
      const fullData = buffer.chunks.join('');
      this.chunkBuffers.delete(key);

      try {
        const message = JSON.parse(fullData);
        this.handleDataMessage(peerId, message);
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

      // Find upstream peer (host or relay)
      const upstream = this.getUpstreamPeer() || Array.from(this.peers.values()).find(
        p => p.state === 'connected' && p.dataChannel?.readyState === 'open'
      );

      if (!upstream || !upstream.dataChannel) {
        reject(new Error('No connected upstream peer'));
        return;
      }

      const message = JSON.stringify({ type: 'FETCH_REQUEST', id: requestId, url });

      try {
        this.sendChunked(upstream.dataChannel, upstream.peerId, message);
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

  sendProxyResponse(peerId: string, requestId: string, body: string, status: number, contentType: string) {
    const state = this.peers.get(peerId);
    if (!state?.dataChannel || state.dataChannel.readyState !== 'open') {
      console.warn(`Cannot send response to ${peerId} - channel not open`);
      return;
    }

    const message = JSON.stringify({ type: 'FETCH_RESPONSE', id: requestId, body, status, contentType });

    try {
      this.sendChunked(state.dataChannel, peerId, message);
    } catch (e) {
      console.error(`Failed to send proxy response to ${peerId}:`, e);
    }
  }

  /**
   * Get list of downstream (client) peers for relay/host
   */
  getDownstreamPeers(): PeerConnectionState[] {
    return Array.from(this.peers.values()).filter(p => p.direction === 'downstream');
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
