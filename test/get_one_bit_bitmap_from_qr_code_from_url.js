const express = require('express');
const axios = require('axios');
const sharp = require("sharp");
const fs = require("fs");
const app = express();
const PORT = 3000;

"Finalized the gochi server , that will interact with the ESP32, exposed a sendData() method and onCall() callback to be used later in app. Also testeda means for generating QR code and converting them into 1-bit bitmaps for later displaying on OLED screen. "

async function generateQrCArray(url, outFile = "qr_bitmap.h", varName = "qr_bitmap") {
    try {
        // 1. Build QR API URL
        const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=128x128&data=${encodeURIComponent(url)}`;

        // 2. Fetch QR PNG
        const response = await axios.get(apiUrl, { responseType: "arraybuffer" });
        const buffer = Buffer.from(response.data);

        // 3. Convert to 1-bit monochrome raw pixels
        const { data, info } = await sharp(buffer)
            .resize(128, 128, { fit: "contain" })  // resize to OLED
            .threshold(128)                        // force B/W
            .raw()
            .toBuffer({ resolveWithObject: true });

        const width = info.width;
        const height = info.height;

        // 4. Pack pixels into bytes
        let bytes = [];
        for (let y = 0; y < height; y++) {
            let byte = 0;
            for (let x = 0; x < width; x++) {
                const pixel = data[y * width + x]; // grayscale pixel: 0 or 255 after threshold
                if (pixel === 0) {
                    byte |= (1 << (7 - (x % 8))); // set bit if black
                }
                if (x % 8 === 7) {
                    bytes.push(byte);
                    byte = 0;
                }
            }
            if (width % 8 !== 0) bytes.push(byte);
        }

        // 5. Format C array
        let cArray = `#define ${varName}_width ${width}\n#define ${varName}_height ${height}\n`;
        cArray += `static const unsigned char ${varName}[] PROGMEM = {\n`;

        bytes.forEach((b, i) => {
            cArray += `0x${b.toString(16).padStart(2, "0")}, `;
            if ((i + 1) % 12 === 0) cArray += "\n";
        });

        cArray += "};\n";

        // 6. Save header file
        fs.writeFileSync(outFile, cArray);
        console.log(`✅ QR code converted and saved to ${outFile}`);
    } catch (err) {
        console.error("Error:", err.message);
    }
}




app.get("/", async (req, res) => {
    const inputUrl = process.argv[2] || "https://example.com";
    await generateQrCArray(inputUrl);
})


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});