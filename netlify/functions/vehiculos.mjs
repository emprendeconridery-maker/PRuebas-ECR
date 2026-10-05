// Consulta Odoo y entrega los vehiculos del taller a la pantalla.
// Datos privados: se configuran en Netlify > Environment variables.
const URL_ODOO = process.env.ODOO_URL || "https://ridery-odoo.ridery.app";
const DB = process.env.ODOO_DB || "ridery_odoo";
const USER = process.env.ODOO_USER;
const PWD = process.env.ODOO_PASSWORD;
const CLAVE = process.env.CLAVE_PANTALLA;
const NOMBRE = process.env.NOMBRE_CONDUCTOR || "corto"; // corto | completo | ninguno

const ETAPAS = {
  "Ingreso a Taller": ["recepcion", ""],
  "En Mantenimiento": ["mantenimiento", ""],
  "Mantenimiento Prolongado": ["mantenimiento", "Prolongado"],
  "Mantenimiento - Falta de Repuestos": ["mantenimiento", "Esperando repuestos"],
  "Mantenimiento de Rotulado": ["mantenimiento", "Rotulado"],
  "Control de Calidad": ["calidad", ""],
  "Listo para Retirar por Conductor": ["listo", ""],
};
const MAPA = Object.fromEntries(Object.entries(ETAPAS).map(([k, v]) => [k.toLowerCase(), v]));
const SIN_CACHE = { "Cache-Control": "no-store" };
let uid = null, cache = null, cacheHora = 0;

async function rpc(service, method, args) {
  const r = await fetch(`${URL_ODOO}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.data?.message || j.error.message);
  return j.result;
}

function nombre(n) {
  if (NOMBRE === "ninguno" || !n) return "";
  if (NOMBRE === "completo") return n;
  const p = n.trim().split(/\s+/);
  if (p.length < 2) return n;
  const ap = p.length >= 4 ? p[2] : p[p.length - 1];
  return `${p[0][0].toUpperCase()}${p[0].slice(1).toLowerCase()} ${ap[0].toUpperCase()}.`;
}

async function leer() {
  if (!uid) {
    uid = await rpc("common", "login", [DB, USER, PWD]);
    if (!uid) throw new Error("Usuario o clave de Odoo incorrectos");
  }
  const regs = await rpc("object", "execute_kw", [DB, uid, PWD, "fleet.vehicle", "search_read",
    [[["state_id.name", "in", Object.keys(ETAPAS)]]],
    { fields: ["license_plate", "state_id", "driver_id", "future_driver_id", "model_id"] }]);
  return regs.flatMap((r) => {
    const placa = (r.license_plate || "").trim().toUpperCase();
    const [grupo, sub] = (r.state_id && MAPA[r.state_id[1].trim().toLowerCase()]) || [];
    if (!placa || !grupo) return [];
    const c = r.future_driver_id || r.driver_id;
    return [{ placa, grupo, sub, modelo: r.model_id ? r.model_id[1].replace(/\//g, " ") : "", conductor: nombre(c ? c[1] : "") }];
  });
}

export default async (req) => {
  if (!CLAVE) return Response.json({ error: "Falta CLAVE_PANTALLA en Netlify" }, { status: 500, headers: SIN_CACHE });
  if (new URL(req.url).searchParams.get("clave") !== CLAVE)
    return Response.json({ error: "Clave de acceso incorrecta" }, { status: 401, headers: SIN_CACHE });
  if (!USER || !PWD) return Response.json({ listo: false, error: "Faltan ODOO_USER u ODOO_PASSWORD en Netlify" }, { headers: SIN_CACHE });
  const ahora = Date.now();
  if (cache && ahora - cacheHora < 15000) return Response.json(cache, { headers: SIN_CACHE });
  try {
    cache = { listo: true, hora: ahora / 1000, error: null, vehiculos: await leer() };
    cacheHora = ahora;
    return Response.json(cache, { headers: SIN_CACHE });
  } catch (e) {
    uid = null;
    console.error(e);
    return Response.json({ listo: false, error: /incorrectos/.test(e.message) ? e.message : "Sin respuesta de Odoo" }, { headers: SIN_CACHE });
  }
};

export const config = { path: "/api/vehiculos" };
