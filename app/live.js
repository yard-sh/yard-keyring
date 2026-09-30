// Keyring realtime client: one socket, to the property on screen.
//
// Every close is expected. Yard closes a WebSocket session after 24 hours
// (code 1000, "Session limit reached"), `yard dev` restarts the runtime on
// every save, and networks drop, so the only correct client is one that
// always reconnects, except when the property says there is nothing to come
// back to:
//   4002 deleted · 4003 removed      stop, and say so
//   4004 access changed              reconnect now, with fresh access
//   4001 full · anything else        back off, check access, reconnect
//
// A refused upgrade reaches the browser with no reason attached, so before
// reconnecting after a failure the client asks GET api/properties/:id: a 404
// means access is gone and it stops.
//
// Events are hints ("the ledger changed"), except comments and typing, which
// carry what to show. After any (re)connect the server says hello and the
// view re-fetches, which is also how it catches up on anything it missed.

import { api } from "./api.js";

const RETRY_MIN = 500;
const RETRY_MAX = 8000;
const TYPING_EVERY = 2500;

export function createLive({ onEvent, onStatus, onStop }) {
  let propertyId = null;
  let ws = null;
  let timer = 0;
  let retry = RETRY_MIN;
  let generation = 0;
  let lastTyping = 0;

  // Built relative to the page: the app can be mounted under any path and a
  // sandbox adds a segment, so a root-absolute URL would break both.
  function socketURL(id) {
    const url = new URL("api/properties/" + id + "/ws", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.hash = "";
    return url.href;
  }

  function status(value) {
    if (onStatus) onStatus(value);
  }

  function follow(id) {
    if (id === propertyId) return;
    stop();
    propertyId = id || null;
    if (propertyId) open(generation);
  }

  function stop() {
    generation += 1;
    clearTimeout(timer);
    timer = 0;
    retry = RETRY_MIN;
    const socket = ws;
    ws = null;
    propertyId = null;
    if (socket) {
      try {
        socket.close(1000, "leaving");
      } catch {
        // Already gone.
      }
    }
    status("idle");
  }

  function open(gen) {
    if (gen !== generation || !propertyId) return;
    let socket;
    try {
      socket = new WebSocket(socketURL(propertyId));
    } catch {
      return later(gen, true);
    }
    ws = socket;
    status("connecting");

    socket.onopen = () => {
      if (ws !== socket) return;
      retry = RETRY_MIN;
      status("open");
    };

    socket.onmessage = (e) => {
      if (ws !== socket) return;
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (event && event.t) onEvent(event);
    };

    socket.onclose = (e) => {
      if (ws !== socket) return;
      ws = null;
      status("closed");
      if (e.code === 4002 || e.code === 4003) {
        const id = propertyId;
        propertyId = null;
        return onStop(e.code === 4002 ? "deleted" : "removed", id);
      }
      if (e.code === 4004 || (e.code === 1000 && e.reason === "Session limit reached")) {
        retry = RETRY_MIN;
        return later(gen, false, 0);
      }
      later(gen, true);
    };

    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    };
  }

  // Wait, then (after a failure) make sure there is still something to
  // connect to, then connect.
  function later(gen, probe, wait) {
    clearTimeout(timer);
    const delay = wait === undefined ? retry + Math.random() * 250 : wait;
    retry = Math.min(RETRY_MAX, Math.round(retry * 1.8));
    timer = setTimeout(async () => {
      if (gen !== generation || !propertyId) return;
      if (probe) {
        try {
          await api("api/properties/" + propertyId);
        } catch (err) {
          if (gen !== generation) return;
          if (err.status === 404) {
            const id = propertyId;
            propertyId = null;
            return onStop("removed", id);
          }
          if (err.status === 401) return location.reload();
          return later(gen, true); // offline: keep trying
        }
      }
      open(gen);
    }, delay);
  }

  // Throttled: someone typing a long comment sends a frame every 2.5 s.
  function typing(ticketId, leaseId) {
    const now = Date.now();
    if (!ws || ws.readyState !== WebSocket.OPEN || now - lastTyping < TYPING_EVERY) return;
    lastTyping = now;
    try {
      ws.send(JSON.stringify({ t: "typing", ticket_id: ticketId, lease_id: leaseId }));
    } catch {
      // Closing; the next keystroke tries again.
    }
  }

  // After joining a lease: the socket's access was fixed when it connected.
  function reconnect() {
    const id = propertyId;
    stop();
    follow(id);
  }

  window.addEventListener("beforeunload", stop);

  return {
    follow,
    typing,
    reconnect,
    get propertyId() {
      return propertyId;
    },
  };
}
