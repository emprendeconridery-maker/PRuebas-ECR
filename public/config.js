// Pega aqui la URL de tu Apps Script (termina en /exec). Es publica, no es una contraseña.
window.TURNOS_API = "PEGA_AQUI_LA_URL_DE_APPS_SCRIPT";
window.SEDES = {
  "Capital District (VE)": ["FERRETOTAL", "San Bernardino"],
  "Carabobo (VE)": ["ATC Valencia"],
  "Zulia (VE)": ["ATC Maracaibo"],
  "Aragua (VE)": ["ATC Maracay", "TECMOTORS"]
};
window.COLAS = { S: "Soporte", A: "Aspirantes", M: "Mantenimiento" };
window.api = async function (accion, datos) {
  const r = await fetch(window.TURNOS_API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(Object.assign({ accion }, datos || {})) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "Error");
  return j;
};
