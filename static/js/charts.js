/* =====================================================================================
   charts.js · Componentes compartidos por los dashboards.

   Expone el objeto global UI con:
   - paleta, formatos numéricos y de fecha en español;
   - configuración base de Plotly (idioma, separadores, márgenes) y la función dibujar();
   - tooltips de ayuda, tarjetas de KPI, tarjetas de gráfico y tablas ordenables con descarga CSV;
   - controlador de pestañas accesible (teclado, hash de la URL y memoria de la última pestaña).
   No contiene datos ni lógica de negocio (ver app.js y data.js).
   ===================================================================================== */
const UI = (() => {
  'use strict';

  /* ------------------------------ Paleta ------------------------------ */
  const COL = { azul: '#2a78d6', azulO: '#1b4f91', naranja: '#eb6834', aqua: '#1baf7a', amarillo: '#eda100',
    rojo: '#e34948', violeta: '#6250d6', magenta: '#e87ba4', tinta: '#1d1d1b', tinta2: '#4f5054', tinta3: '#85868a',
    rejilla: '#ebebe7', gris: '#c9c8c3' };
  const COL_MODELO = { 'Naive estacional': '#8a8984', 'Promedio móvil 12 m': '#b5b4ae', 'Holt-Winters': COL.azul,
    'Regresión estacional': COL.aqua, 'Ridge con rezagos': COL.violeta, 'Random Forest': COL.naranja,
    'Gradient Boosting': COL.amarillo };
  const ESCALA = [[0, '#f1f6fd'], [0.35, '#a9c9f1'], [0.7, '#3f86da'], [1, '#123f7a']];
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const MESES_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  /* ------------------------------ Formatos ------------------------------ */
  const num = (x, dec = 0) => (x == null || !isFinite(x) ? '—' :
    Number(x).toLocaleString('es-CO', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
  const pct = (x, dec = 1) => (x == null || !isFinite(x) ? '—' : num(x * 100, dec) + ' %');
  const pctS = (x, dec = 1) => (x == null || !isFinite(x) ? '—' : (x > 0 ? '+' : '') + num(x * 100, dec) + ' %');
  const clase = x => (x == null ? '' : x > 0 ? 'sube' : x < 0 ? 'baja' : '');
  const flecha = x => (x == null ? '' : x > 0 ? '▲ ' : x < 0 ? '▼ ' : '');
  const mes = s => { const [a, m] = s.split('-'); return MESES[+m - 1] + ' ' + a; };   // '2026-09' -> 'sep 2026'
  const fecha = s => s + '-01';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const corto = (s, n = 34) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const normal = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const suma = a => a.reduce((s, v) => s + (v || 0), 0);

  /* ------------------------------ Plotly ------------------------------ */
  function registrarIdioma() {
    try {
      Plotly.register({ moduleType: 'locale', name: 'es', dictionary: {}, format: {
        days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
        shortDays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'], months: MESES_L, shortMonths: MESES,
        date: '%d/%m/%Y', decimal: ',', thousands: '.', grouping: [3], currency: ['$', ''] } });
    } catch (e) { /* el idioma es opcional */ }
  }
  const EJE = { gridcolor: COL.rejilla, zeroline: false, linecolor: '#d6d6d1', tickcolor: '#d6d6d1', automargin: true,
    title: { font: { size: 11, color: COL.tinta3 } } };
  const BASE = {
    font: { family: '"Segoe UI", Inter, system-ui, sans-serif', size: 11.5, color: COL.tinta2 },
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', separators: ',.',
    margin: { l: 10, r: 14, t: 10, b: 10 }, hovermode: 'closest',
    hoverlabel: { bgcolor: '#fff', bordercolor: '#d6d6d1', font: { color: COL.tinta, size: 12 } },
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { size: 11.5 } },
    xaxis: EJE, yaxis: EJE, bargap: 0.25,
  };
  const CONFIG = { responsive: true, displaylogo: false, locale: 'es',
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d', 'toggleSpikelines'],
    toImageButtonOptions: { format: 'png', scale: 2 } };
  const EJE_FECHA = { type: 'date', tickformat: '%b\n%Y', hoverformat: '%B %Y' };
  const fusion = (a, b) => {
    const r = { ...a };
    for (const k in b) r[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] ? fusion(a[k], b[k]) : b[k];
    return r;
  };
  function dibujar(id, trazas, layout = {}) {
    const el = document.getElementById(id); if (!el) return;
    const hay = trazas.some(t => (t.y || t.x || t.z || []).some(v => v != null && v !== 0));
    if (!hay) { Plotly.purge(el); el.innerHTML = '<div class="vacio">Sin datos para los filtros seleccionados</div>'; return; }
    if (el.querySelector('.vacio')) { el.innerHTML = ''; Plotly.purge(el); }   // el gráfico anterior se borró: se reinicia
    Plotly.react(el, trazas, fusion(BASE, layout), CONFIG);
  }
  function redimensionar(contenedor) {
    contenedor.querySelectorAll('.js-plotly-plot').forEach(g => Plotly.Plots.resize(g));
  }

  /* ------------------------------ Ayuda (tooltips) ------------------------------ */
  const ayuda = t => (t ? `<span class="i" tabindex="0" role="img" aria-label="Ayuda: ${esc(t)}" data-tip="${esc(t)}">i</span>` : '');
  function iniciarTooltips() {
    const tip = document.getElementById('tip'); if (!tip) return;
    const mostrar = e => {
      const el = e.target.closest && e.target.closest('[data-tip]'); if (!el) return;
      tip.textContent = el.dataset.tip; tip.hidden = false;
      const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
      tip.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + 'px';
    };
    const ocultar = e => { if (e.target.closest && e.target.closest('[data-tip]')) tip.hidden = true; };
    document.addEventListener('mouseover', mostrar); document.addEventListener('focusin', mostrar);
    document.addEventListener('mouseout', ocultar); document.addEventListener('focusout', ocultar);
  }

  /* ------------------------------ KPIs y tarjetas ------------------------------ */
  function kpis(id, lista) {
    document.getElementById(id).innerHTML = lista.map(k => `
      <div class="kpi" style="--acento:${k.color || COL.azul}">
        <div class="kpi-l">${k.l}${ayuda(k.a)}</div>
        <div class="kpi-v${/^[\d\-+±−<]/.test(String(k.v)) ? '' : ' txt'}" title="${esc(String(k.v).replace(/<[^>]+>/g, ''))}">${k.v}</div><div class="kpi-d">${k.d || '&nbsp;'}</div></div>`).join('');
  }
  /** Crea las tarjetas de una rejilla. Cada tarjeta: {id, t, s, a, ancho, alto, tabla, herr, nota}. */
  function tarjetas(idRejilla, lista) {
    document.getElementById(idRejilla).innerHTML = lista.map(t => `
      <article class="tarjeta${t.ancho ? ' ancho' : ''}">
        <div class="tar-cab"><div><h2 id="${t.id}-tit">${t.t}</h2><p id="${t.id}-sub">${t.s || ''}</p></div>${ayuda(t.a)}</div>
        ${t.herr ? `<div class="tar-herr" id="${t.id}-herr"></div>` : ''}
        ${t.tabla ? `<div id="${t.id}"></div>` : `<div class="grafico${t.alto ? ' alto' : ''}" id="${t.id}" role="img" aria-label="${esc(t.t)}"></div>`}
        ${t.nota ? `<div class="nota${t.notaInfo ? ' info' : ''}">${t.nota}</div>` : ''}
      </article>`).join('');
  }

  /* ------------------------------ Tablas ------------------------------ */
  const TABLAS = {};
  /** columnas: [{t, num, dec, inicial, a}] · filas: arrays · opciones: {destacar: fila => bool, porPagina} */
  function tabla(id, columnas, filas, archivo, opciones = {}) {
    const ini = Math.max(0, columnas.findIndex(c => c.inicial)), firma = columnas.map(c => c.t).join('|');
    const t = TABLAS[id] || (TABLAS[id] = { pag: 0, q: '' });
    if (t.firma !== firma) Object.assign(t, { firma, orden: ini, dir: columnas[ini].asc ? 1 : -1 });
    Object.assign(t, { columnas, filas, archivo, opciones, pag: 0 });
    const el = document.getElementById(id);
    if (!el.dataset.listo) {
      el.dataset.listo = 1;
      el.innerHTML = `<div class="tab-herr"><span class="cnt"></span><input type="search" placeholder="Buscar en la tabla…" aria-label="Buscar en la tabla">
        <button class="btn-sec" data-csv>Descargar CSV</button></div><div class="tabla-cont"><table></table></div><div class="pag"></div>`;
      el.querySelector('input').addEventListener('input', e => { t.q = normal(e.target.value); t.pag = 0; pintarTabla(id); });
      el.querySelector('[data-csv]').addEventListener('click', () => descargarCsv(id));
      el.addEventListener('click', e => {
        const th = e.target.closest('th'), pb = e.target.closest('.pag button');
        if (th) { const k = +th.dataset.k; t.dir = t.orden === k ? -t.dir : (t.columnas[k].num ? -1 : 1); t.orden = k; pintarTabla(id); }
        if (pb && !pb.disabled) { t.pag += +pb.dataset.p; pintarTabla(id); }
      });
    }
    pintarTabla(id);
  }
  const filasVisibles = t => {
    const k = t.orden, c = t.columnas[k];
    const fs = t.q ? t.filas.filter(f => normal(f.map(String).join(' ')).includes(t.q)) : t.filas.slice();
    const val = v => (v == null || (typeof v === 'number' && !isFinite(v)) ? -Infinity : v);
    return fs.sort((a, b) => (c.num ? (val(a[k]) - val(b[k])) : String(a[k]).localeCompare(String(b[k]), 'es')) * t.dir);
  };
  function pintarTabla(id) {
    const t = TABLAS[id], el = document.getElementById(id), POR = t.opciones.porPagina || 25;
    const fs = filasVisibles(t), nPag = Math.max(1, Math.ceil(fs.length / POR));
    t.pag = Math.min(Math.max(0, t.pag), nPag - 1);
    el.querySelector('.cnt').textContent = `${num(fs.length)} registros`;
    el.querySelector('table').innerHTML = `<thead><tr>${t.columnas.map((c, k) =>
      `<th data-k="${k}" class="${c.num ? 'num' : ''}" ${t.orden === k ? `aria-sort="${t.dir > 0 ? 'ascending' : 'descending'}"` : ''} title="${esc(c.a || 'Ordenar por esta columna')}">${c.t}</th>`).join('')}</tr></thead>
      <tbody>${fs.slice(t.pag * POR, (t.pag + 1) * POR).map(f => `<tr${t.opciones.destacar && t.opciones.destacar(f) ? ' class="destacada"' : ''}>${f.map((v, k) => {
        const c = t.columnas[k]; return `<td class="${c.num ? 'num' : ''}">${c.num ? num(v, c.dec || 0) : esc(v)}</td>`; }).join('')}</tr>`).join('')}</tbody>`;
    el.querySelector('.pag').innerHTML = nPag > 1 ? `<button data-p="-1" ${t.pag === 0 ? 'disabled' : ''} aria-label="Página anterior">‹</button>
      Página ${t.pag + 1} de ${nPag}<button data-p="1" ${t.pag >= nPag - 1 ? 'disabled' : ''} aria-label="Página siguiente">›</button>` : '';
  }
  function descargarCsv(id) {
    const t = TABLAS[id], fs = filasVisibles(t);
    const celda = (v, c) => {
      const s = v == null ? '' : (c.num && typeof v === 'number' ? String(+v.toFixed(c.dec || 0)).replace('.', ',') : String(v));
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = '﻿' + [t.columnas.map(c => c.t).join(';'), ...fs.map(f => f.map((v, k) => celda(v, t.columnas[k])).join(';'))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = t.archivo + '.csv'; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ------------------------------ Pestañas ------------------------------ */
  /** Controla un role="tablist". onAbrir(nombre) se llama al mostrar cada pestaña. */
  function pestanas(clave, onAbrir) {
    const lista = document.querySelector('[role="tablist"]');
    const botones = [...lista.querySelectorAll('[role="tab"]')], nombres = botones.map(b => b.dataset.tab);
    let actual = null;
    function abrir(tab, enfocar) {
      if (!nombres.includes(tab)) tab = nombres[0];
      actual = tab;
      botones.forEach(b => { const s = b.dataset.tab === tab; b.setAttribute('aria-selected', s); b.tabIndex = s ? 0 : -1; if (s && enfocar) b.focus(); });
      document.querySelectorAll('[role="tabpanel"]').forEach(p => { p.hidden = p.id !== 'tab-' + tab; });
      onAbrir(tab);
      try { history.replaceState(null, '', '#' + tab); localStorage.setItem(clave, tab); } catch (e) { /* opcional */ }
    }
    lista.addEventListener('click', e => { const b = e.target.closest('[role="tab"]'); if (b) abrir(b.dataset.tab); });
    lista.addEventListener('keydown', e => {
      const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key]; if (!k) return;
      abrir(nombres[(nombres.indexOf(actual) + k + nombres.length) % nombres.length], true); e.preventDefault();
    });
    window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (nombres.includes(h) && h !== actual) abrir(h); });
    let inicial = location.hash.slice(1);
    if (!nombres.includes(inicial)) { try { inicial = localStorage.getItem(clave) || nombres[0]; } catch (e) { inicial = nombres[0]; } }
    abrir(inicial);
    return { abrir, actual: () => actual };
  }

  /** Dentro de la página de inicio (iframe) se ocultan cabecera y pie propios. */
  function modoEmbebido() {
    let emb = false;
    try { emb = window.self !== window.top; } catch (e) { emb = true; }
    if (emb || new URLSearchParams(location.search).has('embebido')) document.body.classList.add('embebido');
  }

  return { COL, COL_MODELO, ESCALA, MESES, MESES_L, num, pct, pctS, clase, flecha, mes, fecha, esc, corto, normal, suma,
    registrarIdioma, BASE, CONFIG, EJE, EJE_FECHA, dibujar, redimensionar, ayuda, iniciarTooltips, kpis, tarjetas, tabla,
    pestanas, modoEmbebido };
})();
