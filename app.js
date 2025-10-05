import express from 'express';
import axios from 'axios';
import * as dotenv from 'dotenv';
import admin from 'firebase-admin';
import {GoogleGenAI} from '@google/genai';
import sharp from 'sharp';
import fs from 'fs';
import {SerialPort, ReadlineParser} from "serialport";

// --- 1. Environment & Initialization ---
dotenv.config();

const ZYLALABS_API_KEY = process.env.ZYLALABS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const FIREBASE_SERVICE_ACCOUNT_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

if (!ZYLALABS_API_KEY || !GEMINI_API_KEY || !FIREBASE_SERVICE_ACCOUNT_PATH) {
    console.error("Missing required environment variables.");
    process.exit(1);
}

// Initialize Firebase Admin
try {
    const serviceAccount = JSON.parse(
        // Read service account from file system synchronously (for app init)
        fs.readFileSync(FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8')
    );
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (error) {
    console.error("Firebase initialization failed:", error.message);
    process.exit(1);
}

const plants_db = admin.firestore().collection('plants');
const ai = new GoogleGenAI({apiKey: GEMINI_API_KEY});
const app = express();
const PORT = 3001;


let port, parser;

let pin_code_sent = false;

/**
 * Gets a document from the plants_db collection by ID.
 * @param {string} doc_id The ID of the document.
 * @returns {Promise<FirebaseFirestore.DocumentData | undefined>} The document data or undefined if not found.
 */
async function getDoc(doc_id) {
    const docRef = plants_db.doc(doc_id);
    const docSnapshot = await docRef.get();
    return docSnapshot.exists ? docSnapshot.data() : undefined;
}

/**
 * Updates fields in an existing document.
 * @param {string} doc_id The ID of the document to update.
 * @param {object} updatesObject The fields to update.
 * @returns {Promise<void>}
 */
async function updateDoc(doc_id, updatesObject) {
    await plants_db.doc(doc_id).update(updatesObject);
}

/**
 * Sets a document with a specific ID, overwriting any existing data.
 * @param {string} id The ID for the new document.
 * @param {object} object The data to set.
 * @returns {Promise<void>}
 */
async function setDoc(id, object) {
    await plants_db.doc(id).set(object);
}

export function sendDataToHardware(data) {
    if (!port) throw new Error("Serial port not initialized. Call openPortal() first.");
    console.log("➡️ Sending to serial:", data);
    port.write(data + "\n");
}



/**
 * Fetches a single numerical value from the Gemini API based on a prompt.
 * @param {string} prompt The detailed prompt for the AI model.
 * @returns {Promise<number>} The numerical value returned by the AI.
 */
async function get_from_gemini(prompt) {
    try {
        // Use a powerful model for accurate, focused data extraction
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                // Try to force a numerical response for easier parsing
                responseMimeType: "application/json",
                responseSchema: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number",
                            description: "The exact numerical value extracted from the plant data."
                        }
                    }
                }
            }
        });

        const jsonText = response.text.trim();
        const jsonResponse = JSON.parse(jsonText);
        return jsonResponse.value;

    } catch (error) {
        console.error("Gemini API call failed:", error.message);
        // Return a default error value to continue execution
        return -1;
    }
}

/**
 * Main function to fetch, process, and save plant data, and update hardware.
 * @param plant_object
 */
async function set_plant(plant_object) {
    let plant_data = await getDoc(plant_object.plant_id.toString());
    const code = Math.floor(1000 + Math.random() * 9000);

    await updateDoc(plant_object.plant_id, {auth_code: code})

    port.write(code);

}

// Start the Express server
app.listen(PORT, () => {
    console.log(`🌿 Plant Server running on http://localhost:${PORT}`);
});


/**
 * Listens to a specific Firestore document for changes.
 * When changes occur, analyzes the plant’s condition using AI and updates its state.
 * @param {string} docId - The Firestore document ID to listen to.
 */
export function listenToPlantDocument(docId) {
    const docRef = plants_db.doc(docId);

    docRef.onSnapshot(async (snapshot) => {
        if (!snapshot.exists) {
            console.log(`⚠️ Document ${docId} not found.`);
            return;
        }

        const data = snapshot.data();
        console.log(`👂 Detected change in ${docId}`);

        try {
            // --- 1️⃣ Construct AI prompt for plant "voice" description ---
            const descriptionPrompt = `
You are ${data.name} (${data.scientific_name}), a plant that speaks in its own unique personality.
Your job is to describe, in a single short paragraph, how you currently feel based on these sensor readings:
- Current temperature: ${data.temperature}°C (ideal: ${data.ideal_temperature}°C)
- Current humidity: ${data.humidity}% (ideal: ${data.ideal_humidity}%)
- Current light exposure: ${data.light_exposure} lux (ideal: ${data.ideal_light_exposure} lux)
- Current soil moisture: ${data.soil_moisture} (ideal: ${data.ideal_moisture})
Speak as if you are the plant itself — friendly, vivid, and emotionally expressive.
Return only the description, as if it were your own words.`;

            // --- 2️⃣ Generate AI "voice" description ---
            const voiceResponse = await ai.models.generateContent({
                model: "gemini-2.0-flash",
                contents: [{ role: "user", parts: [{ text: descriptionPrompt }] }],
            });
            const voiceText = voiceResponse?.response?.text?.trim() || "I'm feeling quiet today.";

            // --- 3️⃣ Construct prompt for mood index (0-3) ---
            const moodPrompt = `
Given this plant data:
Temperature: ${data.temperature}°C (ideal ${data.ideal_temperature})
Humidity: ${data.humidity}% (ideal ${data.ideal_humidity})
Light: ${data.light_exposure} lux (ideal ${data.ideal_light_exposure})
Soil Moisture: ${data.soil_moisture} (ideal ${data.ideal_moisture})

Return a number between 0 and 3 representing how the plant feels:
0 = depressed/sick, 1 = bored, 2 = normal, 3 = happy.
Respond **only** with the number (no text).`;

            // --- 4️⃣ Use your existing numeric AI helper ---
            const moodIndex = await get_from_gemini(moodPrompt);

            // --- 5️⃣ Update Firestore with new description and mood ---
            await updateDoc(docId, {
                current_state: moodIndex,
                description: voiceText,
                last_updated: admin.firestore.FieldValue.serverTimestamp(),
            });

            console.log(`🪴 Updated ${docId} → state=${moodIndex}`);
            if (port) port.write(String(moodIndex) + "\n");

        } catch (err) {
            console.error("🔥 Error processing plant update:", err.message);
        }
    });
}

async function openPortal() {
    const _app = express();

    port = new SerialPort({
        path: "/dev/tty.usbserial-0001",
        baudRate: 115200
    });

    parser = port.pipe(new ReadlineParser({delimiter: "END"}));


    parser.on('data', (completeMessage) => {
        console.log(completeMessage)

        try {
            const data = JSON.parse(completeMessage);
            if (completeMessage && pin_code_sent) {
                set_plant(data);
                pin_code_sent = true
            }
            updateDoc(data.plant_id, {
                    temperature: data.temperature,
                    humidity: data.humidity,
                    light_exposure: data.light_exposure,
                    soil_moisture: data.soil_moisture,
            })


        } catch (err) {

        }


    });

}

openPortal();