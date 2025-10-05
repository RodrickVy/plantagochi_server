import express from 'express';
import axios from 'axios';
import * as dotenv from 'dotenv';
import admin from 'firebase-admin';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import fs from 'fs';
import { openPortal, sendData } from './gochi_hardware_server.js'; // Assuming this file is in the same directory

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
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const app = express();
const PORT = 3001;

// Initialize Hardware Portal
try {
    openPortal({
        serialPath: "/dev/tty.usbserial-0001",
        baudRate: 115200,
        httpPort: 3000,
    });
    console.log('Hardware portal initialized on port 3000');
} catch (error) {
    console.error("Failed to open hardware portal:", error.message);
}


// --- 2. Firebase Helper Functions ---

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


// --- 3. External Data Helper Functions ---

/**
 * Fetches plant data from the House Plants Database API.
 * @param {string} id The plant ID to fetch.
 * @returns {Promise<object>} The plant data object.
 */
async function get_plant_data(id) {
    const url = `https://zylalabs.com/api/774/house+plants+database+api/510/${id}`;
    const headers = { 'Authorization': `Bearer ${ZYLALABS_API_KEY}` };
    try {
        const response = await axios.get(url, { headers });
        return response.data;
    } catch (error) {
        console.error(`Error fetching plant data for ID ${id}:`, error.message);
        throw new Error("Failed to fetch plant data from external API.");
    }
}

/**
 * Fetches raw HTML content from a given URL using Axios.
 * @param {string} url The URL to fetch.
 * @returns {Promise<string>} The raw HTML string.
 */
async function get_html_from_url(url) {
    try {
        const response = await axios.get(url);
        return response.data; // Raw HTML string
    } catch (error) {
        console.error(`Error fetching HTML from ${url}:`, error.message);
        // Return an empty string or error message to avoid app crash
        return `ERROR: Could not fetch HTML from ${url}`;
    }
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
 * Generates a one-bit bitmap string for a QR code.
 * @param {string} url The URL to encode in the QR code.
 * @returns {Promise<string>} The one-bit bitmap hex string.
 */
async function generateQrHexString(url) {
    try {
        const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=128x128&data=${encodeURIComponent(url)}`;
        // Fetch QR code image as array buffer
        const response = await axios.get(apiUrl, { responseType: "arraybuffer" });
        const buffer = Buffer.from(response.data);

        // Process image with sharp: resize, convert to 1-bit monochrome (threshold)
        const { data, info } = await sharp(buffer)
            .resize(128, 128, { fit: "contain" })
            .threshold(128) // Convert to black (0) and white (255)
            .raw()
            .toBuffer({ resolveWithObject: true });

        const width = info.width;
        const height = info.height;
        let bytes = [];
        // Convert raw 1-bit data buffer to a compact byte array string
        for (let y = 0; y < height; y++) {
            let byte = 0;
            for (let x = 0; x < width; x++) {
                const pixel = data[y * width + x];
                // Pixels are 0 (black) or 255 (white) after threshold. Black is foreground.
                if (pixel === 0) {
                    byte |= 1 << (7 - (x % 8)); // Set bit for black pixel
                }
                if (x % 8 === 7 || x === width - 1) { // End of a byte or end of line
                    bytes.push(byte);
                    byte = 0;
                }
            }
            // If the line width is not a multiple of 8, push the last, partial byte
            if (width % 8 !== 0 && (width - 1) % 8 !== 7) {
                // Push the partially filled byte only if it hasn't been pushed already
                // The check 'x === width - 1' handles the last byte.
            }
        }

        // Convert the byte array to a comma-separated hex string (e.g., "0x00, 0xFF, ...")
        return bytes.map(b => `0x${b.toString(16).padStart(2, "0")}`).join(", ");
    } catch (err) {
        console.error("Error generating QR code:", err.message);
        return "";
    }
}


// --- 4. Main Controller Function ---

/**
 * Main function to fetch, process, and save plant data, and update hardware.
 * @param {string} plant_id The ID of the plant.
 */
async function set_plant(plant_id) {
    let plant_data = await getDoc(plant_id);
    let house_plant_api_data;
    let one_bit_bitmap_qr_code_string = '';

    if (plant_data) {
        console.log(`Plant ID ${plant_id} found in Firestore. Skipping data fetching and processing.`);
        // If data exists, we can still generate and send the QR code if necessary
        const qrUrl = `https://planta-gochi.wepapp/plants?id=${plant_data.id}`;
        one_bit_bitmap_qr_code_string = await generateQrHexString(qrUrl);
        sendData(one_bit_bitmap_qr_code_string);
        return { message: "Plant loaded from database.", plant: plant_data };
    }

    console.log(`Plant ID ${plant_id} not found. Fetching external data...`);

    // --- Data Fetching and AI Processing ---
    try {
        house_plant_api_data = await get_plant_data(plant_id);
    } catch (error) {
        return { error: error.message };
    }

    // 4.1. Get Ideal Variables from Gemini
    console.log("Getting ideal plant environment values from Gemini...");
    const commonName = house_plant_api_data["Common name"] ? house_plant_api_data["Common name"].join(', ') : 'the plant';
    const apiDataString = JSON.stringify(house_plant_api_data);

    const geminiPrompt = (field, unit, minMax, example) => `You are a plant expert, and currently observing ${commonName}. I need to know based on the data below the exact ideal ${field} for this plant in terms of ${unit}. ${minMax ? `Keep in mind the range is ${minMax}.` : ''} Here is plant data: ${apiDataString}. Return the exact value you think is best in numerical form. Example: ${example}`;
    const sickPrompt = (field, state, unit, minMax, example) => `You are a plant expert, and currently observing ${commonName}. I need to know based on the data below the exact ${state} value of ${field} for this plant in terms of ${unit}. ${minMax ? `Keep in mind the range is ${minMax}.` : ''} Here is plant data: ${apiDataString}. Return the exact value you think is best in numerical form. Example: ${example}`;

    // Ideal Values
    const ideal_temperature = await get_from_gemini(
        geminiPrompt('temperature', 'celsius', 'between 0 and 50', 22)
    );
    const ideal_humidity = await get_from_gemini(
        geminiPrompt('humidity', 'percentage', 'between 0 and 100', 60)
    );
    const ideal_light_exposure = await get_from_gemini(
        geminiPrompt('light exposure', 'lux/fc value (0=brightest, 4000=lowest)', 'between 0 and 4000 (0 is highest light)', 1200)
    );
    const ideal_moisture = await get_from_gemini(
        geminiPrompt('soil moisture', 'moisture sensor value (0=most moist, 4000=driest)', 'between 0 and 4000 (0 is most moist)', 1800)
    );

    // 4.2. Get Sick State Values from Gemini
    console.log("Getting sick state thresholds from Gemini...");
    const sick_state = {
        temperature: [
            await get_from_gemini(sickPrompt('temperature', 'too low', 'celsius', 'between 0 and 50', 14)),
            await get_from_gemini(sickPrompt('temperature', 'too high', 'celsius', 'between 0 and 50', 32))
        ],
        humidity: [
            await get_from_gemini(sickPrompt('humidity', 'too low', 'percentage', 'between 0 and 100', 25)),
            await get_from_gemini(sickPrompt('humidity', 'too high', 'percentage', 'between 0 and 100', 85))
        ],
        light_exposure: [
            await get_from_gemini(sickPrompt('light exposure', 'too low', 'lux/fc value (0=brightest, 4000=lowest)', 'between 0 and 4000', 2800)), // Lower light is higher value
            await get_from_gemini(sickPrompt('light exposure', 'too high', 'lux/fc value (0=brightest, 4000=lowest)', 'between 0 and 4000', 200)) // Higher light is lower value
        ],
        moisture: [
            await get_from_gemini(sickPrompt('soil moisture', 'too low (driest)', 'moisture sensor value (0=most moist, 4000=driest)', 'between 0 and 4000', 3200)), // Too dry is high value
            await get_from_gemini(sickPrompt('soil moisture', 'too high (most moist)', 'moisture sensor value (0=most moist, 4000=driest)', 'between 0 and 4000', 300)) // Too moist is low value
        ]
    };

    // 4.3. Get Happy State Values from Gemini (should match ideal_x)
    const happy_state = {
        temperature: await get_from_gemini(geminiPrompt('best single temperature', 'celsius', '', 24)),
        humidity: await get_from_gemini(geminiPrompt('best single humidity', 'percentage', '0-100', 60)),
        light_exposure: await get_from_gemini(geminiPrompt('best single light exposure', 'lux/fc value (0=brightest, 4000=lowest)', '0-4000', 1200)),
        moisture: await get_from_gemini(geminiPrompt('best single soil moisture', 'moisture sensor value (0=most moist, 4000=driest)', '0-4000', 1800)),
    };

    // 4.4. Get More Info HTML
    const more_info_html = await get_html_from_url(house_plant_api_data.Url);

    // 4.5. Construct the final plant_data object
    plant_data = {
        // Ideal variables
        ideal_light_exposure,
        ideal_humidity,
        ideal_moisture,
        ideal_temperature,

        // State objects
        sick_state,
        happy_state,

        // Metadata from API
        id: house_plant_api_data.id,
        name: house_plant_api_data["Common name"] ? house_plant_api_data["Common name"].join(', ') : 'Unknown Common Name',
        scientific_name: house_plant_api_data["Latin name"] || 'Unknown Latin Name',
        image: house_plant_api_data.Img,

        // Raw HTML
        more_info_html,

        // Current/History values (default to ideal)
        plant_temperature: [ideal_temperature],
        plant_moisture: [ideal_moisture],
        plant_humidity: [ideal_humidity],
        plant_light_exposure: [ideal_light_exposure],
    };

    // --- 5. Save to Firestore ---
    console.log(`Saving plant data to Firestore with ID: ${plant_data.id}`);
    await setDoc(plant_data.id, plant_data);

    // --- 6. Generate and Send QR Code ---
    const qrUrl = `https://planta-gochi.wepapp/plants?id=${plant_data.id}`;
    one_bit_bitmap_qr_code_string = await generateQrHexString(qrUrl);

    console.log("Sending QR code bitmap to hardware server...");
    sendData(one_bit_bitmap_qr_code_string);

    return {
        message: `New plant (ID: ${plant_data.id}) created, saved, and QR code sent to hardware.`,
        plant: plant_data
    };
}


// --- 7. Express Route Setup ---

app.get('/set_plant', async (req, res) => {
    const { plant_id } = req.query;

    if (!plant_id) {
        return res.status(400).send({ error: 'Missing plant_id query parameter.' });
    }

    try {
        const result = await set_plant(plant_id);
        res.status(200).send(result);
    } catch (error) {
        console.error("An error occurred in the set_plant route:", error.message);
        res.status(500).send({ error: "Server failed to process the request.", detail: error.message });
    }
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`🌿 Plant Server running on http://localhost:${PORT}`);
});