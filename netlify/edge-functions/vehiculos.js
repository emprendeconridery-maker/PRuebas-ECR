// EDGE FUNCTION: consulta Odoo casi en tiempo real.
// Corre en la red de Netlify (Edge) y NO consume creditos de "compute".
// Datos privados: Netlify > Environment variables.
const env = (k) => globalThis.Netlify?.env?.get?.(k) ?? globalThis.Deno?.env?.get?.(k) ?? "";
const URL_ODOO = env("ODOO_URL") || "https://ridery-odoo.ridery.app";
const DB = env("ODOO_DB") || "ridery_odoo";
const USER = env("ODOO_USER").trim();
const PWD = env("ODOO_PASSWORD");
const CLAVE = env("CLAVE_PANTALLA").trim();
const NOMBRE = env("NOMBRE_CONDUCTOR") || "corto"; // corto | completo | ninguno
const CAMPO_UBIC = env("CAMPO_UBICACION"); // opcional: nombre tecnico
const CAMPO_DEP = env("CAMPO_DEPOSITO");   // opcional: nombre tecnico
const MODELO_SERV = env("MODELO_SERVICIOS") || "fleet.vehicle.log.services"; // ordenes de servicio
const TIEMPOS = env("TIEMPOS") === "1"; // temporizadores (vista administrativa): apagados para ahorrar

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
// Todas las pantallas comparten la misma respuesta durante 10 segundos:
// 20 TVs generan practicamente las mismas consultas a Odoo que 1 TV.
const CACHE_OK = { "Content-Type": "application/json", "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": "public, s-maxage=10, stale-while-revalidate=10" };
const CACHE_ERROR = { "Content-Type": "application/json", "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": "public, s-maxage=20" };
const huella = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const G = ["recepcion", "mantenimiento", "calidad", "listo"];
const S = ["", "Prolongado", "Esperando repuestos", "Rotulado"];

// Respuesta compacta (menos datos = menos consumo)
function compactar(vs) {
  const m = [], d = [], im = new Map(), id = new Map();
  const idx = (arr, mapa, v) => { if (!v) return -1; if (!mapa.has(v)) { mapa.set(v, arr.length); arr.push(v); } return mapa.get(v); };
  const o = [], io = new Map(), t = [], it = new Map();
  const x = vs.map((v) => [v.placa, G.indexOf(v.grupo), Math.max(0, S.indexOf(v.sub)), idx(m, im, v.modelo), v.conductor || "", idx(d, id, v.deposito), v.desde ? Math.round(v.desde) : 0, idx(o, io, v.orden), idx(t, it, (v.tipos || []).join("|"))]);
  return { m, d, o, t, x };
}

let uid = null, campos = null, modoTiempo = "historial";
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
// Estado de la orden de servicio (Nuevo, Evaluacion tecnica, En curso, Hecho, Cancelado, Paralizado...)
let servicio = null, tipoServ = null, CTX = {}; // campos detectados; false = no disponible
async function detectarServicio() {
  try {
    // Idioma del usuario, para que los estados salgan igual que en Odoo (en espanol)
    try { const u = await kw("res.users", "read", [[uid]], { fields: ["lang"] }); if (u?.[0]?.lang) CTX = { lang: u[0].lang }; } catch (e) { /* sin idioma */ }
    const f = await kw(MODELO_SERV, "fields_get", [], { attributes: ["string", "type", "selection", "relation"], context: CTX });
    const sel = Object.entries(f).find(([, v]) => v.type === "selection" && (v.selection || []).some((o) => /evaluacion|paraliz/.test(normal(o[1]))));
    const etapa = Object.entries(f).find(([, v]) => v.type === "many2one" && /stage/.test(v.relation || ""));
    const c = sel || (f.state ? ["state", f.state] : etapa);
    servicio = c && f.vehicle_id ? { name: c[0], ...c[1] } : false;
    tipoServ = f.service_type_id ? "service_type_id" : Object.entries(f).find(([, v]) => v.type === "many2one" && /service.?type/.test(v.relation || ""))?.[0] || null;
  } catch (e) {
    console.error("Ordenes de servicio no disponibles:", e.message);
    servicio = false;
  }
}
// "MANTENIMIENTO CORRECTIVO" -> "Correctivo"; "MANTENIMIENTO PREVENTIVO" -> "Preventivo"
const tipoCorto = (t) => { const n = normal(t); return /correctiv/.test(n) ? "Correctivo" : /preventiv/.test(n) ? "Preventivo" : t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : ""; };
const cerrada = (t) => /hecho|done|cancel|terminad|finaliz/.test(normal(t));
async function estadosServicio(lista) {
  const ids = lista.filter((v) => v.grupo === "mantenimiento").map((v) => v.id);
  if (!ids.length) return;
  if (servicio === null) await detectarServicio();
  if (!servicio) return;
  try {
    const regs = await kw(MODELO_SERV, "search_read", [[["vehicle_id", "in", ids]]],
      { fields: ["vehicle_id", servicio.name, ...(tipoServ ? [tipoServ] : [])], order: "id desc", limit: 400, context: CTX });
    const info = new Map();
    for (const r of regs) {
      if (!r.vehicle_id) continue;
      const est = texto(servicio, r[servicio.name]);
      const tipo = tipoServ ? tipoCorto(texto({ type: "many2one" }, r[tipoServ])) : "";
      let i = info.get(r.vehicle_id[0]);
      if (!i) { i = { orden: est, abiertos: [], ultimo: tipo }; info.set(r.vehicle_id[0], i); } // la mas reciente
      if (tipo && !cerrada(est) && !i.abiertos.includes(tipo)) i.abiertos.push(tipo); // ordenes abiertas
    }
    for (const v of lista) {
      if (v.grupo !== "mantenimiento") continue;
      const i = info.get(v.id);
      v.orden = i?.orden || "";
      v.tipos = i ? (i.abiertos.length ? i.abiertos : i.ultimo ? [i.ultimo] : []).slice(0, 2) : [];
    }
  } catch (e) {
    console.error("No se pudieron leer las ordenes:", e.message);
  }
}

async function calcularTiempos(lista, inicio) {
  const faltan = lista.filter((r) => entrada.get(r.id)?.estado !== r.estado);
  if (!faltan.length) return;
  if (modoTiempo === "historial") {
    if (Date.now() - inicio > 3000) return; // se completa en la siguiente consulta
    const lote = faltan.slice(0, 8);
    try {
      const ids = await kw("mail.message", "search",
        [[["model", "=", "fleet.vehicle"], ["res_id", "in", lote.map((r) => r.id)], ["message_type", "=", "notification"]]],
        { order: "id desc", limit: 240 });
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
    { fields: ["license_plate", "state_id", "driver_id", "future_driver_id", "model_id", ...(TIEMPOS ? ["write_date"] : []), ...extra] });
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
  await estadosServicio(lista);
  if (!TIEMPOS) return lista.map(({ id, estado, escrito, ...v }) => ({ ...v, desde: 0 }));
  await calcularTiempos(lista, inicio);
  return lista.map(({ id, estado, escrito, ...v }) => {
    const e = entrada.get(id);
    // Mientras se lee el historial se usa la ultima modificacion (exacta para cambios recientes)
    return { ...v, desde: e && e.estado === estado ? e.desde : escrito };
  });
}

export default async (req) => {
  if (!CLAVE) return Response.json({ error: "Falta CLAVE_PANTALLA en Netlify" }, { status: 500, headers: SIN_CACHE });
  if ((new URL(req.url).searchParams.get("clave") || "").trim() !== CLAVE)
    return Response.json({ error: "Clave de acceso incorrecta" }, { status: 401, headers: SIN_CACHE });
  if (!USER || !PWD) return Response.json({ listo: false, error: "Faltan ODOO_USER u ODOO_PASSWORD en Netlify" }, { headers: SIN_CACHE });
  try {
    const vehiculos = await leer(Date.now());
    const cuerpo = JSON.stringify({ v: 3, listo: true, error: null, tiempo: modoTiempo, campos: { deposito: campos.deposito?.name || null }, ...compactar(vehiculos) });
    const etag = `W/"${huella(cuerpo)}"`;
    const h = { ...CACHE_OK, ETag: etag };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: h });
    return new Response(cuerpo, { headers: h });
  } catch (err) {
    uid = null;
    campos = null;
    console.error(err);
    return new Response(JSON.stringify({ listo: false, error: /incorrectos/.test(err.message) ? err.message : "Sin respuesta de Odoo" }), { headers: CACHE_ERROR });
  }
};

export const config = { path: "/api/vehiculos", cache: "manual" };
