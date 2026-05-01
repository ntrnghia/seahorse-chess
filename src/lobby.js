// Lobby + room management. Used by main.js to gate the game start.
//
// Three flows:
//   - solo:  no PeerJS — playerConfig is built directly from the existing setup screen.
//   - host:  creates a 9-digit room, listens for guests, manages slots (A/B/C/D),
//            adds/removes bots, can kick, and starts the game.
//   - guest: joins a room by code; receives ROOM updates; can claim/leave slots;
//            waits for host to send START and STATE messages.

import { FACTION_INFO, FACTIONS } from './board.js';
import * as net from './net.js';

const NAME_KEY = 'shc.name';

export function getSavedName() { return localStorage.getItem(NAME_KEY) || ''; }
export function setSavedName(n) { localStorage.setItem(NAME_KEY, String(n).trim().slice(0, 20)); }

// Slot value shape:  null  |  { kind:'human', name, peerId? }  |  { kind:'bot', name }
function emptyRoomState() {
  return { id: null, hostName: null, slots: { A: null, B: null, C: null, D: null }, started: false };
}

let roomState = emptyRoomState();
let role = null;                  // 'host' | 'guest'
let myFaction = null;             // local user's claimed faction (null = spectating)
let myName = '';
let hostConnByPeer = new Map();   // host: peerId -> conn (every connected guest)
let hostPeerByFaction = {};       // host: faction -> peerId (only for human-claimed slots)
const handlers = {};

export function on(type, fn) { (handlers[type] ||= []).push(fn); }
function emit(type, ...args) { (handlers[type] || []).forEach(fn => fn(...args)); }

export function getRoomState() { return roomState; }
export function getRole() { return role; }
export function getMyFaction() { return myFaction; }
export function getMyName() { return myName; }
export function getInviteUrl() {
  if (!roomState.id) return '';
  const u = new URL(window.location.href);
  u.search = `?room=${roomState.id}`;
  u.hash = '';
  return u.toString();
}

// ---------- Host ----------
export async function hostCreateRoom(name) {
  myName = name;
  setSavedName(name);
  role = 'host';
  const { roomId } = await net.createRoom();
  roomState = emptyRoomState();
  roomState.id = roomId;
  roomState.hostName = name;
  // Host claims slot A by default.
  myFaction = 'A';
  roomState.slots.A = { kind: 'human', name, peerId: null /* local */ };

  net.on('peerConnected', (conn) => {
    hostConnByPeer.set(conn.peer, conn);
    // Send current room state immediately; guest will then HELLO to register name.
    sendRoomTo(conn);
  });
  net.on('peerDisconnected', (conn) => {
    const fac = factionForPeer(conn.peer);
    if (fac) {
      roomState.slots[fac] = null;
      delete hostPeerByFaction[fac];
    }
    hostConnByPeer.delete(conn.peer);
    broadcastRoom();
    emit('roomChanged', roomState);
  });
  net.on('message', (conn, data) => handleHostMessage(conn, data));

  emit('roomChanged', roomState);
  return roomState;
}

function handleHostMessage(conn, data) {
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    case 'HELLO': {
      // Guest registers name; do not auto-claim, just store on the conn.
      conn._guestName = String(data.name || 'Player').slice(0, 20);
      sendRoomTo(conn);
      break;
    }
    case 'CLAIM_SLOT': {
      const f = data.faction;
      if (!FACTIONS.includes(f)) return;
      if (roomState.slots[f] != null) return;          // taken
      // Free any previous slot owned by this peer.
      for (const x of FACTIONS) {
        const s = roomState.slots[x];
        if (s && s.kind === 'human' && s.peerId === conn.peer) {
          roomState.slots[x] = null;
          delete hostPeerByFaction[x];
        }
      }
      roomState.slots[f] = { kind: 'human', name: conn._guestName || 'Player', peerId: conn.peer };
      hostPeerByFaction[f] = conn.peer;
      broadcastRoom();
      emit('roomChanged', roomState);
      break;
    }
    case 'LEAVE_SLOT': {
      const f = factionForPeer(conn.peer);
      if (f) {
        roomState.slots[f] = null;
        delete hostPeerByFaction[f];
        broadcastRoom();
        emit('roomChanged', roomState);
      }
      break;
    }
    case 'ACTION': {
      // Forwarded to game layer via main.js
      const f = factionForPeer(conn.peer);
      if (!f) return;
      emit('remoteAction', f, data.payload);
      break;
    }
  }
}

function factionForPeer(peerId) {
  for (const f of FACTIONS) {
    const s = roomState.slots[f];
    if (s && s.kind === 'human' && s.peerId === peerId) return f;
  }
  return null;
}

function sendRoomTo(conn) {
  if (!conn || !conn.open) return;
  conn.send({ type: 'ROOM', payload: serializeRoom() });
}
function serializeRoom() {
  // Deep-clone-ish; do not leak peerIds to clients.
  const slots = {};
  for (const f of FACTIONS) {
    const s = roomState.slots[f];
    slots[f] = s ? { kind: s.kind, name: s.name, isHost: s.kind === 'human' && !s.peerId } : null;
  }
  return { id: roomState.id, hostName: roomState.hostName, slots, started: roomState.started };
}
function broadcastRoom() {
  const payload = { type: 'ROOM', payload: serializeRoom() };
  for (const conn of hostConnByPeer.values()) {
    if (conn.open) conn.send(payload);
  }
}

// Host actions (UI buttons call these). Re-broadcast after each.
export function hostAddBot(faction) {
  if (role !== 'host') return;
  if (roomState.slots[faction] != null) return;
  const idx = FACTIONS.indexOf(faction);
  const names = ['Aria-Bot', 'Bjorn-Bot', 'Cleo-Bot', 'Darius-Bot'];
  roomState.slots[faction] = { kind: 'bot', name: names[idx] || `Bot-${faction}` };
  broadcastRoom();
  emit('roomChanged', roomState);
}
export function hostRemoveSlot(faction) {
  if (role !== 'host') return;
  const s = roomState.slots[faction];
  if (!s) return;
  // Cannot kick yourself this way (use leave from your own UI).
  if (s.kind === 'human' && !s.peerId) return;
  // If kicking a remote human, close their conn so they go back to lobby.
  if (s.kind === 'human' && s.peerId) {
    const conn = hostConnByPeer.get(s.peerId);
    if (conn && conn.open) {
      try { conn.send({ type: 'KICKED' }); } catch {}
      try { conn.close(); } catch {}
    }
    delete hostPeerByFaction[faction];
  }
  roomState.slots[faction] = null;
  broadcastRoom();
  emit('roomChanged', roomState);
}
export function hostClaimSlot(faction) {
  if (role !== 'host') return;
  if (roomState.slots[faction] != null) return;
  // Free old host slot
  for (const x of FACTIONS) {
    const s = roomState.slots[x];
    if (s && s.kind === 'human' && !s.peerId) roomState.slots[x] = null;
  }
  roomState.slots[faction] = { kind: 'human', name: myName, peerId: null };
  myFaction = faction;
  broadcastRoom();
  emit('roomChanged', roomState);
}
export function hostStart() {
  if (role !== 'host') return;
  // Require all 4 slots filled and at least one human.
  const filled = FACTIONS.every(f => roomState.slots[f] != null);
  const anyHuman = FACTIONS.some(f => roomState.slots[f] && roomState.slots[f].kind === 'human');
  if (!filled || !anyHuman) return;
  roomState.started = true;
  broadcastRoom();
  for (const conn of hostConnByPeer.values()) {
    if (conn.open) conn.send({ type: 'START' });
  }
  emit('start', roomState);
}
export function hostGetConnByFaction(f) {
  const peerId = hostPeerByFaction[f];
  return peerId ? hostConnByPeer.get(peerId) : null;
}

// ---------- Guest ----------
export async function guestJoinRoom(name, roomId) {
  myName = name;
  setSavedName(name);
  role = 'guest';
  const { conn } = await net.joinRoom(roomId);
  // Send HELLO so host learns our name.
  conn.send({ type: 'HELLO', name });
  roomState = emptyRoomState();
  roomState.id = roomId;
  net.on('message', (_c, data) => handleGuestMessage(data));
  net.on('hostDisconnected', () => emit('hostLost'));
  emit('roomChanged', roomState);
}

function handleGuestMessage(data) {
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    case 'ROOM': {
      const p = data.payload;
      roomState = { id: p.id, hostName: p.hostName, slots: p.slots, started: p.started };
      // Recompute my faction by name match (peerId not exposed)
      myFaction = null;
      for (const f of FACTIONS) {
        const s = roomState.slots[f];
        if (s && s.kind === 'human' && !s.isHost && s.name === myName) {
          myFaction = f;
          break;
        }
      }
      emit('roomChanged', roomState);
      break;
    }
    case 'START':
      emit('start', roomState);
      break;
    case 'KICKED':
      emit('kicked');
      break;
    case 'STATE':
      emit('state', data.payload);
      break;
  }
}

export function guestClaim(faction) {
  net.sendToHost({ type: 'CLAIM_SLOT', faction });
}
export function guestLeave() {
  net.sendToHost({ type: 'LEAVE_SLOT' });
}
export function sendActionToHost(payload) {
  net.sendToHost({ type: 'ACTION', payload });
}
