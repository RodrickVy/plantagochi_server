// app.js

const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const moment = require('moment'); // For easy timestamp handling
require('dotenv').config(); // Use .env for secrets if needed

// --- CONFIGURATION & INITIALIZATION ---

// Initialize Firebase Admin SDK
// NOTE: Replace './serviceAccountKey.json' with the actual path to your key
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const PORT = 3000;

// Set EJS as the view engine (though not heavily used for this API-focused task)
app.set('view engine', 'ejs');
app.use(express.json()); // Middleware to parse JSON body

// House Plants Database API URL
const PLANT_API_URL = 'YOUR_HOUSE_PLANTS_DATABASE_API_BASE_URL';

// --- CONSTANTS ---

/**
 * Array of emotions and descriptions for the emotional_state list index.
 * @type {Array<{emotion: string, description: string}>}
 */
const EMOTIONAL_STATES = [
    { emotion: "Normal", description: "The plant is doing well, all conditions are optimal." },
    { emotion: "Excited", description: "The plant is thriving and growing vigorously due to excellent care." },
    { emotion: "Bored", description: "The plant is under-stimulated, perhaps lacking a change in routine or attention." },
    { emotion: "Depressed", description: "The plant is wilting or showing signs of long-term stress." },
    { emotion: "Sick", description: "The plant is exhibiting clear signs of disease or pest infestation." },
    { emotion: "Needs Shower", description: "The plant's leaves are dusty or it requires a good rinse." }
];

// --- GEMINI PLACEHOLDER FUNCTION ---

/**
 * !!! PLACEHOLDER FUNCTION !!!
 * This function should be implemented to call the Google Gemini API.
 * For this example, it returns dummy data.
 * @param {string} prompt - The prompt to send to Gemini.
 * @returns {Promise<string>} The generated text response.
 */
async function get_from_gemini(prompt) {
    console.log(`[Gemini Call] Processing prompt: ${prompt.substring(0, 50)}...`);
    // NOTE: Implement actual Gemini API call here.

    // Simple placeholder logic based on prompt keywords:
    if (prompt.includes("ideal tempreture")) return "20-22";
    if (prompt.includes("ideal humidity")) return "60-70%";
    if (prompt.includes("ideal moisture")) return "3-5 (on a moisture meter)";
    if (prompt.includes("ideal light")) return "1000-2000 lux";

    if (prompt.includes("low tempreture")) return "15";
    if (prompt.includes("low humidity")) return "40%";
    if (prompt.includes("low moisture")) return "1";
    if (prompt.includes("low light")) return "500 lux";

    if (prompt.includes("high tempreture")) return "28";
    if (prompt.includes("high humidity")) return "90%";
    if (prompt.includes("high moisture")) return "7";
    if (prompt.includes("high light")) return "3000 lux";

    // Placeholder for State definition
    if (prompt.includes("sick state")) {
        return JSON.stringify({
            temperature: "Below 15 C",
            humidity: "Above 80%",
            moisture: "High (7+)",
            light_exposure: "Low",
            action: "Check for pests, isolate, apply fungicide.",
            emotion_index: 4 // Sick
        });
    }
    if (prompt.includes("excited state")) {
        return JSON.stringify({
            temperature: "20-22 C",
            humidity: "60-70%",
            moisture: "3-5",
            light_exposure: "1000-2000 lux",
            action: "Maintain current conditions.",
            emotion_index: 1 // Excited
        });
    }
    // ... add logic for other states (normal, depressed, bored, needs_shower)
    if (prompt.includes("normal state")) {
        return JSON.stringify({
            temperature: "18-20 C",
            humidity: "50-60%",
            moisture: "2-4",
            light_exposure: "800-1500 lux",
            action: "Continue routine care.",
            emotion_index: 0 // Normal
        });
    }

    // Default for any other state
    return JSON.stringify({
        temperature: "Default", humidity: "Default", moisture: "Default",
        light_exposure: "Default", action: "Default action", emotion_index: 0
    });
}


// --- HELPER FUNCTIONS FOR GEMINI DATA GENERATION ---

/**
 * Generates an object of ideal, low, and high environmental data using Gemini.
 * @param {Object} plantData - The initial data retrieved from the house plants API.
 * @returns {Promise<Object>} An object containing ideal, low, and high values.
 */
async function generateEnvironmentalRanges(plantData) {
    const dataString = JSON.stringify(plantData, null, 2);

    const fields = ['tempreture', 'humidity', 'moisture', 'light_exposure'];
    const types = ['ideal', 'low', 'high'];
    const results = {};

    for (const type of types) {
        for (const field of fields) {
            const fieldName = `${type}_${field}`;
            const prompt = `Based on this plant's data: ${dataString}. I want to get the ${type} ${field.replace('_', ' ')} (in C, %, meter reading, lux) for the plant. Provide only the value.`;
            results[fieldName] = await get_from_gemini(prompt);
        }
    }
    return results;
}

/**
 * Generates a single plant state map using Gemini.
 * @param {string} stateName - The name of the state (sick, excited, etc.).
 * @param {Object} plantData - The initial API data.
 * @param {Object} existingStates - Object of already generated states (used for context).
 * @returns {Promise<Object>} The generated state map (temperature, humidity, etc.).
 */
async function generatePlantState(stateName, plantData, existingStates = {}) {
    const plantDataString = JSON.stringify(plantData, null, 2);
    const existingStatesString = JSON.stringify(existingStates, null, 2);

    let basePrompt = `Based on this plant's data: ${plantDataString}, and existing generated states: ${existingStatesString}. I want a detailed map for the **${stateName}** state. The map must contain temperature, humidity, moisture, light_exposure, an action, and an emotion_index corresponding to the EMOTIONAL_STATES array. The humidity, moisture, and light prompts should reference the generated temperature. Respond ONLY with a single JSON object.`;

    const geminiResponse = await get_from_gemini(basePrompt);

    try {
        const stateMap = JSON.parse(geminiResponse);
        // Ensure the emotion_index is valid
        if (stateMap.emotion_index < 0 || stateMap.emotion_index >= EMOTIONAL_STATES.length) {
            stateMap.emotion_index = 0; // Default to Normal if invalid
        }
        return stateMap;
    } catch (error) {
        console.error(`Error parsing Gemini response for ${stateName} state:`, error);
        // Return a safe default state on failure
        return {
            temperature: "Unknown", humidity: "Unknown", moisture: "Unknown",
            light_exposure: "Unknown", action: "Review system logs.", emotion_index: 4 // Default to Sick state on failure
        };
    }
}

// --- MAIN FUNCTION: PUT /plant/:plant_id ---

/**
 * 1 - PUT function: Creates a new Firebase document for a plant.
 * @param {express.Request} req - The Express request object.
 * @param {express.Response} res - The Express response object.
 */
app.put('/plant/:plant_id', async (req, res) => {
    const plantId = req.params.plant_id;
    const plantDocRef = db.collection('plants').doc(plantId);

    try {
        // 1. Check if document already exists
        const docSnapshot = await plantDocRef.get();
        if (docSnapshot.exists) {
            return res.status(409).json({ message: 'Plant document already exists in Firestore.', plant_id: plantId });
        }

        // 2. Get initial data from the House Plants Database API
        console.log(`Fetching data for plant ID: ${plantId}`);
        const apiResponse = await axios.get(`${PLANT_API_URL}/plants/${plantId}`);
        const plantData = apiResponse.data;

        const plantName = plantData['Common name'] ? plantData['Common name'][0] : plantData['Latin name'];

        // 3. Generate Ideal/Low/High Environmental Ranges using Gemini
        const envRanges = await generateEnvironmentalRanges(plantData);

        // 4. Prepare base document with initial/tracking data
        let newPlantDocument = {
            plant_name: plantName,
            plant_id: plantId,

            // Environmental Ranges (from Gemini)
            ...envRanges,

            // Tracking Lists (current_data is the latest item)
            plant_light_exposure: ["Unknown"],
            plant_humidity: ["Unknown"],
            plant_moisture: ["Unknown"],
            plant_temperature: ["Unknown"],

            // Status Tracking
            last_access: moment().toISOString(), // ISO 8601 string timestamp
            emotional_state: [0], // Default to 'Normal' (index 0)
            emotional_state_description: EMOTIONAL_STATES[0].description,

            // Initial plant data from external API (for context)
            initial_api_data: plantData
        };

        // 5. Generate and add States using Gemini (sequential due to dependencies)
        let generatedStates = {};

        // Use the generated 'ideal' values to create a baseline for the excited state
        const excitedStateData = {
            temperature: newPlantDocument.ideal_tempreture,
            humidity: newPlantDocument.ideal_humidity,
            moisture: newPlantDocument.ideal_moisture,
            light_exposure: newPlantDocument.ideal_light_exposure,
            action: "Optimal conditions. Continue monitoring.",
            emotion_index: 1
        };
        generatedStates.excited_state = excitedStateData;

        // Generate other states, providing context of the excited/sick states
        // Note: The helper function `generatePlantState` handles the specific prompt logic
        generatedStates.sick_state = await generatePlantState('sick', newPlantDocument.initial_api_data, generatedStates);
        generatedStates.normal_state = await generatePlantState('normal', newPlantDocument.initial_api_data, generatedStates);
        generatedStates.depressed_state = await generatePlantState('depressed', newPlantDocument.initial_api_data, generatedStates);
        generatedStates.bored_state = await generatePlantState('bored', newPlantDocument.initial_api_data, generatedStates);

        // Add the generated states to the document
        newPlantDocument = {
            ...newPlantDocument,
            ...generatedStates
        };

        // 6. Upload document to Firestore
        await plantDocRef.set(newPlantDocument);

        console.log(`Successfully created document for plant ID: ${plantId}`);
        res.status(201).json({
            message: 'Plant document created successfully.',
            plant_id: plantId,
            data: newPlantDocument
        });

    } catch (error) {
        console.error('Error in PUT /plant/:plant_id:', error.message);

        let statusCode = 500;
        let errorMessage = 'An internal server error occurred.';

        if (error.isAxiosError && error.response) {
            statusCode = error.response.status;
            errorMessage = `API Error: Could not retrieve plant data (Status: ${statusCode}).`;
        }

        res.status(statusCode).json({ message: errorMessage, error_details: error.message });
    }
});


// --- SERVER START ---

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});