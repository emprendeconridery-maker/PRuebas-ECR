// Genera el anuncio con una voz neural de Google (suena casi humana).
// Requiere GOOGLE_TTS_KEY en Netlify > Environment variables.
// Si no esta configurada, la pantalla usa la voz del navegador.
const CLAVE = (process.env.CLAVE_PANTALLA || "").trim();
const KEY = (process.env.GOOGLE_TTS_KEY || "").trim();
const VOZ = (process.env.VOZ_GOOGLE || "es-US-Chirp3-HD-Aoede").trim(); // voz de mujer
const RESPALDO = "es-US-Neural2-A"; // voz de mujer alternativa
const guardadas = new Map(); // placa -> audio mp3

const deletrear = (p) => (p.match(/[A-Z]+|[0-9]+/g) || [p]).map((g) => g.split("").join(" ")).join(", ");

async function sintetizar(texto, voz) {
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text: texto },
      voice: { languageCode: voz.slice(0, 5), name: voz },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.12, volumeGainDb: 4 },
    }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (!r.ok || !j.audioContent) throw new Error(j.error?.message || `Error ${r.status}`);
  return Buffer.from(j.audioContent, "base64");
}

export default async (req) => {
  const q = new URL(req.url).searchParams;
  if (!CLAVE || (q.get("clave") || "").trim() !== CLAVE) return Response.json({ error: "Clave de acceso incorrecta" }, { status: 401 });
  if (!KEY) return Response.json({ error: "Voz neural no configurada" }, { status: 404 });
  const placa = (q.get("placa") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (placa.length < 4 || placa.length > 10) return Response.json({ error: "Placa no valida" }, { status: 400 });

  let audio = guardadas.get(placa);
  if (!audio) {
    const texto = `Atención. El vehículo con placa ${deletrear(placa)}, está listo para retirar. Por favor, acérquese a su asesor de servicio.`;
    try {
      audio = await sintetizar(texto, VOZ);
    } catch (e) {
      console.error("Voz principal no disponible:", e.message);
      try {
        audio = await sintetizar(texto, RESPALDO);
      } catch (e2) {
        console.error("Voz de respaldo no disponible:", e2.message);
        return Response.json({ error: "No se pudo generar la voz" }, { status: 502 });
      }
    }
    if (guardadas.size > 300) guardadas.clear();
    guardadas.set(placa, audio);
  }
  return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=604800", "Netlify-CDN-Cache-Control": "public, durable, s-maxage=2592000" } });
};

export const config = { path: "/api/voz" };
