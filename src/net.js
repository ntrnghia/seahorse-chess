// PeerJS wrapper for room-based PVP. Loads the lib from CDN on demand.
// Exposes a tiny event/connection API consumed by lobby.js and main.js.

let peer = null;
let role = null;        // 'host' | 'guest' | null
let roomId = null;
let hostConn = null;    // guest-side: connection to host
const handlers = {};

export function on(type, fn) {
  (handlers[type] ||= []).push(fn);
  return () => {
    const arr = handlers[type] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
}
function emit(type, ...args) {
  (handlers[type] || []).forEach(fn => { try { fn(...args); } catch (e) { console.error(e); } });
}

function loadPeerLib() {
  return new Promise((resolve, reject) => {
    if (window.Peer) return resolve();
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load PeerJS from CDN.'));
    document.head.appendChild(s);
  });
}

function peerIdFor(rid) { return `seahorse-chess-${rid}`; }

export async function createRoom() {
  await loadPeerLib();
  // 9-digit numeric ID, leading digit 1-9.
  roomId = String(Math.floor(100000000 + Math.random() * 900000000));
  role = 'host';
  return new Promise((resolve, reject) => {
    peer = new window.Peer(peerIdFor(roomId));
    let opened = false;
    peer.on('open', () => { opened = true; resolve({ roomId }); });
    peer.on('error', (e) => {
      if (!opened) reject(e); else emit('error', e);
    });
    peer.on('connection', (conn) => {
      conn.on('open', () => emit('peerConnected', conn));
      conn.on('data', (data) => emit('message', conn, data));
      conn.on('close', () => emit('peerDisconnected', conn));
    });
  });
}

export async function joinRoom(rid) {
  await loadPeerLib();
  roomId = String(rid);
  role = 'guest';
  return new Promise((resolve, reject) => {
    peer = new window.Peer();
    let opened = false;
    peer.on('open', () => {
      const conn = peer.connect(peerIdFor(roomId), { reliable: true });
      hostConn = conn;
      const timer = setTimeout(() => {
        if (!opened) reject(new Error('Could not reach the host. Check the room code.'));
      }, 10000);
      conn.on('open', () => {
        opened = true;
        clearTimeout(timer);
        resolve({ roomId, conn });
      });
      conn.on('data', (data) => emit('message', conn, data));
      conn.on('close', () => emit('hostDisconnected'));
      conn.on('error', (e) => { if (!opened) { clearTimeout(timer); reject(e); } else emit('error', e); });
    });
    peer.on('error', (e) => { if (!opened) reject(e); else emit('error', e); });
  });
}

export function sendToHost(msg) {
  if (hostConn && hostConn.open) hostConn.send(msg);
}

export function getRole() { return role; }
export function getRoomId() { return roomId; }

export function disconnect() {
  try { if (peer) peer.destroy(); } catch {}
  peer = null; role = null; roomId = null; hostConn = null;
}
