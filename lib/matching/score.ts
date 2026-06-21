/**
 * Motor de puntuación de coincidencias forenses.
 *
 * Compara un reporte de persona desaparecida (datos ANTE MORTEM) contra un
 * registro de restos no identificados (datos POST MORTEM) y devuelve un
 * puntaje de 0 a 100 que estima qué tan probable es que sean la misma persona.
 *
 * Idea central (del documento del proyecto): no todas las características valen
 * igual. Un tatuaje o una seña particular es MUCHO más identificante que el
 * sexo o la estatura. Por eso cada variable tiene un "peso" distinto.
 *
 * Cómo se calcula el porcentaje (lo afinado en esta versión):
 *   1. Cada variable comparable aporta una fracción [0..1] de su peso según
 *      qué tan bien coincide (no es "todo o nada").
 *   2. El porcentaje NO es la suma cruda de puntos, sino qué proporción de la
 *      evidencia *disponible* corrobora la coincidencia:
 *          compatibilidad = puntos_obtenidos / evidencia_comparable
 *      Así, dos registros con pocos datos pero todos coincidentes no inflan el
 *      número, y dos registros con muchos datos coincidentes sí llegan alto.
 *   3. Hay un PISO de evidencia (no se puede llegar a 100% coincidiendo solo en
 *      el sexo) y un TECHO sin señas particulares (sin un rasgo distintivo en
 *      común, la certeza queda acotada por más que cuadre la demografía).
 *
 * Este archivo es lógica PURA (sin base de datos): se reusa en el script de
 * cruce masivo, en la API de búsqueda y en cualquier futuro cliente.
 */

// ---------------------------------------------------------------------------
// Pesos: importancia relativa de cada variable. Suman 100.
// Ajusta estos números para afinar el algoritmo.
// ---------------------------------------------------------------------------
export const PESOS = {
  rasgos: 45, // tatuajes y señas particulares -> lo más identificante
  edad: 18,
  estatura: 14,
  sexo: 9,
  lugar: 8,
  fecha: 6,
} as const;

// --- Parámetros de afinamiento ---
const TOL_EDAD = 5; // años de tolerancia fuera del rango de edad forense
const TOL_ESTATURA_EXACTA = 3; // cm: hasta aquí cuenta como "misma estatura"
const TOL_ESTATURA_MAX = 12; // cm: más allá de esto, la estatura no suma
const MAX_AÑOS_FECHA = 5; // si el hallazgo es >5 años tras la desaparición, no suma

// Evidencia mínima: aunque solo haya una variable comparable, el porcentaje se
// calcula como si hubiera al menos esta cantidad de "peso" en juego. Evita que
// coincidir únicamente en el sexo (9 pts) se vea como 100%.
const PISO_EVIDENCIA = 50;
// Sin ninguna seña particular en común, la certeza se acota a este techo, por
// muy bien que cuadre la demografía (edad, estatura, lugar, fecha, sexo).
const TECHO_SIN_SEÑAS = 75;
// Coincidencias por debajo de esto se consideran ruido y se reportan como 0.
const MINIMO_RELEVANTE = 8;

// ---------------------------------------------------------------------------
// Tipos de entrada (solo los campos que necesita el motor).
// ---------------------------------------------------------------------------
export interface PersonaAM {
  id: number;
  sexo: string;
  edad: number | null;
  estatura: number | null;
  fecha_desaparicion: string; // "YYYY-MM-DD"
  ultimo_lugar_id: number | null;
  estado: string | null; // estado del último lugar, resuelto desde `lugares`
  rasgos: unknown; // jsonb (puede ser texto u objeto)
}

export interface ForensePM {
  id: number;
  sexo: string;
  edad_inicial: number | null;
  edad_final: number | null;
  estatura: number | null;
  fecha_hallazgo: string; // "YYYY-MM-DD"
  lugar_hallazgo_id: number | null;
  estado: string | null; // estado del lugar de hallazgo, resuelto desde `lugares`
  rasgos: unknown; // jsonb (objeto: {tatuajes, senas_particulares, ...})
}

export interface Resultado {
  puntaje: number; // 0 a 100 (porcentaje de compatibilidad)
  razon: string; // explicación legible de por qué coinciden
  descartado: boolean; // true = imposible que sean la misma persona
}

// ---------------------------------------------------------------------------
// Utilidades de texto para comparar rasgos.
// ---------------------------------------------------------------------------

/** Quita acentos y pasa a minúsculas: "Antebrazó" -> "antebrazo". */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // marcas de acento combinantes
}

// Palabras demasiado comunes o genéricas: no aportan a la identificación.
const VACIAS = new Set([
  "para", "como", "pero", "porque", "este", "esta", "esto", "esos", "esas",
  "unos", "unas", "una", "uno", "del", "los", "las", "con", "sin", "que",
  "color", "colores", "marca", "talla", "tinta", "negro", "negra", "blanco",
  "blanca", "visible", "parte", "lado", "tipo", "presenta", "localizado",
  "localizada", "ambos", "ambas", "sobre", "tres", "dos", "cual", "cuales",
  "leyenda", "figura", "claves", "palabras", "tono", "izquierdo", "izquierda",
  "derecho", "derecha", "anterior", "posterior", "superior", "inferior",
  "aproximadamente", "particular", "particulares", "senas", "seña", "señas",
  "cuerpo", "zona", "area", "region", "pequeño", "pequena", "grande", "varios",
  "varias", "diversos", "diversas", "tiene", "tienen", "aparente", "mismo",
]);

/** Convierte un texto en un conjunto de palabras clave significativas. */
export function tokens(texto: string): Set<string> {
  const set = new Set<string>();
  for (const palabra of normalizar(texto).split(/[^a-z0-9ñ]+/)) {
    if (palabra.length >= 4 && !VACIAS.has(palabra)) set.add(palabra);
  }
  return set;
}

/**
 * Raíz aproximada de una palabra (primeros 6 caracteres). Permite emparejar
 * variantes: "cicatriz"/"cicatrices", "tatuaje"/"tatuajes", "lunar"/"lunares".
 */
function raiz(palabra: string): string {
  return palabra.length > 6 ? palabra.slice(0, 6) : palabra;
}

/**
 * Aplana el campo `rasgos` (jsonb) a un texto. En `forense` es un objeto
 * {tatuajes, senas_particulares, ...}; en `persona` suele ser texto libre.
 * Con `claves` se eligen solo ciertos campos (ej. los más identificantes).
 */
export function textoDeRasgos(rasgos: unknown, claves?: string[]): string {
  if (rasgos == null) return "";
  if (typeof rasgos === "string") return rasgos;
  if (typeof rasgos === "object") {
    const obj = rasgos as Record<string, unknown>;
    const valores = claves ? claves.map((k) => obj[k]) : Object.values(obj);
    return valores.filter((v): v is string => typeof v === "string").join(" ");
  }
  return String(rasgos);
}

/** Calcula directamente las palabras clave de los rasgos de un forense. */
export function tokensForense(forense: ForensePM): Set<string> {
  return tokens(textoDeRasgos(forense.rasgos, ["tatuajes", "senas_particulares"]));
}

/** Calcula las palabras clave de los rasgos de una persona. */
export function tokensPersona(persona: PersonaAM): Set<string> {
  return tokens(textoDeRasgos(persona.rasgos));
}

const sexoConocido = (s: string) => s === "Masculino" || s === "Femenino";

/** ¿Es el mismo estado? Compara sin acentos ni mayúsculas ("JALISCO" == "Jalisco"). */
function mismoEstado(a: string, b: string): boolean {
  return normalizar(a.trim()) === normalizar(b.trim());
}

// ---------------------------------------------------------------------------
// Función principal de puntuación.
// ---------------------------------------------------------------------------

/**
 * Devuelve la compatibilidad (0-100) entre una persona y un forense.
 * Para acelerar lotes grandes se pueden pasar las palabras clave ya calculadas.
 */
export function puntuar(
  persona: PersonaAM,
  forense: ForensePM,
  pre?: { tokensPersona?: Set<string>; tokensForense?: Set<string> },
): Resultado {
  // --- Filtros duros: si se cumplen, es IMPOSIBLE que sean la misma persona ---

  // 1) Sexos conocidos y distintos.
  if (sexoConocido(persona.sexo) && sexoConocido(forense.sexo) && persona.sexo !== forense.sexo) {
    return { puntaje: 0, razon: "Sexos distintos", descartado: true };
  }
  // 2) No se puede hallar un cuerpo ANTES de que la persona desapareciera.
  if (persona.fecha_desaparicion > forense.fecha_hallazgo) {
    return { puntaje: 0, razon: "Hallazgo anterior a la desaparición", descartado: true };
  }

  // `puntos` = evidencia que corrobora; `evidencia` = evidencia comparable total.
  // El porcentaje final es puntos / evidencia (ver cabecera del archivo).
  let puntos = 0;
  let evidencia = 0;
  const razones: string[] = [];
  let huboSeña = false;

  // --- Sexo: solo es comparable si AMBOS lo tienen definido ---
  if (sexoConocido(persona.sexo) && sexoConocido(forense.sexo)) {
    evidencia += PESOS.sexo;
    // (los sexos distintos ya se descartaron arriba: aquí siempre coinciden)
    puntos += PESOS.sexo;
    razones.push(`sexo coincide (${persona.sexo})`);
  }

  // --- Edad: la persona cae dentro (o cerca) del rango estimado del forense ---
  if (persona.edad != null && forense.edad_inicial != null) {
    evidencia += PESOS.edad;
    const ini = forense.edad_inicial;
    const fin = forense.edad_final ?? forense.edad_inicial;
    if (persona.edad >= ini && persona.edad <= fin) {
      puntos += PESOS.edad;
      razones.push(`edad ${persona.edad} dentro del rango ${ini}-${fin}`);
    } else {
      const dist = persona.edad < ini ? ini - persona.edad : persona.edad - fin;
      if (dist <= TOL_EDAD) {
        puntos += PESOS.edad * (1 - dist / TOL_EDAD) * 0.6;
        razones.push(`edad ${persona.edad} cercana al rango ${ini}-${fin}`);
      }
    }
  }

  // --- Estatura: cuanto más parecida, más fracción del peso ---
  if (persona.estatura != null && forense.estatura != null) {
    evidencia += PESOS.estatura;
    const d = Math.abs(persona.estatura - forense.estatura);
    if (d <= TOL_ESTATURA_EXACTA) {
      puntos += PESOS.estatura;
      razones.push(`estatura casi igual (${persona.estatura} vs ${forense.estatura} cm)`);
    } else if (d <= TOL_ESTATURA_MAX) {
      const factor = 1 - (d - TOL_ESTATURA_EXACTA) / (TOL_ESTATURA_MAX - TOL_ESTATURA_EXACTA);
      puntos += PESOS.estatura * factor;
      razones.push(`estatura parecida (${persona.estatura} vs ${forense.estatura} cm)`);
    }
  }

  // --- Lugar: mismo estado. Señal SUAVE (suma, nunca descarta): es común que
  // alguien desaparezca en un estado y sus restos aparezcan en otro. ---
  if (persona.estado && forense.estado) {
    evidencia += PESOS.lugar;
    if (mismoEstado(persona.estado, forense.estado)) {
      puntos += PESOS.lugar;
      razones.push(`mismo estado (${forense.estado})`);
    }
  }

  // --- Cercanía temporal: hallazgo poco después de la desaparición = más probable ---
  const dias =
    (Date.parse(forense.fecha_hallazgo) - Date.parse(persona.fecha_desaparicion)) / 86_400_000;
  if (Number.isFinite(dias) && dias >= 0) {
    evidencia += PESOS.fecha;
    const años = dias / 365;
    if (años <= MAX_AÑOS_FECHA) {
      puntos += PESOS.fecha * (1 - años / MAX_AÑOS_FECHA);
      if (años <= 1) razones.push("hallazgo dentro del primer año");
    }
  }

  // --- Rasgos: señas/tatuajes en común (lo más identificante) ---
  // Solo es "comparable" si AMBOS describieron rasgos. Si coincide al menos una
  // seña, libera el techo y se vuelve la evidencia más fuerte.
  const tP = pre?.tokensPersona ?? tokensPersona(persona);
  const tF = pre?.tokensForense ?? tokensForense(forense);
  if (tP.size > 0 && tF.size > 0) {
    evidencia += PESOS.rasgos;
    const raicesF = new Set([...tF].map(raiz));
    const comunes = [...tP].filter((t) => raicesF.has(raiz(t)));
    if (comunes.length > 0) {
      huboSeña = true;
      // Rendimientos decrecientes: 1 seña ya es fuerte, varias acercan al máximo.
      const fraccion = 1 - Math.pow(0.5, comunes.length);
      puntos += PESOS.rasgos * fraccion;
      razones.push(`señas en común: ${comunes.slice(0, 6).join(", ")}`);
    }
  }

  // --- Normalización a porcentaje de compatibilidad ---
  const base = Math.max(evidencia, PISO_EVIDENCIA);
  let compat = (puntos / base) * 100;
  if (!huboSeña) compat = Math.min(compat, TECHO_SIN_SEÑAS);
  if (compat < MINIMO_RELEVANTE) compat = 0;

  return {
    puntaje: Math.round(compat * 100) / 100, // 2 decimales (columna numeric(5,2))
    razon: razones.join("; ") || "Sin coincidencias relevantes",
    descartado: false,
  };
}
