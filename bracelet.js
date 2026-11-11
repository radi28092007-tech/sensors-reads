"use strict";

const UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

const PACKET_SIZE = 11; // will change later

// This is the endpoint confirmed working in your terminal.
const SENSOR_URL = "/api/sensors";

const connectButton = document.getElementById("connect-bracelet");
const disconnectButton = document.getElementById("disconnect-bracelet");
const allowTestCheckbox = document.getElementById("allow-bracelet-test");
const statusElement = document.getElementById("bracelet-status");

let braceletDevice = null;
let txCharacteristic = null;
let pendingBytes = new Uint8Array(0);
let connecting = false;

function setBraceletStatus(message) {
  statusElement.textContent = message;
}

function updateButtons() {
  const connected = Boolean(braceletDevice?.gatt?.connected);
  connectButton.disabled = connecting || connected;
  disconnectButton.disabled = !connected;
}

function resetConnection() {
  if (txCharacteristic) {
    txCharacteristic.removeEventListener(
      "characteristicvaluechanged",
      receiveReading
    );
  }

  txCharacteristic = null;
  pendingBytes = new Uint8Array(0);
  updateButtons();
}

function onBraceletDisconnected() {
  resetConnection();
  setBraceletStatus("Bracelet disconnected.");
}

async function connectBracelet() {
  if (!window.isSecureContext || !navigator.bluetooth) {
    setBraceletStatus(
      "Bluetooth requires a supported browser and localhost or HTTPS. " +
      "Try desktop Chrome or Edge."
    );
    return;
  }

  connecting = true;
  updateButtons();

  try {
    setBraceletStatus("Choose your bracelet in the Bluetooth dialog.");

    braceletDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UART_SERVICE] }]
    });

    braceletDevice.addEventListener(
      "gattserverdisconnected",
      onBraceletDisconnected
    );

    const server = await braceletDevice.gatt.connect();
    const service = await server.getPrimaryService(UART_SERVICE);

    txCharacteristic = await service.getCharacteristic(UART_TX);
    pendingBytes = new Uint8Array(0);

    txCharacteristic.addEventListener(
      "characteristicvaluechanged",
      receiveReading
    );

    await txCharacteristic.startNotifications();

    setBraceletStatus(
      "Bracelet connected. Start a dashboard session to save readings."
    );
  } catch (error) {
    console.error("Bluetooth connection failed:", error);

    if (braceletDevice?.gatt?.connected) {
      braceletDevice.gatt.disconnect();
    }

    resetConnection();
    setBraceletStatus(`Connection failed: ${error.message}`);
  } finally {
    connecting = false;
    updateButtons();
  }
}

function disconnectBracelet() {
  if (braceletDevice?.gatt?.connected) {
    braceletDevice.gatt.disconnect();
  }
}

// Receives raw BLE bytes. Buffering supports fragmented notifications
// and notifications containing multiple packets.
function receiveReading(event) {
  const value = event.target.value;

  const incoming = new Uint8Array(
    value.buffer,
    value.byteOffset,
    value.byteLength
  );

  const combined = new Uint8Array(
    pendingBytes.length + incoming.length
  );

  combined.set(pendingBytes);
  combined.set(incoming, pendingBytes.length);
  pendingBytes = combined;

  while (pendingBytes.length >= PACKET_SIZE) {
    const packet = pendingBytes.slice(0, PACKET_SIZE);
    pendingBytes = pendingBytes.slice(PACKET_SIZE);

    const view = new DataView(
      packet.buffer,
      packet.byteOffset,
      packet.byteLength
    );

    // Matches Python struct.Struct("<IIBBB").
    const reading = {
      sequence: view.getUint32(0, true),
      uptimeMs: view.getUint32(4, true),
      heartBpm: view.getUint8(8),
      battery: view.getUint8(9),
      flags: view.getUint8(10),
      receivedAt: Date.now() / 1000
    };

    console.log("Bracelet reading:", reading);
    void sendReading(reading);
  }
}

async function sendReading(reading) {
  const { sequence, heartBpm, flags, receivedAt } = reading;

  // Current protocol: 0 = normal, 1 = test, 2 = error.
  if (![0, 1, 2].includes(flags)) {
    setBraceletStatus(`Skipped unknown flags: ${flags}`);
    return;
  }

  if (flags === 2) {
    setBraceletStatus("Skipped a device error reading.");
    return;
  }

  if (flags === 1 && !allowTestCheckbox.checked) {
    setBraceletStatus(
      "Test reading skipped. Enable simulated readings for demo testing."
    );
    return;
  }

  if (heartBpm < 30 || heartBpm > 220) {
    setBraceletStatus(`Skipped invalid heart rate: ${heartBpm}`);
    return;
  }

  try {
    const response = await fetch(SENSOR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        readings: [
          {
            type: "heart_rate",
            value: heartBpm,
            ts: receivedAt
          }
        ]
      })
    });

    if (response.status === 409) {
      setBraceletStatus(
        "Bracelet connected. Start a session in the dashboard first."
      );
      return;
    }

    if (response.status !== 201) {
      const body = await response.text();
      console.error("Backend rejected reading:", response.status, body);

      setBraceletStatus(
        `Reading not saved: HTTP ${response.status}. See browser console.`
      );
      return;
    }

    const label = flags === 1 ? "SIMULATED" : "Device";

    setBraceletStatus(
      `${label} reading saved: ${heartBpm} BPM — sequence ${sequence}`
    );
  } catch (error) {
    console.error("Saving bracelet reading failed:", error);
    setBraceletStatus(
      "Could not reach Flask. Check that the backend is running."
    );
  }
}

connectButton.addEventListener("click", connectBracelet);
disconnectButton.addEventListener("click", disconnectBracelet);
updateButtons();