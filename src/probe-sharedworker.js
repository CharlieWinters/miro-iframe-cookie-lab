/**
 * SharedWorker relay for the embed↔app channel probe.
 *
 * A SharedWorker is the only one of the four channels that gives you a single
 * stateful coordinator rather than a broadcast: every same-origin context in
 * the same storage partition connects to ONE instance of this script. That
 * matters if an app surface ever needs to hold a buffer (say, terminal
 * scrollback) that several frames read from.
 *
 * It just fans every message out to all other connected ports.
 */

const ports = [];

self.addEventListener('connect', (event) => {
  const port = event.ports[0];
  ports.push(port);
  port.start();
  port.addEventListener('message', (msg) => {
    for (const other of ports) {
      if (other === port) continue;
      try {
        other.postMessage(msg.data);
      } catch (e) {
        /* port is gone */
      }
    }
  });
  port.postMessage({ type: 'clab-probe:worker-ready', ports: ports.length });
});
