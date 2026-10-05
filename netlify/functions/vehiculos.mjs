// RESPALDO: solo se usa si la edge function falla. Consulta Odoo y entrega los vehiculos.
// Datos privados: se configuran en Netlify > Environment variables.
const URL_ODOO = process.env.ODOO_URL || "https://ridery-odoo.ridery.app";
const DB = process.env.ODOO_DB || "ridery_odoo";
const USER = (process.env.ODOO_USER || "").trim();
const PWD = process.env.ODOO_PASSWORD;
const CLAVE = (process.env.CLAVE_PANTALLA || "").trim();
const NOMBRE = process.env.NOMBRE_CONDUCTOR || "corto"; // corto | completo | ninguno
const CAMPO_UBIC = process.env.CAMPO_UBICACION || ""; // opcional: nombre tecnico
const CAMPO_DEP = process.env.CAMPO_DEPOSITO || "";   // opcional: nombre tecnico

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
// Cache compartido en la CDN de Netlify: todas las pantallas reciben la misma respuesta
// y Odoo se consulta como maximo una vez por minuto, sin importar cuantas pantallas haya.
const CACHE_OK = { "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": "public, durable, s-maxage=60, stale-while-revalidate=300" };
const CACHE_ERROR = { "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": "public, durable, s-maxage=60" };
const G = ["recepcion", "mantenimiento", "calidad", "listo"];
const S = ["", "Prolongado", "Esperando repuestos", "Rotulado"];

// Respuesta compacta (menos datos = menos consumo)
function compactar(vs) {
  const m = [], d = [], im = new Map(), id = new Map();
  const idx = (arr, mapa, v) => { if (!v) return -1; if (!mapa.has(v)) { mapa.set(v, arr.length); arr.push(v); } return mapa.get(v); };
  const x = vs.map((v) => [v.placa, G.indexOf(v.grupo), Math.max(0, S.indexOf(v.sub)), idx(m, im, v.modelo), v.conductor || "", idx(d, id, v.deposito), v.desde ? Math.round(v.desde) : 0]);
  return { m, d, x };
}

let uid = null, cache = null, cacheHora = 0, campos = null, modoTiempo = "historial";
const entrada = new Map(); // id del vehiculo -> { estado, desde }

const normal = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const fechaOdoo = (s) => (s ? Date.parse(String(s).replace(" ", "T") + "Z") / 1000 : null);

async function rpc(service, method, args) {
  const r = await fetch(`${URL_ODOO}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
    signal: AbortSignal.timeout(6000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.data?.message || j.error.message);
  return j.result;
}
const kw = (modelo, metodo, args, opciones = {}) => rpc("object", "execute_kw", [DB, uid, PWD, modelo, metodo, args, opciones]);

function nombre(n) {
  if (NOMBRE === "ninguno" || !n) return "";
  if (NOMBRE === "completo") return n;
  const p = n.trim().split(/\s+/);
  if (p.length < 2) return n;
  const ap = p.length >= 4 ? p[2] : p[p.length - 1];
  return `${p[0][0].toUpperCase()}${p[0].slice(1).toLowerCase()} ${ap[0].toUpperCase()}.`;
}

// Busca los campos por su etiqueta visible ("Ubicacion de flota", "Deposito")
async function detectarCampos() {
  const f = await kw("fleet.vehicle", "fields_get", [], { attributes: ["string", "type", "selection"] });
  const rango = { many2one: 0, selection: 1, char: 2 };
  const buscar = (forzado, etiquetas) => {
    if (forzado && f[forzado]) return { name: forzado, ...f[forzado] };
    for (const e of etiquetas) {
      const k = Object.keys(f).filter((k) => normal(f[k].string) === e && f[k].type in rango)
        .sort((a, b) => rango[f[a].type] - rango[f[b].type])[0];
      if (k) return { name: k, ...f[k] };
    }
    return null;
  };
  campos = {
    ubicacion: buscar(CAMPO_UBIC, ["ubicacion de flota", "fleet location"]),
    deposito: buscar(CAMPO_DEP, ["deposito", "deposit"]),
  };
}

function texto(c, v) {
  if (!c || v == null || v === false) return "";
  if (Array.isArray(v)) return String(v[1] ?? "");
  if (c.type === "selection") { const o = (c.selection || []).find((s) => s[0] === v); return o ? o[1] : String(v); }
  return String(v);
}

// Valores nuevos de los cambios registrados en un mensaje del historial (Odoo 14 a 16)
const valoresNuevos = (m) => (m.trackingValues || m.tracking_value_ids || []).map((t) => {
  const n = t.newValue ?? t.new_value;
  return n && typeof n === "object" ? n.value : n;
});

// Hora en que cada vehiculo entro a su estado actual, leida del historial de Odoo.
// Se calcula por lotes y se recuerda, para no sobrecargar Odoo.
async function calcularTiempos(lista, inicio) {
  const faltan = lista.filter((r) => entrada.get(r.id)?.estado !== r.estado);
  if (!faltan.length) return;
  if (modoTiempo === "historial") {
    if (Date.now() - inicio > 4000) return; // se completa en la siguiente consulta
    const lote = faltan.slice(0, 12);
    try {
      const ids = await kw("mail.message", "search",
        [[["model", "=", "fleet.vehicle"], ["res_id", "in", lote.map((r) => r.id)], ["message_type", "=", "notification"]]],
        { order: "id desc", limit: 360 });
      const msgs = ids.length ? await kw("mail.message", "message_format", [ids]) : [];
      for (const r of lote) {
        let desde = null;
        for (const m of msgs) {
          if (m.res_id !== r.id || !valoresNuevos(m).some((v) => normal(v) === normal(r.estado))) continue;
          const f = fechaOdoo(m.date);
          if (f && (!desde || f > desde)) desde = f;
        }
        entrada.set(r.id, { estado: r.estado, desde: desde || r.escrito });
      }
      return;
    } catch (e) {
      console.error("Historial no disponible; se usa la fecha de modificacion:", e.message);
      modoTiempo = "aproximado";
    }
  }
  for (const r of faltan) entrada.set(r.id, { estado: r.estado, desde: r.escrito });
}

async function leer(inicio) {
  if (!uid) {
    uid = await rpc("common", "login", [DB, USER, PWD]);
    if (!uid) throw new Error("Usuario o clave de Odoo incorrectos");
  }
  if (!campos) await detectarCampos();
  const extra = [campos.ubicacion, campos.deposito].filter(Boolean).map((c) => c.name);
  const regs = await kw("fleet.vehicle", "search_read",
    [[["state_id.name", "in", Object.keys(ETAPAS)]]],
    { fields: ["license_plate", "state_id", "driver_id", "future_driver_id", "model_id", "write_date", ...extra] });
  const lista = regs.flatMap((r) => {
    const placa = (r.license_plate || "").trim().toUpperCase();
    const [grupo, sub] = (r.state_id && MAPA[r.state_id[1].trim().toLowerCase()]) || [];
    if (!placa || !grupo) return [];
    const c = r.future_driver_id || r.driver_id;
    return [{
      id: r.id, estado: r.state_id[1], escrito: fechaOdoo(r.write_date),
      placa, grupo, sub,
      modelo: r.model_id ? r.model_id[1].replace(/\//g, " ") : "",
      conductor: nombre(c ? c[1] : ""),
      ubicacion: campos.ubicacion ? texto(campos.ubicacion, r[campos.ubicacion.name]) : "",
      deposito: campos.deposito ? texto(campos.deposito, r[campos.deposito.name]) : "",
    }];
  });
  await calcularTiempos(lista, inicio);
  return lista.map(({ id, estado, escrito, ...v }) => {
    const e = entrada.get(id);
    return { ...v, desde: e && e.estado === estado ? e.desde : null };
  });
}

export default async (req) => {
  if (!CLAVE) return Response.json({ error: "Falta CLAVE_PANTALLA en Netlify" }, { status: 500, headers: SIN_CACHE });
  if ((new URL(req.url).searchParams.get("clave") || "").trim() !== CLAVE)
    return Response.json({ error: "Clave de acceso incorrecta" }, { status: 401, headers: SIN_CACHE });
  if (!USER || !PWD) return Response.json({ listo: false, error: "Faltan ODOO_USER u ODOO_PASSWORD en Netlify" }, { headers: SIN_CACHE });
  const ahora = Date.now();
  if (cache && ahora - cacheHora < 30000) return Response.json(cache, { headers: CACHE_OK });
  try {
    const vehiculos = await leer(ahora);
    cache = {
      v: 2, listo: true, hora: Math.round(ahora / 1000), error: null, tiempo: modoTiempo,
      campos: { deposito: campos.deposito?.name || null },
      ...compactar(vehiculos),
    };
    cacheHora = ahora;
    return Response.json(cache, { headers: CACHE_OK });
  } catch (e) {
    uid = null;
    campos = null;
    console.error(e);
    return Response.json({ listo: false, error: /incorrectos/.test(e.message) ? e.message : "Sin respuesta de Odoo" }, { headers: CACHE_ERROR });
  }
};

export const config = { path: "/api/vehiculos-respaldo" };
