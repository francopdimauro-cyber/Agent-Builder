/** Quita un comentario `-- …` de una línea, respetando las comillas simples. */
function stripComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") inStr = !inStr;
    else if (!inStr && c === "-" && line[i + 1] === "-") return line.slice(0, i);
  }
  return line;
}

/**
 * Divide un script SQL en sentencias sueltas (para motores que ejecutan una sola sentencia por llamada).
 * Respeta los triggers (su cuerpo BEGIN…END contiene `;`) y elimina los comentarios `--`.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const raw of script.split("\n")) {
    const line = stripComment(raw).trimEnd();
    if (!line.trim()) continue;
    cur += line + "\n";
    const inTrigger = /^\s*create\s+(temp\s+|temporary\s+)?trigger\b/i.test(cur);
    if (inTrigger ? /\bend\s*;$/i.test(line) : line.endsWith(";")) flush();
  }
  flush();
  return out;
}
