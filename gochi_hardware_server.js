import express from "express";
import { SerialPort, ReadlineParser } from "serialport";
import { WebSocketServer } from "ws";

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

    // --- WebSocket server ---
    const server = app.listen(httpPort, () => {
        console.log(`🚀 Portal open: http://localhost:${httpPort}`);
    });

    wss = new WebSocketServer({ server });

    // Forward serial → WebSocket
    parser.on("data", (line) => {
        console.log("📥 Serial received:", line);
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
