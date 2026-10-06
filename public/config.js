// Pega aqui la URL de tu Apps Script (termina en /exec). Es publica, no es una contraseña.
window.TURNOS_API = "https://script.google.com/macros/s/AKfycbynrNQCMTBbdYDVMwNLKjFI7AH4zB1pWLVD6PPHooSbUVdn8RDU5-LUMnB2q_AAW5tB/exec";
window.SEDES = {
  "Capital District (VE)": ["FERRETOTAL", "San Bernardino"],
  "Carabobo (VE)": ["ATC Valencia"],
  "Zulia (VE)": ["ATC Maracaibo"],
  "Aragua (VE)": ["ATC Maracay", "TECMOTORS"]
};
window.COLAS = { S: "Soporte", A: "Aspirantes", M: "Mantenimiento" };
try { window.SESION = localStorage.getItem("sesion_id"); if (!window.SESION) { window.SESION = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); localStorage.setItem("sesion_id", window.SESION); } } catch (e) { window.SESION = String(Math.random()).slice(2); }
window.api = async function (accion, datos, reintentos) {
  datos = Object.assign({ sesion: window.SESION, accion }, datos || {});
  try {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(window.TURNOS_API, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(datos), signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "Error");
    return j;
  } catch (e) {
    const red = /Failed to fetch|NetworkError|aborted|signal/i.test(e.message || "");
    if (red && (reintentos || 0) < 1) { await new Promise((s) => setTimeout(s, 1200)); return window.api(accion, datos, (reintentos || 0) + 1); }
    throw new Error(red ? "No hay conexión. Revisa el internet e intenta de nuevo." : e.message);
  }
};
