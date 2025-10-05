import express from "express";
import { SerialPort, ReadlineParser } from "serialport";
import { WebSocketServer } from "ws";

// Global handles
let port, parser, wss;

/**
 * Opens the portal (HTTP + WebSocket + Serial connection).
 * @param {object} config
 * @param {string} config.serialPath - Serial device path (e.g., COM3 or /dev/ttyUSB0)
 * @param {number} config.baudRate - Baud rate (e.g., 115200)
 * @param {number} config.httpPort - HTTP server port (e.g., 3000)
 */
export function openPortal({ serialPath, baudRate = 115200, httpPort = 3000 }) {
  const app = express();

  // --- Serial setup ---
  port = new SerialPort({
    path: serialPath,
    baudRate,
  });
  parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

  // --- HTTP + WebSocket Server ---
  const server = app.listen(httpPort, () => {
    console.log(`🚀 Portal open: http://localhost:${httpPort}`);
  });

  wss = new WebSocketServer({ server });

  // =====================================================
  // 🌿 SMART SERIAL HANDLER (Your requested addition)
  // =====================================================
  let currentPlant = null;

  parser.on("data", async (line) => {
    line = line.trim();
    if (line === "") return;

    console.log("📥 Serial received:", line);

    try {
      const json = JSON.parse(line);

      // ✅ New plant selection
      if (json.plant_id) {
        currentPlant = {
          name: json.plant,
          id: json.plant_id,
        };

        console.log(`✅ New plant selected: ${json.plant}`);

        // 🌱 Fetch data from the Plant Server (localhost:3001)
        try {
          const response = await fetch(`http://localhost:3001/set_plant?plant_id=${json.plant_id}`);
          const plantData = await response.json();
          console.log("🌿 Plant data loaded from API:", plantData);
        } catch (err) {
          console.error("❌ Failed to fetch from plant server:", err.message);
        }
      }

      // 🌡️ Sensor update
      if (json.temperature !== undefined) {
        console.log(`📊 Sensor update: ${json.temperature}°C, ${json.soil}% moisture, mood: ${json.mood}`);
        // You could broadcast this to WebSocket clients too
        wss.clients.forEach((client) => {
          if (client.readyState === 1) client.send(JSON.stringify(json));
        });
      }
    } catch (e) {
      console.log("⚠️ Not JSON or parse error:", line);
    }
  });

  // =====================================================
  // 🔄 SERIAL ↔ WEBSOCKET CONNECTION BRIDGE
  // =====================================================

  // Forward serial → WebSocket
  parser.on("data", (line) => {
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(line);
      }
    });
  });

  // Forward WebSocket → Serial
  wss.on("connection", (ws) => {
    console.log("🔗 WebSocket client connected");
    ws.on("message", (msg) => {
      console.log("📤 WS to Serial:", msg.toString());
      port.write(msg.toString() + "\n");
    });
  });
}

/**
 * Send a string over Serial (to ESP32).
 * @param {string} data
 */
export function sendData(data) {
  if (!port) throw new Error("Serial port not initialized. Call openPortal() first.");
  console.log("➡️ Sending to serial:", data);
  port.write(data + "\n");
}

/**
 * Subscribe to incoming Serial data.
 * @param {(line: string) => void} callback - Function to handle incoming data
 */
export function onData(callback) {
  if (!parser) throw new Error("Serial parser not initialized. Call openPortal() first.");
  parser.on("data", callback);
}
