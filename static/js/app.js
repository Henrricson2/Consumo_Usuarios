/* =====================================================================================
   app.js · Lógica de las páginas.

   Cada HTML de templates/ declara <body data-pagina="..."> y este archivo inicia la página que corresponde:
     inicio      templates/index.html                         contenedor con dos pestañas (iframes)
     exploratorio templates/dashboard_analisis_exploratorio.html  usa window.DATOS_EDA
     prediccion  templates/dashboard_prediccion.html          usa window.DATOS_PRED
   Los datos los genera `python -m src.prediccion` en static/js/data.js; los componentes visuales están en charts.js.
   ===================================================================================== */
'use strict';

/* =====================================================================================
   Motor de cálculo del análisis exploratorio (JavaScript puro).
   Todas las métricas salen de una sola tabla de hechos cuenta-mes, con los filtros de cada pestaña.
   ===================================================================================== */
const Motor = (() => {
  function preparar(D) {
    const nM = D.meses.length, nC = D.cuentas.cod.length, nU = D.usuarios.cod.length;
    const anio = D.meses.map(s => +s.slice(0, 4)), mes = D.meses.map(s => +s.slice(5, 7));
    return { D, nM, nC, nU, n: D.hechos.c.length,
      hc: Int32Array.from(D.hechos.c), hm: Int16Array.from(D.hechos.m), hv: Float64Array.from(D.hechos.v),
      usrC: Int32Array.from(D.cuentas.usr), cicC: Int8Array.from(D.cuentas.ciclo), anio, mes, anios: [...new Set(anio)] };
  }
  const suma = (a, i, j) => { let s = 0; for (let k = i; k <= j; k++) s += a[k]; return s; };
  const mediana = a => { if (!a.length) return NaN; const b = Float64Array.from(a).sort(), n = b.length;
    return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };
  const varPct = (a, b) => (b > 0 ? a / b - 1 : null);
  const ia = (P, a) => P.anios.indexOf(a);

  function demanda(P, f) {
    const { nM, nU, D } = P, d = f.desde, h = f.hasta;
    const serie = new Float64Array(nM), porU = new Float64Array(nU), porSeg = D.segmentos.map(() => new Float64Array(nM));
    for (let i = 0; i < P.n; i++) {
      const c = P.hc[i], m = P.hm[i], v = P.hv[i], u = P.usrC[c];
      serie[m] += v; porSeg[D.usuarios.seg[u]][m] += v; if (m >= d && m <= h) porU[u] += v;
    }
    const nMes = h - d + 1, total = suma(serie, d, h), media = total / nMes;
    const prev = d - 12 >= 0 ? suma(serie, d - 12, h - 12) : null;
    let pico = d, valle = d;
    for (let m = d; m <= h; m++) { if (serie[m] > serie[pico]) pico = m; if (serie[m] < serie[valle]) valle = m; }
    const orden = [...porU.keys()].filter(u => porU[u] > 0).sort((a, b) => porU[b] - porU[a]);
    const top10 = orden.slice(0, 10).reduce((s, u) => s + porU[u], 0);
    let sc = 0; for (let m = d; m <= h; m++) sc += (serie[m] - media) ** 2;
    const dif = []; for (let m = d + 1; m <= h; m++) dif.push(serie[m] - serie[m - 1]);
    const med = mediana(dif), mad = mediana(dif.map(x => Math.abs(x - med))), atipicos = [];
    if (mad > 0) for (let m = d + 1; m <= h; m++) {
      const z = 0.6745 * (serie[m] - serie[m - 1] - med) / mad;
      if (Math.abs(z) > 3.5) atipicos.push({ m, z, cambio: varPct(serie[m], serie[m - 1]) });
    }
    const mm12 = Array.from({ length: nM }, (_, m) => (m >= 11 ? suma(serie, m - 11, m) / 12 : null));
    const yoy = Array.from({ length: nM }, (_, m) => (m >= 12 ? varPct(serie[m], serie[m - 12]) : null));
    const mesCorte = P.mes[h];
    const anual = P.anios.map(a => {
      let total = 0, meses = 0, acum = 0, mesesAcum = 0;
      for (let m = d; m <= h; m++) if (P.anio[m] === a) { total += serie[m]; meses++; if (P.mes[m] <= mesCorte) { acum += serie[m]; mesesAcum++; } }
      return { anio: a, total, meses, acum, mesesAcum };
    }).filter(x => x.meses > 0);
    const calor = anual.map(() => new Array(12).fill(null));
    for (let m = d; m <= h; m++) calor[anual.findIndex(x => x.anio === P.anio[m])][P.mes[m] - 1] = serie[m];
    const segAnual = D.segmentos.map((_, s) => anual.map(x => { let t = 0; for (let m = d; m <= h; m++) if (P.anio[m] === x.anio) t += porSeg[s][m]; return t; }));
    return { serie, mm12, yoy, segAnual, porU, orden, total, media, prev, nMes, var: prev != null ? varPct(total, prev) : null,
      pico, valle, top10: total > 0 ? top10 / total : null, cv: media > 0 ? Math.sqrt(sc / Math.max(nMes - 1, 1)) / media : null,
      atipicos, anual, calor, mesCorte };
  }

  function usuarios(P, f) {
    const { nM, nU, nC, D } = P, d = f.desde, h = f.hasta;
    const act = new Uint8Array(nU * nM), ctaRango = new Uint8Array(nC);
    for (let i = 0; i < P.n; i++) { const c = P.hc[i], m = P.hm[i]; act[P.usrC[c] * nM + m] = 1; if (m >= d && m <= h) ctaRango[c] = 1; }
    const nCtas = new Int32Array(nU); for (let c = 0; c < nC; c++) if (ctaRango[c]) nCtas[P.usrC[c]]++;
    const activos = new Int32Array(nM), primero = new Int32Array(nU).fill(-1), ultimo = new Int32Array(nU).fill(-1), mesesRango = new Int32Array(nU);
    for (let u = 0; u < nU; u++) for (let m = 0; m < nM; m++) if (act[u * nM + m]) {
      activos[m]++; if (primero[u] < 0) primero[u] = m; ultimo[u] = m; if (m >= d && m <= h) mesesRango[u]++;
    }
    const enPeriodo = []; for (let u = 0; u < nU; u++) if (mesesRango[u] > 0) enPeriodo.push(u);
    const esNuevo = u => primero[u] > 0 && primero[u] >= d && primero[u] <= h;
    const esSalida = u => ultimo[u] < nM - 1 && ultimo[u] >= d && ultimo[u] <= h;
    const flujos = P.anios.map(a => ({ anio: a, nuevos: 0, salidas: 0 }));
    for (const u of enPeriodo) {
      if (esNuevo(u)) flujos[ia(P, P.anio[primero[u]])].nuevos++;
      if (esSalida(u)) flujos[ia(P, P.anio[ultimo[u]])].salidas++;
    }
    const cuenta = (arr, k, n) => { const r = new Array(n).fill(0); arr.forEach(u => r[k(u)]++); return r; };
    const nPerm = Math.ceil((h - d + 1) / 12);
    return { activos, enPeriodo, nuevos: enPeriodo.filter(esNuevo), salidas: enPeriodo.filter(esSalida),
      flujos: flujos.filter(x => x.anio >= P.anio[d] && x.anio <= P.anio[h]), nCtas, primero, ultimo, mesesRango,
      dist: { seg: cuenta(enPeriodo, u => D.usuarios.seg[u], D.segmentos.length), tam: cuenta(enPeriodo, u => D.usuarios.tam[u], D.tamanos.length),
        tipo: cuenta(enPeriodo, u => D.usuarios.tipo[u], D.tipos.length),
        ctas: cuenta(enPeriodo, u => (nCtas[u] === 1 ? 0 : nCtas[u] <= 5 ? 1 : nCtas[u] <= 20 ? 2 : 3), 4),
        perm: cuenta(enPeriodo, u => Math.min(Math.floor((mesesRango[u] - 1) / 12), nPerm - 1), nPerm) },
      fin: activos[h], hace12: h - 12 >= 0 ? activos[h - 12] : null, var12: h - 12 >= 0 ? varPct(activos[h], activos[h - 12]) : null,
      pctUna: enPeriodo.length ? enPeriodo.filter(u => nCtas[u] === 1).length / enPeriodo.length : null,
      medCtas: mediana(enPeriodo.map(u => nCtas[u])),
      promCtas: enPeriodo.length ? enPeriodo.reduce((s, u) => s + nCtas[u], 0) / enPeriodo.length : null };
  }

  function cuentas(P, f) {
    const { nM, nC, nU, D } = P, d = f.desde, h = f.hasta;
    const reg = new Int32Array(nM), cero = new Int32Array(nM), porCiclo = D.ciclos.map(() => new Int32Array(nM));
    const prim = new Int32Array(nC).fill(-1), ult = new Int32Array(nC).fill(-1), primR = new Int32Array(nC).fill(-1), ultR = new Int32Array(nC).fill(-1);
    const mesesR = new Int32Array(nC), ceroR = new Int32Array(nC), ceroFin = new Uint8Array(nC), regAnio = P.anios.map(() => new Uint8Array(nC));
    for (let i = 0; i < P.n; i++) {
      const c = P.hc[i], m = P.hm[i], z = P.hv[i] === 0;
      reg[m]++; if (z) cero[m]++; porCiclo[P.cicC[c]][m]++;
      if (prim[c] < 0 || m < prim[c]) prim[c] = m; if (m > ult[c]) ult[c] = m;
      if (m >= d && m <= h) {
        mesesR[c]++; if (z) ceroR[c]++; if (z && m === h) ceroFin[c] = 1;
        if (primR[c] < 0 || m < primR[c]) primR[c] = m; if (m > ultR[c]) ultR[c] = m;
        regAnio[ia(P, P.anio[m])][c] = 1;
      }
    }
    const enPeriodo = []; for (let c = 0; c < nC; c++) if (mesesR[c] > 0) enPeriodo.push(c);
    const esNueva = c => prim[c] > 0 && prim[c] >= d && prim[c] <= h;
    const esSalida = c => ult[c] < nM - 1 && ult[c] >= d && ult[c] <= h;
    const conVacios = c => ultR[c] - primR[c] + 1 > mesesR[c];
    const anual = P.anios.map((a, k) => ({ anio: a, registradas: regAnio[k].reduce((s, x) => s + x, 0),
      nuevas: enPeriodo.filter(c => esNueva(c) && P.anio[prim[c]] === a).length,
      salidas: enPeriodo.filter(c => esSalida(c) && P.anio[ult[c]] === a).length })).filter(x => x.anio >= P.anio[d] && x.anio <= P.anio[h]);
    const porSeg = new Array(D.segmentos.length).fill(0), porUsr = new Int32Array(nU), estado = [0, 0, 0];
    enPeriodo.forEach(c => { porSeg[D.usuarios.seg[P.usrC[c]]]++; porUsr[P.usrC[c]]++; estado[ultR[c] < h ? 2 : ceroFin[c] ? 1 : 0]++; });
    return { reg, cero, porCiclo, enPeriodo, primR, ultR, mesesR, ceroR, anual, porSeg, porUsr,
      topUsr: [...porUsr.keys()].filter(u => porUsr[u] > 0).sort((a, b) => porUsr[b] - porUsr[a]),
      nuevas: enPeriodo.filter(esNueva).length, salidas: enPeriodo.filter(esSalida).length, vacios: enPeriodo.filter(conVacios).length,
      conVacios, esNueva, esSalida, estado, fin: reg[h], hace12: h - 12 >= 0 ? reg[h - 12] : null,
      var12: h - 12 >= 0 ? varPct(reg[h], reg[h - 12]) : null, pctCeroFin: reg[h] ? cero[h] / reg[h] : null };
  }

  /** Serie mensual de un usuario (todas sus cuentas) o de una cuenta. */
  function serieEntidad(P, tipo, id) {
    const a = new Float64Array(P.nM);
    for (let i = 0; i < P.n; i++) { const c = P.hc[i]; if ((tipo === 'u' ? P.usrC[c] : c) === id) a[P.hm[i]] += P.hv[i]; }
    return a;
  }
  return { preparar, demanda, usuarios, cuentas, serieEntidad };
})();

/* Filtro de período reutilizable: selects Desde/Hasta + atajos. */
function filtroPeriodo(el, meses, estado, alCambiar, atajos = true) {
  const NM = meses.length, ultimoAnio = meses[NM - 1].slice(0, 4), iniAnio = meses.findIndex(m => m.startsWith(ultimoAnio));
  const op = meses.map((m, i) => `<option value="${i}">${UI.mes(m)}</option>`).join('');
  el.innerHTML = `<div class="f-grupo"><span class="f-tit">Período</span>
      <div class="f-fila"><select data-f="desde" aria-label="Mes inicial">${op}</select>–<select data-f="hasta" aria-label="Mes final">${op}</select></div>
      ${atajos ? `<div class="f-rapidos"><button class="rapido" data-r="todo">Todo</button><button class="rapido" data-r="12">Últ. 12 meses</button>
      <button class="rapido" data-r="36">Últ. 36 meses</button><button class="rapido" data-r="anio">${ultimoAnio}</button></div>` : ''}</div>
    <div class="f-resumen" aria-live="polite"></div>`;
  const sinc = () => {
    el.querySelector('[data-f="desde"]').value = estado.desde; el.querySelector('[data-f="hasta"]').value = estado.hasta;
    el.querySelector('.f-resumen').innerHTML = `Período: <b>${UI.mes(meses[estado.desde])} – ${UI.mes(meses[estado.hasta])}</b> (${estado.hasta - estado.desde + 1} meses)`;
  };
  el.addEventListener('change', e => {
    const f = e.target.dataset.f; if (!f) return;
    estado[f] = +e.target.value;
    if (estado.desde > estado.hasta) { if (f === 'desde') estado.hasta = estado.desde; else estado.desde = estado.hasta; }
    sinc(); alCambiar();
  });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-r]'); if (!b) return;
    estado.hasta = NM - 1;
    estado.desde = Math.max(0, { todo: 0, 12: NM - 12, 36: NM - 36, anio: iniAnio }[b.dataset.r]);
    sinc(); alCambiar();
  });
  sinc();
}

/* =====================================================================================
   Página · Análisis exploratorio
   ===================================================================================== */
function paginaExploratorio() {
  const D = window.DATOS_EDA;
  if (!D) { document.querySelector('main').innerHTML = '<p class="nota">No se encontró static/js/data.js. Ejecute <code>python -m src.prediccion</code>.</p>'; return; }
  window.__seriesDetalleCargadas = true;   // las series por usuario y cuenta ya vienen incluidas
  const P = Motor.preparar(D), NM = P.nM, C = UI.COL, M = D.meta;
  const COL_SEG = [C.naranja, C.azul, C.aqua], COL_CICLO = [C.azul, C.naranja, C.violeta, C.aqua];
  const COL_TAM = ['#a9c9f1', '#6ea6e8', C.azul, C.azulO], TAM = D.tamanos.map(t => t.split(' (')[0]);
  const FECHAS = D.meses.map(UI.fecha), mesTxt = i => UI.mes(D.meses[i]);
  const etqU = u => D.usuarios.cod[u] + ' · ' + D.usuarios.nom[u];
  const etqC = c => D.cuentas.cod[c] + ' · ' + etqU(D.cuentas.usr[c]);
  const { num, pct, pctS, clase, flecha, corto, dibujar, kpis, tabla } = UI;

  document.getElementById('cab-meta').innerHTML = [['Período', `${mesTxt(0)} – ${mesTxt(NM - 1)}`], ['Usuarios', num(M.n_usuarios)],
    ['Cuentas', num(M.n_cuentas)], ['Consumo total', num(M.kwh_total / 1e6, 1) + ' GWh'], ['Datos generados', M.generado]]
    .map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('');

  UI.tarjetas('g-demanda', [
    { id: 'd-serie', ancho: true, t: 'Evolución histórica del consumo mensual', s: 'GWh por mes · media móvil de 12 meses · picos y cambios atípicos',
      a: 'Los puntos naranja marcan meses cuyo cambio frente al mes anterior es atípico (z robusto > 3,5); la estrella marca el mes de mayor consumo del período.' },
    { id: 'd-anual', t: 'Comparativo anual', s: 'Total del año y acumulado al mismo mes de corte', a: 'Las barras oscuras suman solo hasta el mes de corte, para comparar años con el mismo número de meses.' },
    { id: 'd-yoy', t: 'Variación interanual', s: 'Cambio % de cada mes frente al mismo mes del año anterior', a: 'Elimina el efecto estacional y muestra la tendencia.' },
    { id: 'd-calor', t: 'Mapa de calor año × mes', s: 'GWh · estacionalidad y meses pico', a: 'Colores más oscuros indican mayor consumo.' },
    { id: 'd-seg', t: 'Composición por segmento', s: 'GWh por año y participación de cada segmento', a: 'Municipio de Neiva, los 10 usuarios siguientes de mayor consumo y el resto.' },
    { id: 'd-top', ancho: true, alto: true, t: 'Usuarios de mayor consumo en el período', s: 'Top 15 · MWh y participación', a: 'Los nombres de personas naturales se reemplazan por su código.' },
  ]);
  UI.tarjetas('g-usuarios', [
    { id: 'u-activos', ancho: true, t: 'Evolución de usuarios con registro', s: 'Usuarios con al menos una cuenta registrada en el mes', a: 'Un usuario cuenta en un mes si alguna de sus cuentas tiene registro.' },
    { id: 'u-flujos', t: 'Altas y salidas por año', s: 'Primera aparición y último registro', a: 'Alta: primer registro posterior al inicio de la serie. Salida: último registro anterior al cierre.' },
    { id: 'u-seg', t: 'Distribución por segmento', s: 'Usuarios con registro en el período' },
    { id: 'u-tam', t: 'Distribución por tamaño', s: 'Tramo según consumo promedio mensual', a: 'Categoría fija calculada con toda la serie.' },
    { id: 'u-tipo', t: 'Distribución por tipo de titular', s: 'Persona jurídica o entidad / persona natural' },
    { id: 'u-ctas', t: 'Usuarios según número de cuentas', s: 'Cuentas con registro en el período' },
    { id: 'u-perm', t: 'Permanencia en el período', s: 'Meses con registro por usuario' },
    { id: 'u-serie', ancho: true, herr: true, t: 'Serie mensual por usuario', s: 'Consumo del usuario consolidado seleccionado', a: 'Suma de todas las cuentas del usuario en cada mes del período.' },
    { id: 'u-tabla', ancho: true, tabla: true, t: 'Detalle de usuarios', s: 'Ordene por cualquier columna · descargue en CSV' },
  ]);
  UI.tarjetas('g-cuentas', [
    { id: 'c-activas', ancho: true, t: 'Cuentas registradas por mes', s: 'Con consumo y registradas en cero' },
    { id: 'c-anual', t: 'Comparativo histórico anual', s: 'Registradas, nuevas y que dejan de registrarse' },
    { id: 'c-estado', t: 'Estado al cierre del período', s: 'Situación en el último mes filtrado' },
    { id: 'c-ciclo', t: 'Distribución temporal por ciclo de facturación', s: 'Cuentas registradas por mes y ciclo',
      nota: '<b>Distribución geográfica:</b> la fuente no incluye municipio, zona ni coordenadas, y la dirección es texto libre truncado. Por eso la distribución se presenta por ciclo de facturación y segmento del titular.' },
    { id: 'c-cero', t: 'Cuentas registradas en cero', s: '% de cuentas del mes con 0 kWh' },
    { id: 'c-seg', t: 'Distribución por segmento del titular', s: 'Cuentas con registro en el período' },
    { id: 'c-top', t: 'Usuarios con más cuentas', s: 'Top 12 · escala logarítmica' },
    { id: 'c-serie', herr: true, t: 'Serie mensual por cuenta', s: 'Consumo de la cuenta seleccionada' },
    { id: 'c-tabla', ancho: true, tabla: true, t: 'Detalle de cuentas', s: 'Número de cuenta real · ordene y descargue en CSV' },
  ]);

  const ESTADO = { demanda: { desde: 0, hasta: NM - 1 }, usuarios: { desde: 0, hasta: NM - 1 }, cuentas: { desde: 0, hasta: NM - 1 } };
  const barras = (id, x, y, colores, unidad, total) => dibujar(id, [{ type: 'bar', x, y, marker: { color: colores },
    text: y.map(v => num(v)), textposition: 'outside', cliponaxis: false, textfont: { size: 11, color: C.tinta2 },
    customdata: y.map(v => (total ? v / total * 100 : 0)), hovertemplate: `%{x}<br><b>%{y:,.0f} ${unidad}</b> · %{customdata:.1f} %<extra></extra>` }],
    { showlegend: false, yaxis: { title: { text: unidad[0].toUpperCase() + unidad.slice(1) }, rangemode: 'tozero' }, xaxis: { type: 'category' }, margin: { t: 22 } });

  function serieDetalle(id, tipo, ent, f) {
    const a = Array.from(Motor.serieEntidad(P, tipo, ent)).slice(f.desde, f.hasta + 1), x = FECHAS.slice(f.desde, f.hasta + 1);
    const tot = UI.suma(a), pico = a.indexOf(Math.max(...a));
    document.getElementById(id + '-sub').innerHTML = `Total <b>${num(tot / 1e6, 2)} GWh</b> · promedio ${num(tot / a.length / 1e3, 1)} MWh/mes · pico ${mesTxt(f.desde + pico)}`;
    dibujar(id, [{ type: 'scatter', mode: 'lines+markers', x, y: a.map(v => v / 1e3), line: { color: C.azul, width: 2 }, marker: { size: 4 },
      fill: 'tozeroy', fillcolor: 'rgba(42,120,214,.08)', hovertemplate: '%{x|%B %Y}<br><b>%{y:,.1f} MWh</b><extra></extra>' }],
      { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'MWh' }, rangemode: 'tozero' }, showlegend: false });
    return { a, x };
  }
  function selectorSerie(id, opciones, alCambiar) {
    const h = document.getElementById(id + '-herr');
    h.innerHTML = `<select aria-label="Seleccionar" style="height:32px;border:1px solid var(--borde);border-radius:7px;padding:0 8px;max-width:100%">${opciones.map(([v, t]) => `<option value="${v}">${UI.esc(t)}</option>`).join('')}</select>
      <button class="btn-sec">Descargar serie CSV</button>`;
    const sel = h.querySelector('select');
    sel.addEventListener('change', alCambiar);
    return { sel, btn: h.querySelector('button') };
  }
  function csvSerie(nombre, x, a) {
    const filas = ['Mes;Consumo_kWh', ...x.map((f, i) => `${f.slice(0, 7)};${Math.round(a[i])}`)];
    const el = document.createElement('a');
    el.href = URL.createObjectURL(new Blob(['﻿' + filas.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    el.download = nombre + '.csv'; document.body.appendChild(el); el.click(); setTimeout(() => el.remove(), 300);
  }
  const ordU = [...Array(P.nU).keys()].sort((a, b) => D.usuarios.cod[a].localeCompare(D.usuarios.cod[b]));
  const selU = selectorSerie('u-serie', ordU.map(u => [u, etqU(u)]), () => render.usuarios());
  const ordC = [...Array(P.nC).keys()].sort((a, b) => D.cuentas.cod[a].localeCompare(D.cuentas.cod[b]));
  const selC = selectorSerie('c-serie', ordC.map(c => [c, etqC(c)]), () => render.cuentas());
  selU.btn.addEventListener('click', () => { const s = serieDetalle('u-serie', 'u', +selU.sel.value, ESTADO.usuarios); csvSerie('serie_' + D.usuarios.cod[+selU.sel.value], s.x, s.a); });
  selC.btn.addEventListener('click', () => { const s = serieDetalle('c-serie', 'c', +selC.sel.value, ESTADO.cuentas); csvSerie('serie_' + D.cuentas.cod[+selC.sel.value], s.x, s.a); });

  const render = {
    demanda() {
      const f = ESTADO.demanda, r = Motor.demanda(P, f), d = f.desde, h = f.hasta, G = v => (v == null ? null : v / 1e6);
      kpis('k-demanda', [
        { l: 'Consumo del período', v: num(G(r.total), 1) + ' GWh', d: `${r.nMes} meses · ${num(r.total / 1e3)} MWh`, a: 'Energía activa facturada en los meses seleccionados.' },
        { l: 'Promedio mensual', v: num(G(r.media), 2) + ' GWh', d: 'Coef. de variación ' + pct(r.cv), color: C.aqua, a: 'El coeficiente de variación mide la dispersión entre meses.' },
        { l: 'Variación vs. año anterior', v: `<span class="${clase(r.var)}">${flecha(r.var)}${pctS(r.var)}</span>`, color: C.violeta,
          d: r.prev != null ? `Mismo período: ${num(G(r.prev), 1)} GWh` : 'No hay 12 meses previos', a: 'Compara con los mismos meses del año anterior.' },
        { l: 'Mes pico', v: mesTxt(r.pico), d: `${num(G(r.serie[r.pico]), 2)} GWh · mínimo en ${mesTxt(r.valle)}`, color: C.naranja },
        { l: 'Concentración top 10', v: pct(r.top10), d: `de ${num(r.orden.length)} usuarios con consumo`, color: C.amarillo, a: 'Participación de los 10 usuarios de mayor consumo.' },
        { l: 'Cambios atípicos', v: num(r.atipicos.length), d: 'meses con |z robusto| > 3,5', color: C.rojo, a: 'Cambios mensuales fuera de lo habitual (mediana y MAD).' },
      ]);
      const x = FECHAS.slice(d, h + 1), sl = a => Array.from(a).slice(d, h + 1);
      dibujar('d-serie', [
        { type: 'scatter', mode: 'lines', x, y: sl(r.serie).map(G), name: 'Consumo mensual', line: { color: C.azul, width: 2.2 }, fill: 'tozeroy', fillcolor: 'rgba(42,120,214,.08)', hovertemplate: '<b>%{y:,.2f} GWh</b><extra>Consumo</extra>' },
        { type: 'scatter', mode: 'lines', x, y: r.mm12.slice(d, h + 1).map(G), name: 'Media móvil 12 meses', line: { color: C.tinta2, width: 1.5, dash: 'dot' }, hovertemplate: '%{y:,.2f} GWh<extra>Media 12 m</extra>' },
        { type: 'scatter', mode: 'markers', x: r.atipicos.map(a => FECHAS[a.m]), y: r.atipicos.map(a => G(r.serie[a.m])), name: 'Cambio atípico', marker: { color: C.naranja, size: 10, line: { color: '#fff', width: 1.5 } }, hovertemplate: 'Atípico<extra></extra>' },
        { type: 'scatter', mode: 'markers', x: [FECHAS[r.pico]], y: [G(r.serie[r.pico])], name: 'Mes pico', marker: { symbol: 'star', color: C.rojo, size: 15 }, hovertemplate: '%{y:,.2f} GWh<extra>Mes pico</extra>' },
      ], { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'GWh' }, rangemode: 'tozero' }, hovermode: 'x unified' });
      const an = r.anual, ta = an.map(a => String(a.anio)), mc = UI.MESES[r.mesCorte - 1];
      const vA = an.map((a, i) => (i && an[i - 1].acum > 0 && a.mesesAcum === an[i - 1].mesesAcum ? (a.acum / an[i - 1].acum - 1) * 100 : null));
      dibujar('d-anual', [
        { type: 'bar', x: ta, y: an.map(a => G(a.total)), name: 'Total del año en el período', marker: { color: '#a9c9f1' }, customdata: an.map(a => a.meses), hovertemplate: '%{x}: <b>%{y:,.1f} GWh</b> (%{customdata} meses)<extra></extra>' },
        { type: 'bar', x: ta, y: an.map(a => G(a.acum)), name: `Acumulado a ${mc}`, marker: { color: C.azulO }, text: vA.map(v => (v == null ? '' : (v > 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + '%')),
          textposition: 'outside', textfont: { size: 10 }, cliponaxis: false, hovertemplate: `%{x} · hasta ${mc}: <b>%{y:,.1f} GWh</b><extra></extra>` },
      ], { barmode: 'group', yaxis: { title: { text: 'GWh' } }, xaxis: { type: 'category' }, margin: { t: 16 } });
      const yy = r.yoy.slice(d, h + 1);
      dibujar('d-yoy', [{ type: 'bar', x, y: yy.map(v => (v == null ? null : v * 100)), marker: { color: yy.map(v => (v == null ? C.rejilla : v >= 0 ? C.aqua : C.rojo)) },
        hovertemplate: '%{x|%B %Y}<br><b>%{y:+.1f} %</b><extra></extra>' }], { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'Variación %' }, ticksuffix: ' %', zeroline: true, zerolinecolor: '#bdbdb8' }, showlegend: false, bargap: 0.15 });
      dibujar('d-calor', [{ type: 'heatmap', x: UI.MESES, y: ta, z: r.calor.map(fl => fl.map(G)), colorscale: UI.ESCALA, xgap: 2, ygap: 2, texttemplate: '%{z:.1f}', textfont: { size: 10 },
        hoverongaps: false, colorbar: { title: { text: 'GWh', side: 'right' }, thickness: 10, outlinewidth: 0 }, hovertemplate: '%{x} %{y}: <b>%{z:,.2f} GWh</b><extra></extra>' }],
        { yaxis: { autorange: 'reversed', type: 'category', gridcolor: 'rgba(0,0,0,0)' }, xaxis: { gridcolor: 'rgba(0,0,0,0)', side: 'top', type: 'category' }, margin: { t: 26 } });
      const tot = an.map((_, i) => r.segAnual.reduce((s, sg) => s + sg[i], 0));
      dibujar('d-seg', D.segmentos.map((sg, s) => ({ type: 'bar', x: ta, y: r.segAnual[s].map(G), name: sg, marker: { color: COL_SEG[s] },
        customdata: r.segAnual[s].map((v, i) => (tot[i] ? v / tot[i] * 100 : 0)), hovertemplate: `${sg}<br>%{x}: <b>%{y:,.1f} GWh</b> (%{customdata:.1f} %)<extra></extra>` })),
        { barmode: 'stack', yaxis: { title: { text: 'GWh' } }, xaxis: { type: 'category' } });
      const top = r.orden.slice(0, 15).reverse();
      dibujar('d-top', [{ type: 'bar', orientation: 'h', y: top.map(u => corto(etqU(u), 46)), x: top.map(u => r.porU[u] / 1e3), marker: { color: top.map(u => COL_SEG[D.usuarios.seg[u]]) },
        text: top.map(u => pct(r.porU[u] / r.total)), textposition: 'outside', textfont: { size: 10.5 }, cliponaxis: false, customdata: top.map(u => etqU(u)),
        hovertemplate: '%{customdata}<br><b>%{x:,.0f} MWh</b><extra></extra>' }], { xaxis: { title: { text: 'MWh en el período' }, tickformat: ',.0f' }, yaxis: { type: 'category' }, showlegend: false, margin: { r: 50 } });
    },
    usuarios() {
      const f = ESTADO.usuarios, r = Motor.usuarios(P, f), d = f.desde, h = f.hasta, n = r.enPeriodo.length;
      kpis('k-usuarios', [
        { l: 'Usuarios en el período', v: num(n), d: `con registro entre ${mesTxt(d)} y ${mesTxt(h)}`, a: 'Usuarios consolidados con al menos un registro en el período.' },
        { l: `Con registro en ${mesTxt(h)}`, v: num(r.fin), color: C.aqua, d: r.hace12 != null ? `<span class="${clase(r.var12)}">${flecha(r.var12)}${pctS(r.var12)}</span> vs. ${mesTxt(h - 12)} (${num(r.hace12)})` : 'sin dato 12 meses antes' },
        { l: 'Altas en el período', v: num(r.nuevos.length), color: C.violeta, d: n ? pct(r.nuevos.length / n) + ' de los usuarios' : '' },
        { l: 'Salidas en el período', v: num(r.salidas.length), color: C.rojo, d: n ? pct(r.salidas.length / n) + ' de los usuarios' : '' },
        { l: 'Con una sola cuenta', v: pct(r.pctUna), color: C.amarillo, d: 'participación en los usuarios del período' },
        { l: 'Cuentas por usuario (mediana)', v: num(r.medCtas), color: C.naranja, d: `promedio ${num(r.promCtas, 1)}, sesgado por el usuario con más cuentas` },
      ]);
      const x = FECHAS.slice(d, h + 1);
      dibujar('u-activos', [
        { type: 'scatter', mode: 'lines', x, y: Array.from(r.activos).slice(d, h + 1), name: 'Usuarios con registro', line: { color: C.azul, width: 2.4, shape: 'hv' }, fill: 'tozeroy', fillcolor: 'rgba(42,120,214,.07)', hovertemplate: '<b>%{y}</b><extra>Usuarios</extra>' },
        { type: 'scatter', mode: 'lines', x, y: x.map((_, k) => (d + k - 12 >= 0 ? r.activos[d + k - 12] : null)), name: 'Mismo mes del año anterior', line: { color: C.tinta3, width: 1.4, dash: 'dot', shape: 'hv' }, hovertemplate: '%{y}<extra>Año anterior</extra>' },
      ], { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'Usuarios' }, rangemode: 'tozero' }, hovermode: 'x unified' });
      const an = r.flujos.map(a => String(a.anio));
      dibujar('u-flujos', [
        { type: 'bar', x: an, y: r.flujos.map(a => a.nuevos), name: 'Altas', marker: { color: C.aqua }, hovertemplate: '%{x}: <b>%{y}</b><extra>Altas</extra>' },
        { type: 'bar', x: an, y: r.flujos.map(a => -a.salidas), name: 'Salidas', marker: { color: C.rojo }, customdata: r.flujos.map(a => a.salidas), hovertemplate: '%{x}: <b>%{customdata}</b><extra>Salidas</extra>' },
        { type: 'scatter', mode: 'lines+markers', x: an, y: r.flujos.map(a => a.nuevos - a.salidas), name: 'Saldo neto', line: { color: C.tinta, width: 1.5 }, hovertemplate: '%{x}: <b>%{y:+d}</b><extra>Saldo</extra>' },
      ], { barmode: 'relative', yaxis: { title: { text: 'Usuarios' }, zeroline: true, zerolinecolor: '#bdbdb8' }, xaxis: { type: 'category' } });
      barras('u-seg', D.segmentos, r.dist.seg, COL_SEG, 'usuarios', n);
      barras('u-tam', TAM, r.dist.tam, COL_TAM, 'usuarios', n);
      barras('u-tipo', D.tipos, r.dist.tipo, [C.azul, C.violeta], 'usuarios', n);
      barras('u-ctas', ['1 cuenta', '2 a 5', '6 a 20', 'Más de 20'], r.dist.ctas, C.azul, 'usuarios', n);
      barras('u-perm', r.dist.perm.map((_, k) => `${k * 12 + 1}–${Math.min((k + 1) * 12, h - d + 1)} meses`), r.dist.perm, C.aqua, 'usuarios', n);
      serieDetalle('u-serie', 'u', +selU.sel.value, f);
      const sal = new Set(r.salidas), nue = new Set(r.nuevos);
      tabla('u-tabla', [{ t: 'Código' }, { t: 'Usuario' }, { t: 'Segmento' }, { t: 'Tamaño' }, { t: 'Titular' }, { t: 'Cuentas', num: true, inicial: true },
        { t: 'Meses con registro', num: true }, { t: 'Primer registro' }, { t: 'Último registro' }, { t: 'Estado' }],
        r.enPeriodo.map(u => [D.usuarios.cod[u], D.usuarios.nom[u], D.segmentos[D.usuarios.seg[u]], TAM[D.usuarios.tam[u]], D.tipos[D.usuarios.tipo[u]],
          r.nCtas[u], r.mesesRango[u], D.meses[r.primero[u]], D.meses[r.ultimo[u]], sal.has(u) ? 'Salida' : nue.has(u) ? 'Alta' : 'Continúa']), 'usuarios_periodo');
    },
    cuentas() {
      const f = ESTADO.cuentas, r = Motor.cuentas(P, f), d = f.desde, h = f.hasta, n = r.enPeriodo.length;
      kpis('k-cuentas', [
        { l: 'Cuentas en el período', v: num(n), d: `con registro entre ${mesTxt(d)} y ${mesTxt(h)}` },
        { l: `Registradas en ${mesTxt(h)}`, v: num(r.fin), color: C.aqua, d: r.hace12 != null ? `<span class="${clase(r.var12)}">${flecha(r.var12)}${pctS(r.var12)}</span> vs. ${mesTxt(h - 12)} (${num(r.hace12)})` : 'sin dato 12 meses antes' },
        { l: 'Cuentas nuevas', v: num(r.nuevas), color: C.violeta, d: n ? pct(r.nuevas / n) + ' de las cuentas' : '' },
        { l: 'Dejan de registrarse', v: num(r.salidas), color: C.rojo, d: n ? pct(r.salidas / n) + ' de las cuentas' : '' },
        { l: `En cero en ${mesTxt(h)}`, v: pct(r.pctCeroFin), color: C.amarillo, d: `${num(r.cero[h])} cuentas con 0 kWh` },
        { l: 'Cuentas con vacíos', v: num(r.vacios), color: C.naranja, d: n ? pct(r.vacios / n) + ' con meses intermedios sin registro' : '' },
      ]);
      const x = FECHAS.slice(d, h + 1), sl = a => Array.from(a).slice(d, h + 1), reg = sl(r.reg), cero = sl(r.cero);
      dibujar('c-activas', [
        { type: 'bar', x, y: reg.map((v, k) => v - cero[k]), name: 'Con consumo', marker: { color: C.azul }, hovertemplate: '<b>%{y}</b><extra>Con consumo</extra>' },
        { type: 'bar', x, y: cero, name: 'Registradas en cero', marker: { color: C.amarillo }, hovertemplate: '<b>%{y}</b><extra>En cero</extra>' },
        { type: 'scatter', mode: 'lines', x, y: reg, name: 'Total', line: { color: C.tinta, width: 1.2 }, hovertemplate: '<b>%{y}</b><extra>Total</extra>' },
      ], { barmode: 'stack', bargap: 0.12, xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'Cuentas' } }, hovermode: 'x unified' });
      const an = r.anual.map(a => String(a.anio));
      dibujar('c-anual', [
        { type: 'bar', x: an, y: r.anual.map(a => a.registradas), name: 'Registradas', marker: { color: '#a9c9f1' } },
        { type: 'bar', x: an, y: r.anual.map(a => a.nuevas), name: 'Nuevas', marker: { color: C.aqua } },
        { type: 'bar', x: an, y: r.anual.map(a => a.salidas), name: 'Dejan de registrarse', marker: { color: C.rojo } },
      ], { barmode: 'group', yaxis: { title: { text: 'Cuentas' } }, xaxis: { type: 'category' }, hovermode: 'x unified' });
      barras('c-estado', ['Con consumo', 'Registrada en cero', 'Sin registro al cierre'], r.estado, [C.azul, C.amarillo, C.tinta3], 'cuentas', n);
      dibujar('c-ciclo', D.ciclos.map((c, k) => ({ type: 'scatter', mode: 'lines', x, y: sl(r.porCiclo[k]), name: 'Ciclo ' + c, stackgroup: 'c', line: { color: COL_CICLO[k], width: 1 }, hovertemplate: '<b>%{y}</b><extra>Ciclo ' + c + '</extra>' })),
        { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'Cuentas' } }, hovermode: 'x unified' });
      dibujar('c-cero', [{ type: 'scatter', mode: 'lines', x, y: reg.map((v, k) => (v ? cero[k] / v * 100 : null)), line: { color: C.amarillo, width: 2.2 }, fill: 'tozeroy', fillcolor: 'rgba(237,161,0,.10)',
        customdata: cero, hovertemplate: '%{x|%B %Y}: <b>%{y:.1f} %</b> (%{customdata} cuentas)<extra></extra>' }], { xaxis: UI.EJE_FECHA, yaxis: { title: { text: '% de cuentas' }, ticksuffix: ' %', rangemode: 'tozero' }, showlegend: false });
      barras('c-seg', D.segmentos, r.porSeg, COL_SEG, 'cuentas', n);
      const top = r.topUsr.slice(0, 12).reverse();
      dibujar('c-top', [{ type: 'bar', orientation: 'h', y: top.map(u => corto(etqU(u), 38)), x: top.map(u => r.porUsr[u]), marker: { color: top.map(u => COL_SEG[D.usuarios.seg[u]]) },
        text: top.map(u => num(r.porUsr[u])), textposition: 'outside', cliponaxis: false, hovertemplate: '<b>%{x} cuentas</b><extra></extra>' }],
        { xaxis: { title: { text: 'Cuentas (escala logarítmica)' }, type: 'log', tickvals: [1, 2, 5, 10, 20, 50, 100, 200, 500], tickformat: ',d' }, yaxis: { type: 'category', tickfont: { size: 10.5 } }, showlegend: false, margin: { r: 40 } });
      serieDetalle('c-serie', 'c', +selC.sel.value, f);
      tabla('c-tabla', [{ t: 'Cuenta' }, { t: 'Código usuario' }, { t: 'Usuario' }, { t: 'Ciclo' }, { t: 'Segmento' }, { t: 'Meses con registro', num: true, inicial: true },
        { t: 'Meses en cero', num: true }, { t: 'Primer registro' }, { t: 'Último registro' }, { t: 'Vacíos' }, { t: 'Estado' }],
        r.enPeriodo.map(c => { const u = P.usrC[c]; return [D.cuentas.cod[c], D.usuarios.cod[u], D.usuarios.nom[u], D.ciclos[P.cicC[c]], D.segmentos[D.usuarios.seg[u]],
          r.mesesR[c], r.ceroR[c], D.meses[r.primR[c]], D.meses[r.ultR[c]], r.conVacios(c) ? 'Sí' : 'No', r.esSalida(c) ? 'Deja de registrarse' : r.esNueva(c) ? 'Nueva' : 'Continúa']; }), 'cuentas_periodo');
    },
  };

  const pendiente = { demanda: true, usuarios: true, cuentas: true };
  let ctrl = null;
  for (const tab of Object.keys(render)) {
    filtroPeriodo(document.querySelector(`.filtros[data-tab="${tab}"]`), D.meses, ESTADO[tab], () => {
      if (ctrl && ctrl.actual() === tab) requestAnimationFrame(render[tab]); else pendiente[tab] = true;
    });
  }
  document.getElementById('pie').innerHTML = `<p><b>Fuente:</b> ${UI.esc(M.fuente)}. Energía activa facturada (kWh), ${mesTxt(0)} – ${mesTxt(NM - 1)}${M.meses_excluidos.length ? `; se excluye ${M.meses_excluidos.join(', ')} por estar incompleto (${num(M.registros_excluidos)} registros)` : ''}.</p>
    ${M.solo_excluidos.length ? `<p>El análisis consolida ${M.n_usuarios_total} usuarios; ${M.solo_excluidos.map(UI.esc).join(', ')} solo tiene registros en el mes excluido, por eso el período contiene ${M.n_usuarios} usuarios y ${num(M.n_cuentas)} cuentas.</p>` : ''}
    <p>Usuario = titular actual de cada cuenta con variantes de nombre unificadas. Las personas naturales se muestran con su código; las cuentas, con su número real.</p>`;
  ctrl = UI.pestanas('eda_tab', tab => {
    if (pendiente[tab]) { render[tab](); pendiente[tab] = false; } else UI.redimensionar(document.getElementById('tab-' + tab));
  });
}

/* =====================================================================================
   Página · Predicción
   ===================================================================================== */
function paginaPrediccion() {
  const D = window.DATOS_PRED;
  if (!D) { document.querySelector('main').innerHTML = '<p class="nota">No se encontró static/js/data.js. Ejecute <code>python -m src.prediccion</code>.</p>'; return; }
  const C = UI.COL, CM = UI.COL_MODELO, MOD = D.modelos, MEJOR = D.meta.mejor, iMejor = MOD.indexOf(MEJOR), iNaive = MOD.indexOf('Naive estacional');
  const { num, pct, pctS, clase, flecha, corto, dibujar, kpis, tabla, esc } = UI;
  const G = v => (v == null ? null : v / 1e6);
  const METRICAS = { 'MAPE_%': ['MAPE', '%', 1, 'min'], 'MAE': ['MAE', 'GWh', 1e6, 'min'], 'RMSE': ['RMSE', 'GWh', 1e6, 'min'], 'R2': ['R²', '', 1, 'max'],
    'WAPE_%': ['WAPE', '%', 1, 'min'], 'Sesgo_%': ['Sesgo', '%', 1, 'abs'], 'MASE': ['MASE', '', 1, 'min'], 'Mejora_vs_naive_%': ['Mejora vs naive', '%', 1, 'max'] };
  const fmtM = (k, v) => { const [, u, div] = METRICAS[k]; return v == null ? '—' : num(v / div, u === 'GWh' ? 3 : 2) + (u ? ' ' + u : ''); };
  const FH = D.hist.meses.map(UI.fecha), FP = D.pron.meses.map(UI.fecha);
  const iAnio = a => D.anual.anios.indexOf(a);

  document.getElementById('cab-meta').innerHTML = [['Datos reales hasta', UI.mes(D.meta.ultimo_mes)], ['Pronóstico hasta', UI.mes(D.meta.mes_objetivo)],
    ['Mejor modelo', MEJOR], ['Modelos comparados', MOD.length], ['Datos generados', D.meta.generado]].map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('');

  /* ---------- Pestaña 1 · Predicción global (sección: comparación de los 7 modelos) ---------- */
  UI.tarjetas('g-modelos', [
    { id: 'm-ranking', t: 'Ranking de modelos', s: '', a: 'Valor de la métrica elegida para cada modelo. El modelo resaltado es el elegido (menor MAPE en la validación cruzada).' },
    { id: 'm-perfil', t: 'Posición de cada modelo en todas las métricas', s: '1 = mejor · validación o prueba según el filtro', a: 'Ranking de cada modelo en cada métrica. Un modelo robusto ocupa los primeros lugares en casi todas.' },
    { id: 'm-test', ancho: true, t: 'Prueba final: pronóstico frente al consumo real', s: `Entrenamiento hasta ${UI.mes(D.meta.origen_prueba)} · 12 meses siguientes · GWh`,
      a: 'Cada modelo se entrenó sin ver estos 12 meses. Active o desactive modelos con los botones del filtro.' },
    { id: 'm-horizonte', t: 'Error según meses hacia adelante', s: 'MAPE promedio de los orígenes de validación', a: 'El error suele crecer con el horizonte; muestra qué tan confiable es cada modelo a corto y largo plazo.' },
    { id: 'm-origen', t: 'Estabilidad entre orígenes de validación', s: 'MAPE (%) de cada modelo en cada origen', a: 'Un modelo estable tiene errores parecidos en todos los orígenes.' },
    { id: 'm-errores', t: 'Distribución de los errores', s: 'Error % de los pronósticos de validación (positivo = sobrestima)', a: 'Cajas centradas en 0 y angostas indican un modelo sin sesgo y preciso.' },
    { id: 'm-dispersion', t: 'Real frente a pronóstico', s: 'Prueba final · la diagonal es el pronóstico perfecto', a: 'Cuanto más cerca de la diagonal, mejor. El R² resume esa cercanía.' },
    { id: 'm-tabla', ancho: true, tabla: true, t: 'Tabla de métricas', s: 'Todas las métricas e hiperparámetros elegidos · descargable' },
  ]);
  const EM = { eval: 'cv', metrica: 'MAPE_%', sel: new Set([iMejor, MOD.indexOf('Holt-Winters'), iNaive].filter(i => i >= 0)) };
  const fm = document.querySelector('.filtros[data-tab="modelos"]');
  fm.innerHTML = `<div class="f-grupo"><span class="f-tit">Evaluación</span><div class="segmentado" data-g="eval">
      <button data-v="cv" aria-pressed="true" title="${D.meta.origenes.length} orígenes × 12 meses">Validación cruzada</button><button data-v="prueba" aria-pressed="false">Prueba final</button></div></div>
    <div class="f-grupo"><label for="sel-metrica">Métrica del ranking</label><select id="sel-metrica">${Object.entries(METRICAS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select></div>
    <div class="f-grupo"><span class="f-tit">Modelos en las gráficas de líneas</span><div class="chips">${MOD.map((m, i) =>
      `<button class="chip" data-i="${i}" aria-pressed="${EM.sel.has(i)}"><span class="punto" style="background:${CM[m]}"></span>${esc(m)}</button>`).join('')}</div></div>
    <div class="f-resumen">Criterio de selección: <b>menor MAPE en la validación cruzada temporal</b> (${D.meta.origenes.length} orígenes: ${D.meta.origenes.map(UI.mes).join(', ')}; 12 meses hacia adelante en cada uno).</div>`;
  fm.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.closest('[data-g="eval"]')) { EM.eval = b.dataset.v; fm.querySelectorAll('[data-g="eval"] button').forEach(x => x.setAttribute('aria-pressed', x === b)); }
    else if (b.dataset.i) { const i = +b.dataset.i; if (EM.sel.has(i) && EM.sel.size > 1) EM.sel.delete(i); else EM.sel.add(i); b.setAttribute('aria-pressed', EM.sel.has(i)); }
    else return;
    renderModelos();
  });
  fm.querySelector('#sel-metrica').addEventListener('change', e => { EM.metrica = e.target.value; renderModelos(); });

  function renderModelos() {
    const T = D[EM.eval], etiqueta = EM.eval === 'cv' ? 'validación cruzada' : 'prueba final';
    const mejorAqui = MOD.reduce((b, m, i) => (T['MAPE_%'][i] < T['MAPE_%'][b] ? i : b), 0);
    kpis('k-modelos', [
      { l: 'Modelo elegido', v: MEJOR, d: EM.eval === 'cv' ? 'menor MAPE en la validación cruzada' : (mejorAqui === iMejor ? 'también es el mejor en la prueba final' : `en la prueba final gana ${MOD[mejorAqui]}`), color: CM[MEJOR],
        a: 'Se elige con la validación cruzada temporal (más pronósticos evaluados que la prueba final).' },
      { l: `MAPE · ${etiqueta}`, v: fmtM('MAPE_%', T['MAPE_%'][iMejor]), d: `naive estacional: ${fmtM('MAPE_%', T['MAPE_%'][iNaive])}`, color: C.azul, a: 'Error absoluto medio en % del consumo real.' },
      { l: 'MAE (error absoluto medio)', v: fmtM('MAE', T.MAE[iMejor]), d: `≈ ${num(T.MAE[iMejor] / 1e3)} MWh por mes`, color: C.aqua, a: 'Promedio del error absoluto mensual.' },
      { l: 'RMSE', v: fmtM('RMSE', T.RMSE[iMejor]), d: 'penaliza más los errores grandes', color: C.violeta, a: 'Raíz del error cuadrático medio.' },
      { l: 'R²', v: num(T.R2[iMejor], 2), d: T.R2[iMejor] < 0 ? 'negativo: la variación del periodo es pequeña frente al error' : 'proporción de la variación explicada', color: C.naranja,
        a: 'R² compara con la media del periodo evaluado. En ventanas cortas con poca variación puede ser negativo aunque el error sea bajo.' },
      { l: 'Mejora frente al naive', v: `<span class="${clase(T['Mejora_vs_naive_%'][iMejor])}">${flecha(T['Mejora_vs_naive_%'][iMejor])}${num(T['Mejora_vs_naive_%'][iMejor], 1)} %</span>`,
        d: `MASE ${num(T.MASE[iMejor], 2)} · sesgo ${num(T['Sesgo_%'][iMejor], 1)} %`, color: C.amarillo, a: 'Reducción del MAE frente a repetir el mismo mes del año anterior.' },
    ]);
    const [nom, unidad, div, sentido] = METRICAS[EM.metrica];
    const vals = MOD.map((m, i) => ({ m, i, v: T[EM.metrica][i] }));
    vals.sort((a, b) => (sentido === 'max' ? b.v - a.v : sentido === 'abs' ? Math.abs(a.v) - Math.abs(b.v) : a.v - b.v));
    document.getElementById('m-ranking-sub').textContent = `${nom}${unidad ? ' (' + unidad + ')' : ''} · ${etiqueta} · ${sentido === 'max' ? 'mayor es mejor' : sentido === 'abs' ? 'más cercano a 0 es mejor' : 'menor es mejor'}`;
    const ord = vals.slice().reverse();
    dibujar('m-ranking', [{ type: 'bar', orientation: 'h', y: ord.map(o => o.m), x: ord.map(o => o.v / div),
      marker: { color: ord.map(o => (o.m === MEJOR ? CM[o.m] : C.rejilla)), line: { color: ord.map(o => CM[o.m]), width: 1.5 } },
      text: ord.map(o => fmtM(EM.metrica, o.v)), textposition: 'outside', cliponaxis: false, textfont: { size: 11 },
      hovertemplate: '%{y}: <b>%{text}</b><extra></extra>' }],
      { yaxis: { type: 'category' }, xaxis: { title: { text: nom + (unidad ? ' (' + unidad + ')' : '') }, zeroline: true, zerolinecolor: '#bdbdb8' }, showlegend: false, margin: { r: 70 } });

    const claves = ['MAPE_%', 'MAE', 'RMSE', 'R2', 'WAPE_%', 'Sesgo_%', 'MASE'];
    const rangos = claves.map(k => { const s = METRICAS[k][3];
      const o = MOD.map((_, i) => i).sort((a, b) => (s === 'max' ? T[k][b] - T[k][a] : s === 'abs' ? Math.abs(T[k][a]) - Math.abs(T[k][b]) : T[k][a] - T[k][b]));
      const r = new Array(MOD.length); o.forEach((i, p) => { r[i] = p + 1; }); return r; });
    dibujar('m-perfil', [{ type: 'heatmap', x: claves.map(k => METRICAS[k][0]), y: MOD, z: MOD.map((_, i) => rangos.map(r => r[i])),
      text: MOD.map((_, i) => claves.map(k => fmtM(k, T[k][i]))), texttemplate: '%{z}', textfont: { size: 12 },
      colorscale: [[0, '#1b4f91'], [0.5, '#a9c9f1'], [1, '#f4f4f1']], showscale: false, xgap: 2, ygap: 2,
      hovertemplate: '%{y} · %{x}: <b>%{text}</b> (puesto %{z})<extra></extra>' }],
      { yaxis: { autorange: 'reversed', type: 'category', gridcolor: 'rgba(0,0,0,0)' }, xaxis: { side: 'top', type: 'category', gridcolor: 'rgba(0,0,0,0)' }, margin: { t: 26 } });

    const xt = D.test.meses.map(UI.fecha), sel = [...EM.sel];
    dibujar('m-test', [{ type: 'scatter', mode: 'lines+markers', x: xt, y: D.test.real.map(G), name: 'Real', line: { color: C.tinta, width: 3 }, marker: { size: 6 }, hovertemplate: '<b>%{y:,.2f} GWh</b><extra>Real</extra>' },
      ...sel.map(i => ({ type: 'scatter', mode: 'lines+markers', x: xt, y: D.test.pred[MOD[i]].map(G), name: `${MOD[i]} (MAPE ${num(D.prueba['MAPE_%'][i], 1)} %)`,
        line: { color: CM[MOD[i]], width: MOD[i] === MEJOR ? 2.6 : 1.8, dash: MOD[i] === MEJOR ? 'solid' : 'dot' }, marker: { size: 5 }, hovertemplate: `%{y:,.2f} GWh<extra>${MOD[i]}</extra>` }))],
      { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'GWh' } }, hovermode: 'x unified' });
    dibujar('m-horizonte', sel.map(i => ({ type: 'scatter', mode: 'lines+markers', x: D.por_h[MOD[i]].map((_, k) => k + 1), y: D.por_h[MOD[i]], name: MOD[i],
      line: { color: CM[MOD[i]], width: MOD[i] === MEJOR ? 2.8 : 1.6 }, marker: { size: 5 }, hovertemplate: `h=%{x}: <b>%{y:.1f} %</b><extra>${MOD[i]}</extra>` })),
      { xaxis: { title: { text: 'Meses hacia adelante' }, dtick: 1 }, yaxis: { title: { text: 'MAPE (%)' }, rangemode: 'tozero' } });
    dibujar('m-origen', [{ type: 'heatmap', x: D.por_origen.origenes.map(UI.mes), y: MOD, z: MOD.map(m => D.por_origen.v[m]), colorscale: UI.ESCALA, xgap: 2, ygap: 2,
      texttemplate: '%{z:.1f}', textfont: { size: 11 }, colorbar: { title: { text: 'MAPE %', side: 'right' }, thickness: 10, outlinewidth: 0 },
      hovertemplate: '%{y} · origen %{x}: <b>%{z:.1f} %</b><extra></extra>' }],
      { yaxis: { autorange: 'reversed', type: 'category', gridcolor: 'rgba(0,0,0,0)' }, xaxis: { type: 'category', gridcolor: 'rgba(0,0,0,0)' } });
    dibujar('m-errores', MOD.map(m => ({ type: 'box', x: D.errores[m], name: m, orientation: 'h', marker: { color: CM[m], size: 4 }, line: { color: CM[m], width: 1.5 },
      fillcolor: CM[m] + '55', boxpoints: 'outliers', hovertemplate: `%{x:.1f} %<extra>${m}</extra>` })).reverse(),
      { showlegend: false, xaxis: { title: { text: 'Error del pronóstico (%)' }, zeroline: true, zerolinecolor: C.tinta, ticksuffix: ' %' }, yaxis: { type: 'category' } });
    const todos = [...D.test.real, ...sel.flatMap(i => D.test.pred[MOD[i]])].map(G), lo = Math.min(...todos) * 0.97, hi = Math.max(...todos) * 1.03;
    dibujar('m-dispersion', [{ type: 'scatter', mode: 'lines', x: [lo, hi], y: [lo, hi], line: { color: C.tinta3, dash: 'dash', width: 1 }, hoverinfo: 'skip', showlegend: false },
      ...sel.map(i => ({ type: 'scatter', mode: 'markers', x: D.test.real.map(G), y: D.test.pred[MOD[i]].map(G), name: `${MOD[i]} (R² ${num(D.prueba.R2[i], 2)})`,
        marker: { color: CM[MOD[i]], size: 9, opacity: .85, line: { color: '#fff', width: 1 } }, customdata: D.test.meses.map(UI.mes),
        hovertemplate: `%{customdata}<br>Real %{x:,.2f} · Pronóstico %{y:,.2f} GWh<extra>${MOD[i]}</extra>` }))],
      { xaxis: { title: { text: 'Real (GWh)' }, range: [lo, hi] }, yaxis: { title: { text: 'Pronóstico (GWh)' }, range: [lo, hi] } });
    tabla('m-tabla', [{ t: 'Modelo' }, { t: 'MAPE %', num: true, dec: 2, inicial: true, asc: true }, { t: 'MAE (GWh)', num: true, dec: 3 }, { t: 'RMSE (GWh)', num: true, dec: 3 },
      { t: 'R²', num: true, dec: 3 }, { t: 'WAPE %', num: true, dec: 2 }, { t: 'Sesgo %', num: true, dec: 2 }, { t: 'MASE', num: true, dec: 3 }, { t: 'Mejora vs naive %', num: true, dec: 1 },
      { t: 'Hiperparámetros' }, { t: 'Descripción' }],
      MOD.map((m, i) => [m, T['MAPE_%'][i], G(T.MAE[i]), G(T.RMSE[i]), T.R2[i], T['WAPE_%'][i], T['Sesgo_%'][i], T.MASE[i], T['Mejora_vs_naive_%'][i], (D.hiper[m] && D.hiper[m] !== '{}' ? D.hiper[m] : '—'), D.descripcion[i]]),
      'metricas_modelos_' + EM.eval, { destacar: f => f[0] === MEJOR });
  }

  /* ---------- Pestaña 1 · Predicción global (sección: pronóstico) ---------- */
  UI.tarjetas('g-pronostico', [
    { id: 'p-serie', ancho: true, t: `Pronóstico del consumo mensual hasta ${UI.mes(D.meta.mes_objetivo)}`, s: `Modelo: ${MEJOR} · intervalos empíricos del 80 %, 90 % y 95 %`,
      a: 'Rango donde se espera el consumo real 8, 9 o 19 de cada 10/10/20 meses. Usa los errores relativos que tuvo el modelo en la validación según el horizonte; para más de 12 meses se amplían con √(h/12).' },
    { id: 'p-anual', t: 'Consumo anual real y pronosticado', s: 'GWh · 2026 combina meses reales y pronosticados' },
    { id: 'p-perfil', t: 'Perfil mensual por año', s: 'GWh por mes: 2025 real, 2026 real + pronóstico y 2027 pronóstico', a: 'Permite comparar la estacionalidad esperada con la observada.' },
    { id: 'p-tabla', ancho: true, tabla: true, t: 'Pronóstico mensual', s: 'kWh con intervalos · descargable' },
  ]);
  const EP = { desde: '2023-01', banda: 'todos' };
  const fp = document.querySelector('.filtros[data-tab="pronostico"]');
  fp.innerHTML = `<div class="f-grupo"><span class="f-tit">Historia visible desde</span><div class="segmentado" data-g="desde">${['2020-01', '2023-01', '2025-01'].map(v =>
      `<button data-v="${v}" aria-pressed="${v === EP.desde}">${v.slice(0, 4)}</button>`).join('')}</div></div>
    <div class="f-grupo"><span class="f-tit">Intervalo</span><div class="segmentado" data-g="banda">${[['todos', '80, 90 y 95 %'], ['80', '80 %'], ['90', '90 %'], ['95', '95 %'], ['no', 'Sin intervalo']].map(([v, t]) =>
      `<button data-v="${v}" aria-pressed="${v === EP.banda}">${t}</button>`).join('')}</div></div>
    <div class="f-resumen">Último mes real: <b>${UI.mes(D.meta.ultimo_mes)}</b> · horizonte: <b>${D.pron.meses.length} meses</b> · modelo: <b>${MEJOR}</b></div>`;
  fp.addEventListener('click', e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    const g = b.closest('[data-g]').dataset.g; EP[g] = b.dataset.v;
    b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); renderPronostico();
  });
  function renderPronostico() {
    const A = D.anual, i25 = iAnio(2025), i26 = iAnio(2026), i27 = iAnio(2027);
    const tot = i => (i < 0 ? null : (A.real[i] || 0) + (A.pron[i] || 0));
    const p27 = D.pron.meses.map((m, k) => [m, D.pron.p[k]]).filter(([m]) => m.startsWith('2027'));
    const pico = p27.reduce((b, x) => (x[1] > b[1] ? x : b), p27[0] || ['', 0]);
    const amp = D.pron.p.map((p, k) => (D.pron.s80[k] - D.pron.i80[k]) / 2 / p);
    const v27 = tot(i26) ? tot(i27) / tot(i26) - 1 : null, v26 = tot(i25) ? tot(i26) / tot(i25) - 1 : null;
    kpis('k-pronostico', [
      { l: 'Consumo pronosticado 2027', v: num(tot(i27), 1) + ' GWh', d: `<span class="${clase(v27)}">${flecha(v27)}${pctS(v27)}</span> vs. 2026`, color: CM[MEJOR], a: 'Suma de los 12 meses pronosticados de 2027.' },
      { l: 'Cierre estimado 2026', v: num(tot(i26), 1) + ' GWh', d: `${A.meses_reales[i26]} meses reales + ${12 - A.meses_reales[i26]} pronosticados · ${pctS(v26)} vs. 2025`, color: C.azul },
      { l: `Próximo mes (${UI.mes(D.pron.meses[0])})`, v: num(G(D.pron.p[0]), 2) + ' GWh', d: `80 %: ${num(G(D.pron.i80[0]), 2)} – ${num(G(D.pron.s80[0]), 2)} · 90 %: ${num(G(D.pron.i90[0]), 2)} – ${num(G(D.pron.s90[0]), 2)} GWh`, color: C.aqua },
      { l: 'Promedio mensual 2027', v: num(G(UI.suma(p27.map(x => x[1])) / Math.max(p27.length, 1)), 2) + ' GWh', d: `real 2025: ${num(A.real[i25] / 12, 2)} GWh/mes`, color: C.violeta },
      { l: 'Mes pico 2027', v: pico[0] ? UI.mes(pico[0]) : '—', d: pico[0] ? num(G(pico[1]), 2) + ' GWh' : '', color: C.naranja },
      { l: 'Amplitud del intervalo 80 %', v: '± ' + num(UI.suma(amp) / amp.length * 100, 1) + ' %', d: `de ±${num(Math.min(...amp) * 100, 1)} % a ±${num(Math.max(...amp) * 100, 1)} % según el horizonte`, color: C.amarillo,
        a: 'Mitad del ancho del intervalo del 80 % como porcentaje del pronóstico.' },
    ]);
    const i0 = D.hist.meses.indexOf(EP.desde), xh = FH.slice(i0), yh = D.hist.v.slice(i0).map(G);
    const c = CM[MEJOR], tr = [];
    const banda = (inf, sup, nombre, alfa) => [
      { type: 'scatter', mode: 'lines', x: FP, y: D.pron[sup].map(G), line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
      { type: 'scatter', mode: 'lines', x: FP, y: D.pron[inf].map(G), line: { width: 0 }, fill: 'tonexty', fillcolor: c + alfa, name: nombre, hoverinfo: 'skip' }];
    if (EP.banda === 'todos' || EP.banda === '95') tr.push(...banda('i95', 's95', 'Intervalo 95 %', '26'));
    if (EP.banda === 'todos' || EP.banda === '90') tr.push(...banda('i90', 's90', 'Intervalo 90 %', '3a'));
    if (EP.banda === 'todos' || EP.banda === '80') tr.push(...banda('i80', 's80', 'Intervalo 80 %', '55'));
    tr.push({ type: 'scatter', mode: 'lines', x: xh, y: yh, name: 'Real', line: { color: C.tinta, width: 2.2 }, hovertemplate: '<b>%{y:,.2f} GWh</b><extra>Real</extra>' });
    tr.push({ type: 'scatter', mode: 'lines+markers', x: [FH[FH.length - 1], ...FP], y: [yh[yh.length - 1], ...D.pron.p.map(G)], name: 'Pronóstico', line: { color: c, width: 2.6 }, marker: { size: 5 },
      customdata: [[null, null, null, null, null, null], ...D.pron.p.map((_, k) => [G(D.pron.i80[k]), G(D.pron.s80[k]), G(D.pron.i90[k]), G(D.pron.s90[k]), G(D.pron.i95[k]), G(D.pron.s95[k])])],
      hovertemplate: '<b>%{y:,.2f} GWh</b><br>80 %: %{customdata[0]:,.2f} – %{customdata[1]:,.2f}<br>90 %: %{customdata[2]:,.2f} – %{customdata[3]:,.2f}<br>95 %: %{customdata[4]:,.2f} – %{customdata[5]:,.2f}<extra>Pronóstico</extra>' });
    dibujar('p-serie', tr, { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'GWh' } }, hovermode: 'x unified',
      shapes: [{ type: 'line', xref: 'x', yref: 'paper', x0: FH[FH.length - 1], x1: FH[FH.length - 1], y0: 0, y1: 1, line: { color: C.tinta3, dash: 'dot', width: 1 } }],
      annotations: [{ x: FH[FH.length - 1], y: 1, xref: 'x', yref: 'paper', text: 'último mes real', showarrow: false, xanchor: 'right', yanchor: 'top', font: { size: 10.5, color: C.tinta3 } }] });
    const ta = A.anios.map(String), tt = A.anios.map((_, i) => tot(i));
    dibujar('p-anual', [
      { type: 'bar', x: ta, y: A.real, name: 'Real', marker: { color: C.azul }, hovertemplate: '%{x}: <b>%{y:,.1f} GWh</b><extra>Real</extra>' },
      { type: 'bar', x: ta, y: A.pron, name: 'Pronóstico', marker: { color: c }, hovertemplate: '%{x}: <b>%{y:,.1f} GWh</b><extra>Pronóstico</extra>' },
      { type: 'scatter', mode: 'text', x: ta, y: tt, text: tt.map((v, i) => num(v, 1) + (i ? `<br>${pctS(v / tt[i - 1] - 1)}` : '')), textposition: 'top center', textfont: { size: 10, color: C.tinta2 }, hoverinfo: 'skip', showlegend: false },
    ], { barmode: 'stack', yaxis: { title: { text: 'GWh' }, range: [0, Math.max(...tt) * 1.25] }, xaxis: { type: 'category' }, legend: { traceorder: 'normal' } });
    const serieAnio = a => { const r = new Array(12).fill(null), f = new Array(12).fill(null);
      D.hist.meses.forEach((m, k) => { if (m.startsWith(a)) r[+m.slice(5) - 1] = G(D.hist.v[k]); });
      D.pron.meses.forEach((m, k) => { if (m.startsWith(a)) f[+m.slice(5) - 1] = G(D.pron.p[k]); }); return { r, f }; };
    const s25 = serieAnio('2025'), s26 = serieAnio('2026'), s27 = serieAnio('2027');
    dibujar('p-perfil', [
      { type: 'scatter', mode: 'lines+markers', x: UI.MESES, y: s25.r, name: '2025 real', line: { color: C.gris, width: 2 }, hovertemplate: '%{y:,.2f} GWh<extra>2025</extra>' },
      { type: 'scatter', mode: 'lines+markers', x: UI.MESES, y: s26.r.map((v, k) => (v != null ? v : s26.f[k])), name: '2026 real + pronóstico', line: { color: C.azul, width: 2 },
        marker: { symbol: s26.r.map(v => (v != null ? 'circle' : 'circle-open')), size: 7 }, hovertemplate: '%{y:,.2f} GWh<extra>2026</extra>' },
      { type: 'scatter', mode: 'lines+markers', x: UI.MESES, y: s27.f, name: '2027 pronóstico', line: { color: c, width: 2.4, dash: 'dash' }, hovertemplate: '%{y:,.2f} GWh<extra>2027</extra>' },
    ], { xaxis: { type: 'category' }, yaxis: { title: { text: 'GWh' } }, hovermode: 'x unified' });
    tabla('p-tabla', [{ t: 'Mes', inicial: true, asc: true }, { t: 'Meses adelante', num: true }, { t: 'Pronóstico (kWh)', num: true }, { t: 'Inferior 80 %', num: true }, { t: 'Superior 80 %', num: true },
      { t: 'Inferior 90 %', num: true }, { t: 'Superior 90 %', num: true }, { t: 'Inferior 95 %', num: true }, { t: 'Superior 95 %', num: true }, { t: 'Modelo' }],
      D.pron.meses.map((m, k) => [m, k + 1, D.pron.p[k], D.pron.i80[k], D.pron.s80[k], D.pron.i90[k], D.pron.s90[k], D.pron.i95[k], D.pron.s95[k], MEJOR]), 'pronostico_global', { porPagina: 20 });
  }

  /* ---------- Pestañas 2 y 3 · Predicción por usuario y por cuenta (misma lógica, distinto nivel) ---------- */
  function pestanaEntidad(nivel) {
    const N = D[nivel], L = N.lista, R = N.resumen, esU = nivel === 'usuarios', k = esU ? 'u' : 'c';
    const nom = esU ? 'usuarios' : 'cuentas', Nom = esU ? 'Usuarios' : 'Cuentas', art = esU ? 'el usuario' : 'la cuenta';
    const etq = e => (esU ? `${e.cod} · ${e.nom}` : `${e.cod} · ${e.usr} ${e.nom}`);
    const grupos = esU ? D.usuarios.lista.map(e => e.seg).filter((v, i, a) => a.indexOf(v) === i)
      : [...new Set(L.map(e => e.ciclo))].sort((a, b) => a - b);
    const grupoDe = e => (esU ? e.seg : e.ciclo);
    const ESTADO_TXT = [`Con pronóstico`, `Sin registro en ${UI.mes(D.meta.ultimo_mes)}`, `Solo registra ${D.meta.mes_excluido} (mes incompleto)`];
    const S = { sel: 0, estado: 'todas', grupos: null, banda: 'ambas' };
    const amp = h => Math.sqrt(Math.max(h, 12) / 12);
    const bandaE = (e, q) => (e.p && e[q] != null ? { inf: e.p.map((v, i) => Math.max(v - e[q] * amp(i + 1), 0)), sup: e.p.map((v, i) => v + e[q] * amp(i + 1)) } : null);
    const filtradas = () => L.map((e, i) => i).filter(i => (S.estado === 'todas' || (S.estado === 'con') === (L[i].est === 0)) &&
      (!S.grupos || S.grupos.has(grupoDe(L[i]))));
    const valorMes = (e, m) => { const ih = D.hist.meses.indexOf(m); if (ih >= 0) return e.h[ih];
      const ip = D.pron.meses.indexOf(m); return ip >= 0 && e.p ? e.p[ip] : null; };
    const mesAnt = m => `${+m.slice(0, 4) - 1}${m.slice(4)}`;

    UI.tarjetas('g-' + nivel, [
      { id: k + '-serie', ancho: true, t: '', s: '', a: `Historia mensual y pronóstico hasta ${UI.mes(D.meta.mes_objetivo)} con el modelo que mejor predijo la serie de ${art} en su prueba de 12 meses.` },
      { id: k + '-modelos', t: `¿Qué modelo predijo mejor ${art}?`, s: `MAE de cada modelo en la prueba ${UI.mes(D.test.meses[0])} – ${UI.mes(D.meta.ultimo_mes)}; resaltado el elegido`,
        a: 'Cada modelo se entrenó con la serie hasta un año antes del último mes y pronosticó los 12 meses siguientes. Gana el de menor MAE; ese es el que se usa para el pronóstico.' },
      { id: k + '-mensual', t: 'Pronóstico mes a mes', s: 'MWh pronosticados (barras con rango del 80 %) frente al mismo mes del año anterior' },
      { id: k + '-meses', ancho: true, tabla: true, t: `Pronóstico mensual de ${art} con intervalos`, s: 'kWh por mes con intervalos del 80 % y 90 % · descargable',
        a: `Intervalo = ± percentil 80 / 90 del error absoluto que tuvo el modelo de ${art} en su prueba de 12 meses; después de 12 meses se amplía con √(h/12).` },
      { id: k + '-wape', t: `Error de cada modelo en todas las ${nom === 'usuarios' ? 'series de usuarios' : 'cuentas'}`, s: 'WAPE en la prueba de 12 meses, ponderado por consumo', a: 'WAPE = Σ|error| / Σ real sobre todas las entidades evaluadas. Menor es mejor.' },
      { id: k + '-veces', t: '¿Qué modelo gana más veces?', s: `Número de ${nom} en que cada modelo fue el mejor` },
      { id: k + '-coherencia', t: 'Coherencia con el pronóstico global', s: `GWh por mes: modelo global frente a la suma de ${nom}`,
        a: `Los modelos individuales no anticipan ${nom} nuevos; por eso su suma suele quedar por debajo del total.` },
      { id: k + '-top', t: `${Nom} de mayor consumo`, s: 'Top 15 de los filtros · real 2025 frente a pronóstico 2027 (GWh)' },
      { id: k + '-tabla', ancho: true, tabla: true, t: `Detalle de ${esU ? 'los' : 'las'} ${L.length} ${nom}`, s: `Todos ${esU ? 'los usuarios' : 'las cuentas'}, con su estado, modelo y pronóstico · haga clic en una fila para verla arriba · descargable` },
    ]);
    const fe = document.querySelector(`.filtros[data-tab="${nivel}"]`);
    fe.innerHTML = `<div class="f-grupo"><label for="busca-${k}">${esU ? 'Usuario' : 'Cuenta'}</label>
        <input type="search" id="busca-${k}" list="lista-${k}" placeholder="${esU ? 'Código o nombre…' : 'Número de cuenta, código o nombre…'}" autocomplete="off"></div>
      <div class="f-grupo"><span class="f-tit">Recorrer</span><div class="f-rapidos"><button class="rapido" data-paso="-1">‹ Anterior</button><button class="rapido" data-paso="1">Siguiente ›</button></div></div>
      <div class="f-grupo"><span class="f-tit">Estado</span><div class="segmentado" data-g="estado">
        <button data-v="todas" aria-pressed="true">Todas (${L.length})</button><button data-v="con" aria-pressed="false">Con pronóstico (${R.activos})</button>
        <button data-v="sin" aria-pressed="false">Sin pronóstico (${L.length - R.activos})</button></div></div>
      <div class="f-grupo"><span class="f-tit">Intervalo</span><div class="segmentado" data-g="banda">
        <button data-v="ambas" aria-pressed="true">80 % y 90 %</button><button data-v="80" aria-pressed="false">80 %</button>
        <button data-v="90" aria-pressed="false">90 %</button><button data-v="no" aria-pressed="false">Sin intervalo</button></div></div>
      <div class="f-grupo"><span class="f-tit">${esU ? 'Segmento' : 'Ciclo'}</span><div class="chips">${grupos.map(g =>
        `<button class="chip" data-grupo="${esc(String(g))}" aria-pressed="true">${esU ? esc(g) : 'Ciclo ' + g}</button>`).join('')}</div></div>
      <div class="f-resumen"></div><datalist id="lista-${k}">${L.map(e => `<option value="${esc(etq(e))}">`).join('')}</datalist>`;
    const elegir = i => { if (i >= 0) { S.sel = i; render(); } };
    fe.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.paso) { const f = filtradas(); if (!f.length) return; const pos = f.indexOf(S.sel);
        S.sel = f[((pos < 0 ? -1 : pos) + +b.dataset.paso + f.length) % f.length]; }
      else if (b.closest('[data-g="banda"]')) { S.banda = b.dataset.v; b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); }
      else if (b.closest('[data-g="estado"]')) { S.estado = b.dataset.v; b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); }
      else if (b.dataset.grupo !== undefined) {
        const g = esU ? b.dataset.grupo : +b.dataset.grupo, sel = S.grupos ? new Set(S.grupos) : new Set(grupos);
        if (sel.has(g)) { if (sel.size === 1) return; sel.delete(g); } else sel.add(g);
        S.grupos = sel.size === grupos.length ? null : sel; b.setAttribute('aria-pressed', sel.has(g));
      } else return;
      const f = filtradas(); if (f.length && !f.includes(S.sel)) S.sel = f[0];
      render();
    });
    fe.querySelector('input').addEventListener('change', e => {
      const q = UI.normal(e.target.value.trim()); if (!q) return;
      let i = L.findIndex(x => UI.normal(etq(x)) === q); if (i < 0) i = L.findIndex(x => UI.normal(etq(x)).includes(q));
      elegir(i);
    });

    function render() {
      const e = L[S.sel], F = filtradas(), FL = F.map(i => L[i]);
      const iBest = R.wape.reduce((b, v, i) => (v != null && (R.wape[b] == null || v < R.wape[b]) ? i : b), 0);
      const iFreq = R.veces.reduce((b, v, i) => (v > R.veces[b] ? i : b), 0);
      const r25 = UI.suma(FL.map(x => sumaMeses(x.h, D.hist.meses, '2025'))), p27 = UI.suma(FL.map(x => (x.p ? sumaMeses(x.p, D.pron.meses, '2027') : 0)));
      const tot27 = sumaMeses(N.suma, D.pron.meses, '2027'), glob27 = sumaMeses(D.pron.p, D.pron.meses, '2027'), v = r25 ? p27 / r25 - 1 : null;
      kpis('k-' + nivel, [
        { l: `${Nom} en los filtros`, v: num(FL.length), d: `${num(FL.filter(x => x.est === 0).length)} con pronóstico · ${num(FL.filter(x => x.est !== 0).length)} sin pronóstico`,
          a: `Se pronostican ${esU ? 'los usuarios' : 'las cuentas'} con registro en ${UI.mes(D.meta.ultimo_mes)}. Los demás se listan con su estado.` },
        { l: 'Pronóstico 2027 (filtros)', v: num(G(p27), 2) + ' GWh', d: `<span class="${clase(v)}">${flecha(v)}${pctS(v)}</span> vs. real 2025 (${num(G(r25), 2)} GWh)`, color: CM[MEJOR] },
        { l: 'Evaluados con prueba de 12 meses', v: num(R.evaluados), d: `${pct(R.evaluados / R.activos)} de ${esU ? 'los' : 'las'} ${num(R.activos)} con pronóstico`, color: C.aqua,
          a: 'Los demás tienen historia corta y usan el promedio móvil de 12 meses.' },
        { l: 'Modelo con menor WAPE', v: MOD[iBest], d: `WAPE ${num(R.wape[iBest], 1)} % en todo el nivel`, color: CM[MOD[iBest]] },
        { l: 'Modelo elegido más veces', v: MOD[iFreq], d: `${num(R.veces[iFreq])} ${nom} (${pct(R.veces[iFreq] / R.activos)})`, color: CM[MOD[iFreq]] },
        { l: 'Suma del nivel vs. global', v: `<span class="${clase(tot27 / glob27 - 1)}">${pctS(tot27 / glob27 - 1)}</span>`, d: `2027: ${num(G(tot27), 1)} vs. ${num(G(glob27), 1)} GWh`, color: C.rojo },
      ]);
      fe.querySelector('.f-resumen').innerHTML = `Mostrando <b>${esc(etq(e))}</b> · ${esc(ESTADO_TXT[e.est])}${e.ult ? ` · último registro ${UI.mes(e.ult)}` : ''} · ${num(F.length)} ${nom} en los filtros`;
      // Serie de la entidad
      document.getElementById(k + '-serie-tit').textContent = etq(e);
      document.getElementById(k + '-serie-sub').innerHTML = e.est === 0
        ? `Modelo: <b>${e.mod >= 0 ? MOD[e.mod] : 'Promedio móvil 12 m'}</b>` + (e.mape != null ? ` · prueba de 12 meses: MAPE ${num(e.mape, 1)} %, WAPE ${num(e.wape, 1)} %, R² ${num(e.r2, 2)}` : ' · historia corta, sin prueba') +
          ` · ${esU ? esc(e.seg) : 'ciclo ' + e.ciclo} · 2027: <b>${num(sumaMeses(e.p, D.pron.meses, '2027') / 1e3, 1)} MWh</b>`
        : `<b>Sin pronóstico:</b> ${esc(ESTADO_TXT[e.est])}${e.ult ? ` (último registro ${UI.mes(e.ult)})` : ''}. Se asume que no seguirá consumiendo.`;
      const cm = e.mod >= 0 ? CM[MOD[e.mod]] : C.tinta3, hv = e.h.map(x => (x == null ? null : x / 1e3)), ultH = hv[hv.length - 1];
      const tr = [{ type: 'scatter', mode: 'lines', x: FH, y: hv, name: 'Real', line: { color: C.tinta, width: 2 }, connectgaps: false, hovertemplate: '<b>%{y:,.1f} MWh</b><extra>Real</extra>' }];
      const b80 = bandaE(e, 'q80'), b90 = bandaE(e, 'q90');
      const bandaT = (b, nombre, alfa) => [
        { type: 'scatter', mode: 'lines', x: FP, y: b.sup.map(x => x / 1e3), line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
        { type: 'scatter', mode: 'lines', x: FP, y: b.inf.map(x => x / 1e3), line: { width: 0 }, fill: 'tonexty', fillcolor: cm + alfa, name: nombre, hoverinfo: 'skip' }];
      if (b90 && (S.banda === 'ambas' || S.banda === '90')) tr.unshift(...bandaT(b90, 'Intervalo 90 %', '30'));
      if (b80 && (S.banda === 'ambas' || S.banda === '80')) tr.push(...bandaT(b80, 'Intervalo 80 %', '55'));
      if (e.p) tr.push({ type: 'scatter', mode: 'lines+markers', x: ultH != null ? [FH[FH.length - 1], ...FP] : FP, y: ultH != null ? [ultH, ...e.p.map(x => x / 1e3)] : e.p.map(x => x / 1e3),
        name: 'Pronóstico', line: { color: cm, width: 2.4, dash: 'dash' }, marker: { size: 4 }, hovertemplate: '<b>%{y:,.1f} MWh</b><extra>Pronóstico</extra>' });
      const nReg = e.h.filter(x => x != null).length;
      if (e.est === 2 || !e.h.some(x => x)) Plotly.purge(document.getElementById(k + '-serie'));
      if (e.est !== 2 && !e.h.some(x => x)) document.getElementById(k + '-serie').innerHTML = `<div class="vacio">${esU ? 'Este usuario' : 'Esta cuenta'} solo tiene ${nReg} ${nReg === 1 ? 'mes registrado' : 'meses registrados'} y todos con 0 kWh.</div>`;
      else if (e.est === 2) document.getElementById(k + '-serie').innerHTML = `<div class="vacio">${esU ? 'Este usuario' : 'Esta cuenta'} solo tiene registros en ${D.meta.mes_excluido}, mes incompleto que se excluye del análisis.</div>`;
      else { dibujar(k + '-serie', tr, { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'MWh' }, rangemode: 'tozero' }, hovermode: 'x unified',
        shapes: [{ type: 'line', xref: 'x', yref: 'paper', x0: FH[FH.length - 1], x1: FH[FH.length - 1], y0: 0, y1: 1, line: { color: C.tinta3, dash: 'dot', width: 1 } }] }); }
      // Comparación de modelos para la entidad
      const elM = document.getElementById(k + '-modelos');
      if (!e.mae_m) { Plotly.purge(elM); elM.innerHTML = `<div class="vacio">${e.est === 0 ? 'Historia demasiado corta para apartar 12 meses de prueba: se usa el promedio móvil de 12 meses.' : 'Sin pronóstico: no se evaluaron modelos.'}</div>`; }
      else {
        if (elM.querySelector('.vacio')) elM.innerHTML = '';
        const ix = MOD.map((m, i) => i).filter(i => e.mae_m[i] != null).sort((a, b) => e.mae_m[b] - e.mae_m[a]);
        dibujar(k + '-modelos', [{ type: 'bar', orientation: 'h', y: ix.map(i => MOD[i]), x: ix.map(i => e.mae_m[i] / 1e3),
          marker: { color: ix.map(i => (i === e.mod ? CM[MOD[i]] : C.rejilla)), line: { color: ix.map(i => CM[MOD[i]]), width: 1.5 } },
          text: ix.map(i => `${num(e.mae_m[i] / 1e3, 1)} MWh · MAPE ${e.mape_m[i] == null ? '—' : num(e.mape_m[i], 1) + ' %'}`), textposition: 'outside', cliponaxis: false, textfont: { size: 10.5 },
          hovertemplate: '%{y}: <b>%{text}</b><extra></extra>' }],
          { yaxis: { type: 'category' }, xaxis: { title: { text: 'MAE (MWh por mes)' }, rangemode: 'tozero' }, showlegend: false, margin: { r: 130 } });
      }
      // Pronóstico mes a mes
      if (!e.p) { const el = document.getElementById(k + '-mensual'); Plotly.purge(el); el.innerHTML = '<div class="vacio">Sin pronóstico</div>'; }
      else dibujar(k + '-mensual', [
        { type: 'bar', x: FP, y: e.p.map(x => x / 1e3), name: 'Pronóstico', marker: { color: cm },
          error_y: b80 ? { type: 'data', symmetric: false, array: b80.sup.map((v, i) => (v - e.p[i]) / 1e3), arrayminus: b80.inf.map((v, i) => (e.p[i] - v) / 1e3), color: C.tinta2, thickness: 1, width: 3 } : undefined,
          customdata: b80 ? b80.inf.map((v, i) => [v / 1e3, b80.sup[i] / 1e3]) : null,
          hovertemplate: '%{x|%b %Y}: <b>%{y:,.1f} MWh</b>' + (b80 ? '<br>80 %: %{customdata[0]:,.1f} – %{customdata[1]:,.1f}' : '') + '<extra>Pronóstico</extra>' },
        { type: 'scatter', mode: 'lines+markers', x: FP, y: D.pron.meses.map(m => { const v = valorMes(e, mesAnt(m)); return v == null ? null : v / 1e3; }),
          name: 'Mismo mes año anterior', line: { color: C.tinta, width: 1.5 }, marker: { size: 5 }, hovertemplate: '%{y:,.1f} MWh<extra>Año anterior</extra>' },
      ], { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'MWh' }, rangemode: 'tozero' }, hovermode: 'x unified', bargap: 0.3 });
      // Tabla mensual de la entidad con intervalos
      tabla(k + '-meses', [{ t: 'Mes', inicial: true, asc: true }, { t: 'Meses adelante', num: true }, { t: 'Pronóstico (kWh)', num: true },
        { t: 'Inferior 80 %', num: true }, { t: 'Superior 80 %', num: true }, { t: 'Inferior 90 %', num: true }, { t: 'Superior 90 %', num: true }, { t: 'Modelo' }],
        e.p ? D.pron.meses.map((m, i) => [m, i + 1, e.p[i], b80 ? b80.inf[i] : null, b80 ? b80.sup[i] : null, b90 ? b90.inf[i] : null, b90 ? b90.sup[i] : null,
          e.mod >= 0 ? MOD[e.mod] : 'Promedio móvil 12 m']) : [], `pronostico_mensual_${e.cod}`, { porPagina: 15 });
      // Comparación de modelos en todo el nivel
      const ordW = MOD.map((m, i) => i).filter(i => R.wape[i] != null).sort((a, b) => R.wape[b] - R.wape[a]);
      dibujar(k + '-wape', [{ type: 'bar', orientation: 'h', y: ordW.map(i => MOD[i]), x: ordW.map(i => R.wape[i]), marker: { color: ordW.map(i => CM[MOD[i]]) },
        text: ordW.map(i => num(R.wape[i], 1) + ' %'), textposition: 'outside', cliponaxis: false, customdata: ordW.map(i => [R.mape_med[i], R.mase_med[i]]),
        hovertemplate: '%{y}<br>WAPE <b>%{x:.1f} %</b> · MAPE mediano %{customdata[0]:.1f} % · MASE mediano %{customdata[1]:.2f}<extra></extra>' }],
        { yaxis: { type: 'category' }, xaxis: { title: { text: 'WAPE (%)' } }, showlegend: false, margin: { r: 50 } });
      const ordV = MOD.map((m, i) => i).sort((a, b) => R.veces[a] - R.veces[b]);
      dibujar(k + '-veces', [{ type: 'bar', orientation: 'h', y: ordV.map(i => MOD[i]), x: ordV.map(i => R.veces[i]), marker: { color: ordV.map(i => CM[MOD[i]]) },
        text: ordV.map(i => num(R.veces[i])), textposition: 'outside', cliponaxis: false, hovertemplate: '%{y}: <b>%{x}</b><extra></extra>' }],
        { yaxis: { type: 'category' }, xaxis: { title: { text: Nom } }, showlegend: false, margin: { r: 40 } });
      dibujar(k + '-coherencia', [
        { type: 'scatter', mode: 'lines+markers', x: FP, y: D.pron.p.map(G), name: `Global (${MEJOR})`, line: { color: CM[MEJOR], width: 2.6 }, hovertemplate: '%{y:,.2f} GWh<extra>Global</extra>' },
        { type: 'scatter', mode: 'lines+markers', x: FP, y: N.suma.map(G), name: `Suma de ${nom}`, line: { color: C.azul, width: 1.8, dash: 'dash' }, hovertemplate: `%{y:,.2f} GWh<extra>Suma ${nom}</extra>` },
      ], { xaxis: UI.EJE_FECHA, yaxis: { title: { text: 'GWh' } }, hovermode: 'x unified' });
      const top = FL.filter(x => x.est === 0).slice(0, 15).reverse();
      dibujar(k + '-top', [
        { type: 'bar', orientation: 'h', y: top.map(x => corto(etq(x), 40)), x: top.map(x => G(sumaMeses(x.h, D.hist.meses, '2025'))), name: '2025 real', marker: { color: C.gris }, hovertemplate: '%{x:,.2f} GWh<extra>2025 real</extra>' },
        { type: 'bar', orientation: 'h', y: top.map(x => corto(etq(x), 40)), x: top.map(x => G(sumaMeses(x.p, D.pron.meses, '2027'))), name: '2027 pronóstico', marker: { color: CM[MEJOR] }, hovertemplate: '%{x:,.2f} GWh<extra>2027 pronóstico</extra>' },
      ], { barmode: 'group', yaxis: { type: 'category', tickfont: { size: 10 } }, xaxis: { title: { text: 'GWh' } }, bargap: 0.2 });
      // Tabla con todas las entidades
      const cols = esU ? [{ t: 'Código' }, { t: 'Usuario' }, { t: 'Segmento' }] : [{ t: 'Cuenta' }, { t: 'Código usuario' }, { t: 'Usuario' }, { t: 'Ciclo' }];
      tabla(k + '-tabla', [...cols, { t: 'Estado' }, { t: 'Último registro' }, { t: 'Modelo' }, { t: 'MAPE %', num: true, dec: 1 }, { t: 'WAPE %', num: true, dec: 1 }, { t: 'R²', num: true, dec: 2 },
        { t: 'Real 2025 (MWh)', num: true, dec: 1 }, { t: 'Pronóstico 2027 (MWh)', num: true, dec: 1, inicial: true }, { t: 'Variación %', num: true, dec: 1 }],
        FL.map(x => { const a = sumaMeses(x.h, D.hist.meses, '2025') / 1e3, b = x.p ? sumaMeses(x.p, D.pron.meses, '2027') / 1e3 : null;
          return [...(esU ? [x.cod, x.nom, x.seg] : [x.cod, x.usr, x.nom, x.ciclo]), ESTADO_TXT[x.est], x.ult || '—',
            x.est === 0 ? (x.mod >= 0 ? MOD[x.mod] : 'Promedio móvil 12 m') : '—', x.mape, x.wape, x.r2, a, b, a > 0 && b != null ? (b / a - 1) * 100 : null]; }),
        'prediccion_' + nivel, { destacar: f => f[0] === e.cod });
    }
    // Clic en una fila de la tabla: la muestra arriba
    document.getElementById(k + '-tabla').addEventListener('click', ev => {
      const tr = ev.target.closest('tbody tr'); if (!tr) return;
      elegir(L.findIndex(x => x.cod === tr.cells[0].textContent));
      document.getElementById('g-' + nivel).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return render;
  }

  const sumaMeses = (arr, meses, pref) => (arr ? meses.reduce((s, m, k) => s + (m.startsWith(pref) ? (arr[k] || 0) : 0), 0) : 0);

  document.getElementById('pie').innerHTML = `<p><b>Método:</b> validación temporal con origen móvil (${D.meta.origenes.length} orígenes × 12 meses, sin usar datos futuros), hiperparámetros con GridSearchCV + TimeSeriesSplit y selección por ${D.meta.criterio.replace('_%', '')}. Intervalos empíricos a partir de los errores de validación.</p>
    <p><b>Fuente:</b> Electrohuila, tabla estadistica_usuario (tipo_usuario = NR). Variables externas: días hábiles y festivos de Colombia. Detalle en homework/Prediccion.ipynb y data/output/indicadores.xlsx.</p>`;
  const RENDER = { global: () => { renderPronostico(); renderModelos(); }, usuarios: pestanaEntidad('usuarios'), cuentas: pestanaEntidad('cuentas') }, hecho = {};
  UI.pestanas('pred_tab', tab => { if (!hecho[tab]) { RENDER[tab](); hecho[tab] = true; } else UI.redimensionar(document.getElementById('tab-' + tab)); });
}

/* =====================================================================================
   Página · Inicio (dos pestañas con los dashboards en iframes, carga diferida)
   ===================================================================================== */
function paginaInicio() {
  const marcos = { exploratorio: document.getElementById('f-exploratorio'), prediccion: document.getElementById('f-prediccion') };
  const enlace = document.getElementById('abrir-actual');
  UI.pestanas('inicio_tab', tab => {
    Object.entries(marcos).forEach(([k, f]) => {
      if (k === tab && !f.getAttribute('src')) f.setAttribute('src', f.dataset.src);
      f.hidden = k !== tab;
    });
    if (enlace) enlace.href = marcos[tab].dataset.src;
  });
}

/* ------------------------------ Arranque ------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  const pagina = document.body.dataset.pagina;
  UI.modoEmbebido();
  UI.iniciarTooltips();
  if (window.Plotly) UI.registrarIdioma();
  if (pagina === 'exploratorio') paginaExploratorio();
  else if (pagina === 'prediccion') paginaPrediccion();
  else if (pagina === 'inicio') paginaInicio();
});
