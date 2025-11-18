import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import "dotenv/config";

// Loads an image from disk

// Sends it to Gemini 1.5 Flash (free tier)

// Forces JSON output

// Returns { label, confidence }
console.log(process.env.GEMINI_API_KEY)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Convert local image to base64 for Gemini
function loadImageAsBase64(path) {
  return fs.readFileSync(path).toString("base64");
}

async function classifyImage(imagePath) {
  const imageBase64 = loadImageAsBase64(imagePath);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash", // free model
    generationConfig: {
      responseMimeType: "application/json", // forces JSON output
    },
  });

  const prompt =
    "Classify the main subject of this image as one of: " +
    "'fauna', 'flora', 'fungi', or 'other'. " +
    "Respond ONLY in strict JSON like: " +
    "{\"label\": \"fauna\", \"confidence\": 0.82}";

  const result = await model.generateContent([
    {
      inlineData: {
        data: imageBase64,
        mimeType: "image/jpeg",
      },
    },
    { text: prompt },
  ]);

  const text = result.response.text();
  return JSON.parse(text);
}

// CLI usage: node classify.js path/to/image.jpg
const imagePath = process.argv[2];
if (!imagePath) {
  console.error("Usage: node classify.js <imagePath>");
  process.exit(1);
}

classifyImage(imagePath)
  .then((out) => {
    console.log("Result:", out);
    const ok =
      ["fauna", "flora", "fungi"].includes(out.label.toLowerCase()) &&
      out.confidence >= 0.7;

    console.log("Acceptable for iNaturalist:", ok);
  })
  .catch((err) => console.error(err));
