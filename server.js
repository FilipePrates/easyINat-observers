// server.js (CommonJS MVP)
// WhatsApp (Twilio) webhook -> Text vs Image routing
// Image -> iNaturalist CV suggestions -> (optional) create observation if high confidence
// Optional LLM "Iara" response

const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { twiml: { MessagingResponse } } = require("twilio");

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// -------------------------
// Config
// -------------------------
const PORT = process.env.PORT || 3000;

// Twilio (only needed if downloading Twilio-hosted media URLs)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// iNaturalist
// Some CV endpoints require auth; use a valid token if you have one.
const INAT_TOKEN = process.env.INAT_TOKEN || ""; // "Bearer ..." not needed; we prefix later
const INAT_BASE = "https://api.inaturalist.org/v1";

// LLM (Iara persona)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const IARA_SYS = `Você escreve respostas curtas e calorosas em PT-BR, incentivando conexão com a Natureza. Use tom acolhedor, observação do iNaturalist, convide a pessoa a acompanhar. Evite prometer certezas absolutas.`;

// Confidence threshold to auto-create an observation
const HIGH_CONFIDENCE = Number(process.env.HIGH_CONFIDENCE || 0.85);

// Temp folder for downloads
const TMP_DIR = path.join(process.cwd(), "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// -------------------------
// Helpers
// -------------------------

/**
 * Download an image URL to a local temp file.
 * If the URL is Twilio-hosted, we authenticate with Basic Auth.
 * Returns local file path.
 */
async function downloadImageToFile(url) {
  const filename = path.join(TMP_DIR, `${uuidv4()}.jpg`);

  const axiosOpts = {
    method: "GET",
    url,
    responseType: "stream",
  };

  // Twilio media URLs usually require Basic Auth
  if (/^https:\/\/api\.twilio\.com\//.test(url) && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    axiosOpts.auth = {
      username: TWILIO_ACCOUNT_SID,
      password: TWILIO_AUTH_TOKEN,
    };
  }

  const res = await axios(axiosOpts);
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(filename);
    res.data.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });

  return filename;
}

/**
 * Call iNaturalist Computer Vision suggestion endpoint with an image.
 * Optionally include lat/lng/observed_on to improve results.
 * Returns array of { taxon, score } sorted by score desc.
 */
async function getINatSuggestions({ imagePath, lat, lng, observed_on, locale = "pt-BR" }) {
  const url = `${INAT_BASE}/computervision/score_image`;
  const form = new FormData();
  form.append("image", fs.createReadStream(imagePath));
  if (lat != null && lng != null) {
    form.append("lat", String(lat));
    form.append("lng", String(lng));
  }
  if (observed_on) form.append("observed_on", observed_on);
  if (locale) form.append("locale", locale);

  const headers = { ...form.getHeaders() };
  if (INAT_TOKEN) headers.Authorization = `Bearer ${INAT_TOKEN}`;

  const { data } = await axios.post(url, form, { headers, timeout: 30000 });
  // Expect data.results = [{ taxon: {...}, score: 0.xx }, ...]
  const results = Array.isArray(data?.results) ? data.results : [];
  // Sort desc by score
  results.sort((a, b) => (b.score || 0) - (a.score || 0));
  return results;
}

/**
 * Create an observation on iNaturalist and attach a photo.
 * Returns { observationId, url } for the observation page.
 */
async function createINatObservationWithPhoto({ taxon_id, lat, lng, observed_on, timezone = "America/Sao_Paulo", imagePath }) {
  if (!INAT_TOKEN) throw new Error("INAT_TOKEN ausente; necessário para criar observações.");

  // 1) Create observation
  const obsPayload = {
    observation: {
      taxon_id,
      latitude: lat,
      longitude: lng,
      observed_on_string: observed_on || new Date().toISOString().slice(0, 10),
      timezone,
      // privacy: 'open', // optional
      // description: 'Criada via bot Iara 🌿', // optional
    },
  };

  const headersJson = { Authorization: `Bearer ${INAT_TOKEN}` };
  const { data: obsData } = await axios.post(`${INAT_BASE}/observations`, obsPayload, { headers: headersJson });
  const newObs = Array.isArray(obsData?.results) ? obsData.results[0] : obsData; // API often returns {results:[...]}
  const observationId = newObs?.id;
  if (!observationId) throw new Error("Falha ao criar observação no iNaturalist");

  // 2) Attach photo
  const form = new FormData();
  form.append("file", fs.createReadStream(imagePath));
  form.append("observation_photo[observation_id]", String(observationId));
  const headersMultipart = { Authorization: `Bearer ${INAT_TOKEN}`, ...form.getHeaders() };

  await axios.post(`${INAT_BASE}/observation_photos`, form, { headers: headersMultipart });

  return {
    observationId,
    url: `https://www.inaturalist.org/observations/${observationId}`,
  };
}

/**
 * Optional: Ask "Iara" (LLM) to craft a short warm response in PT-BR.
 * Falls back to a simple template if OPENAI_API_KEY is not set.
 */
async function askIara(prompt) {
  if (!OPENAI_API_KEY) {
    return `🌿 ${prompt}`;
  }
  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        max_tokens: 160,
        messages: [
          { role: "system", content: IARA_SYS },
          { role: "user", content: prompt },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 25000,
      }
    );
    return data?.choices?.[0]?.message?.content?.trim() || `🌱 ${prompt}`;
  } catch (e) {
    console.error("Iara error:", e?.response?.data || e?.message);
    return `🌿 ${prompt}`;
  }
}

/**
 * Utility: format a species line "Nome comum (Nome científico)"
 */
function formatTaxon(taxon, locale = "pt-BR") {
  const sci = taxon?.name || "";
  // Preferred common name may be language-dependent; use what API returns
  const common =
    taxon?.preferred_common_name ||
    taxon?.english_common_name ||
    taxon?.preferred_common_name_localized ||
    "";
  return common ? `${common} (${sci})` : sci;
}

/**
 * Get lat/lng from Twilio webhook body if user sent location (fallback to null).
 */
function parseLatLngFromBody(body) {
  // Twilio sends Location messages with Latitude/Longitude fields.
  // If user previously sent a location, you can store it per user phone in DB.
  // For this MVP, we check current payload only.
  const latKeys = ["Latitude", "lat", "Lat"];
  const lngKeys = ["Longitude", "lng", "Lon", "long"];

  let lat = null;
  let lng = null;

  for (const k of latKeys) if (body[k] != null && body[k] !== "") { lat = Number(body[k]); break; }
  for (const k of lngKeys) if (body[k] != null && body[k] !== "") { lng = Number(body[k]); break; }

  return { lat, lng };
}

// -------------------------
// Handlers (MVP)
// -------------------------

async function handleText({ from, text }) {
  console.log("[TEXT]", { from, text });
  // Minimal behavior: invite to send photo or location
  const prompt = `Mensagem do usuário: "${text}". Responda acolhedor e convide a pessoa a enviar foto de planta/animal e localização.`;
  return askIara(prompt);
}

async function handleImage({ from, mediaUrl, contentType, caption, webhookBody }) {
  console.log("[IMAGE]", { from, mediaUrl, contentType, caption });

  // 1) download image to temp file
  const localPath = await downloadImageToFile(mediaUrl);

  // 2) parse location if present in webhook
  const { lat, lng } = parseLatLngFromBody(webhookBody);
  const observed_on = new Date().toISOString().slice(0, 10);

  // 3) get CV suggestions
  let suggestions = [];
  try {
    suggestions = await getINatSuggestions({ imagePath: localPath, lat, lng, observed_on, locale: "pt-BR" });
  } catch (e) {
    console.error("iNat CV error:", e?.response?.data || e.message);
  }

  if (!suggestions.length) {
    const reply = await askIara("Não consegui identificar com segurança a partir da imagem. Sugira tentar outra foto, ângulo ou enviar localização.");
    return reply;
  }

  const top = suggestions[0];
  const second = suggestions[1];
  const speciesLine = formatTaxon(top?.taxon, "pt-BR");
  const score = top?.score ?? 0;
  let obsUrl = null;

  // 4) if high confidence, optionally create observation with photo
  if (score >= HIGH_CONFIDENCE && top?.taxon?.id) {
    try {
      const created = await createINatObservationWithPhoto({
        taxon_id: top.taxon.id,
        lat,
        lng,
        observed_on,
        imagePath: localPath,
      });
      obsUrl = created?.url || null;
    } catch (e) {
      console.warn("Create observation skipped/failed:", e?.response?.data || e.message);
    }
  }

  // 5) craft human reply
  let baseMsg = `Minha sugestão é: ${speciesLine}. (confiança ~${(score * 100).toFixed(0)}%)`;
  if (second?.score != null) {
    baseMsg += `\nOutra possibilidade: ${formatTaxon(second.taxon)} (~${(second.score * 100).toFixed(0)}%).`;
  }
  if (obsUrl) {
    baseMsg += `\n\nRegistrei como observação no iNaturalist: ${obsUrl}`;
  } else {
    baseMsg += `\n\nSe quiser, posso registrar como observação no iNaturalist quando você desejar.`;
  }

  const reply = await askIara(baseMsg);
  // cleanup tmp file
  fs.unlink(localPath, () => {});
  return reply;
}

// -------------------------
// Twilio WhatsApp Webhook
// -------------------------
app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();

  try {
    const from = req.body.From || "";
    const body = (req.body.Body || "").trim();
    const numMedia = Number(req.body.NumMedia || 0);

    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const contentType = req.body.MediaContentType0 || "";
      const caption = body || null;

      if (contentType.startsWith("image/")) {
        const reply = await handleImage({
          from,
          mediaUrl,
          contentType,
          caption,
          webhookBody: req.body,
        });
        twiml.message(reply);
      } else {
        twiml.message("Recebi um anexo, mas por enquanto só aceito imagens 🙏");
      }
    } else {
      const reply = await handleText({ from, text: body });
      twiml.message(reply);
    }
  } catch (err) {
    console.error(err);
    twiml.message("Ops! Tive um probleminha aqui. Pode tentar de novo? 🌱");
  }

  res.type("text/xml").send(twiml.toString());
});

app.get("/health", (_req, res) => res.send("OK"));
app.listen(PORT, () => console.log(`✅ WhatsApp MVP online na porta ${PORT}`));
