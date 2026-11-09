"""Utilidades compartidas: rutas, estilo gráfico, formatos, métricas de error y exportación.

Todas las rutas se calculan a partir de la raíz del proyecto (la carpeta que contiene ``src/``), por lo que
el código funciona igual desde la raíz, desde ``homework/`` o desde cualquier otra carpeta.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

# ----------------------------------------------------------------------------------------------------------
# Rutas
# ----------------------------------------------------------------------------------------------------------
RAIZ = Path(__file__).resolve().parents[1]
DIR_INPUT = RAIZ / 'data' / 'input'
DIR_OUTPUT = RAIZ / 'data' / 'output'
DIR_REPORTES = DIR_OUTPUT / 'reportes'
DIR_FIG_PRED = DIR_REPORTES / 'prediccion' / 'figuras'
DIR_MODELOS = DIR_OUTPUT / 'modelos'
DIR_TEMPLATES = RAIZ / 'templates'
DIR_STATIC_JS = RAIZ / 'static' / 'js'

RUTA_CONSUMOS = DIR_INPUT / 'consumos.xlsx'
RUTA_USUARIOS = DIR_INPUT / 'usuarios.xlsx'
RUTA_VARIABLES = DIR_INPUT / 'variables_externas.csv'
RUTA_PREDICCIONES = DIR_OUTPUT / 'predicciones.xlsx'
RUTA_INDICADORES = DIR_OUTPUT / 'indicadores.xlsx'
RUTA_DATA_JS = DIR_STATIC_JS / 'data.js'

HOJA_CONSUMOS = 'Exportar Hoja de Trabajo'
FUENTE = 'Fuente: Electrohuila, tabla estadistica_usuario (tipo_usuario = NR). Cálculos propios.'


def crear_carpetas() -> None:
    for d in (DIR_INPUT, DIR_OUTPUT, DIR_FIG_PRED, DIR_MODELOS, DIR_STATIC_JS):
        d.mkdir(parents=True, exist_ok=True)


# ----------------------------------------------------------------------------------------------------------
# Paleta (la misma del análisis exploratorio y de los dashboards: cada color tiene un único significado)
# ----------------------------------------------------------------------------------------------------------
AZUL, AZUL_OSCURO, NARANJA, AQUA = '#2a78d6', '#1b4f91', '#eb6834', '#1baf7a'
AMARILLO, ROJO, VIOLETA, MAGENTA = '#eda100', '#e34948', '#6250d6', '#e87ba4'
TINTA, TINTA_2, TINTA_3, REJILLA = '#1d1d1b', '#52514e', '#8a8984', '#e7e6e2'
COLORES_MODELO = {
    'Naive estacional': '#8a8984', 'Promedio móvil 12 m': '#c9c8c3', 'Holt-Winters': AZUL,
    'Regresión estacional': AQUA, 'Ridge con rezagos': VIOLETA, 'Random Forest': NARANJA,
    'Gradient Boosting': AMARILLO,
}
MESES_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']


def aplicar_estilo() -> None:
    """Estilo de matplotlib coherente con las figuras del análisis exploratorio."""
    import matplotlib.pyplot as plt
    plt.rcParams.update({
        'figure.facecolor': 'white', 'axes.facecolor': 'white', 'savefig.facecolor': 'white',
        'font.family': 'DejaVu Sans', 'font.size': 10.5, 'text.color': TINTA,
        'axes.edgecolor': REJILLA, 'axes.labelcolor': TINTA_2, 'axes.titlesize': 11.5, 'axes.titleweight': 'bold',
        'axes.titlelocation': 'left', 'axes.spines.top': False, 'axes.spines.right': False, 'axes.spines.left': False,
        'axes.grid': True, 'axes.grid.axis': 'y', 'grid.color': REJILLA, 'grid.linewidth': 0.8, 'axes.axisbelow': True,
        'xtick.color': TINTA_2, 'ytick.color': TINTA_2, 'xtick.labelsize': 9.5, 'ytick.labelsize': 9.5,
        'xtick.major.size': 0, 'ytick.major.size': 0, 'legend.frameon': False, 'legend.fontsize': 9.5,
        'lines.linewidth': 2, 'figure.dpi': 110, 'savefig.dpi': 160, 'savefig.bbox': 'tight',
    })


class Figuras:
    """Numera, titula y guarda las figuras del cuaderno de predicción en data/output/reportes/prediccion/figuras."""

    def __init__(self, carpeta: Path = DIR_FIG_PRED, limpiar: bool = True):
        self.carpeta, self.n = Path(carpeta), 0
        self.carpeta.mkdir(parents=True, exist_ok=True)
        if limpiar:
            for viejo in self.carpeta.glob('*.png'):
                try:
                    viejo.unlink()
                except OSError:
                    pass

    def nueva(self, titulo: str, subtitulo: str = '', ancho: float = 12, alto: float = 5, filas: int = 1,
              columnas: int = 1, **kw):
        import matplotlib.pyplot as plt
        self.n += 1
        fig, axes = plt.subplots(filas, columnas, figsize=(ancho, alto), **kw)
        fig.subplots_adjust(top=1 - (1.05 if subtitulo else 0.75) / alto, left=0.07, right=0.97)
        fig.text(0.01, 1 - 0.12 / alto, f'Figura {self.n}. {titulo}', fontsize=14, fontweight='bold', ha='left', va='top')
        if subtitulo:
            fig.text(0.01, 1 - 0.48 / alto, subtitulo, fontsize=10.5, color=TINTA_2, ha='left', va='top')
        return fig, axes

    def guardar(self, fig, nombre: str, nota: str = '') -> None:
        import matplotlib.pyplot as plt
        fig.text(0.01, 0.0, FUENTE + (f'  {nota}' if nota else ''), fontsize=8.5, color=TINTA_3, ha='left', va='top')
        ruta = self.carpeta / f'{self.n:02d}_{nombre}.png'
        fig.savefig(ruta)
        plt.show()


# ----------------------------------------------------------------------------------------------------------
# Formatos
# ----------------------------------------------------------------------------------------------------------
def eje_fechas_es(ax, meses=(1, 7), con_anio=True) -> None:
    """Eje x de fechas con meses en español ('Ene 2026'), independiente de la configuración regional."""
    import matplotlib.dates as mdates
    import matplotlib.ticker as mtick
    ax.xaxis.set_major_locator(mdates.MonthLocator(bymonth=list(meses)))
    ax.xaxis.set_major_formatter(mtick.FuncFormatter(
        lambda x, p: MESES_ES[mdates.num2date(x).month - 1] + (f' {mdates.num2date(x).year}' if con_anio else '')))


def fmt_es(x: float, dec: int = 1) -> str:
    """1234.5 -> '1.234,5'."""
    return f'{x:,.{dec}f}'.replace(',', 'X').replace('.', ',').replace('X', '.')


def miles(x, pos=None) -> str:
    return fmt_es(x, 0)


# ----------------------------------------------------------------------------------------------------------
# Métricas de error
# ----------------------------------------------------------------------------------------------------------
def metricas(real, pred, escala_mase: float | None = None) -> dict:
    """MAE, RMSE, MAPE, WAPE, R², sesgo y (opcional) MASE de un pronóstico.

    - MAPE excluye los meses con consumo real igual a cero (el porcentaje no está definido).
    - WAPE = Σ|error| / Σ real: error porcentual ponderado por volumen, robusto con series pequeñas.
    - R² compara el pronóstico con la media del periodo evaluado; puede ser negativo si el modelo lo hace
      peor que esa media (frecuente en ventanas cortas y series con poca variación).
    - Sesgo = Σ(pronóstico − real) / Σ real: positivo = sobrestima.
    - MASE = MAE / MAE del naive estacional dentro de la muestra de entrenamiento (escala_mase).
    """
    y, p = np.asarray(real, float), np.asarray(pred, float)
    e = p - y
    mae, rmse = float(np.mean(np.abs(e))), float(np.sqrt(np.mean(e ** 2)))
    nz = y != 0
    mape = float(np.mean(np.abs(e[nz] / y[nz])) * 100) if nz.any() else np.nan
    tot = float(np.sum(np.abs(y)))
    wape = float(np.sum(np.abs(e)) / tot * 100) if tot else np.nan
    sst = float(np.sum((y - y.mean()) ** 2))
    r2 = float(1 - np.sum(e ** 2) / sst) if sst > 0 else np.nan
    sesgo = float(np.sum(e) / np.sum(y) * 100) if np.sum(y) else np.nan
    res = {'MAE': mae, 'RMSE': rmse, 'MAPE_%': mape, 'WAPE_%': wape, 'R2': r2, 'Sesgo_%': sesgo}
    if escala_mase is not None:
        res['MASE'] = float(mae / escala_mase) if escala_mase and escala_mase > 0 else np.nan
    return res


# ----------------------------------------------------------------------------------------------------------
# Exportación a Excel con formato (índice, Tablas de Excel, encabezados fijos y formatos numéricos)
# ----------------------------------------------------------------------------------------------------------
def exportar_excel(ruta: Path, hojas: list, titulo: str) -> Path:
    """Escribe un libro con una hoja *Índice* y una Tabla de Excel con filtros por cada elemento de ``hojas``.

    Cada elemento es un dict con: hoja (≤31 caracteres), tabla (DataFrame), titulo, descripcion y, opcional,
    formatos {columna: formato_excel}. Si el archivo está abierto en Excel se guarda con otro nombre.
    """
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.table import Table, TableStyleInfo

    ruta = Path(ruta)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    FILA_ENC = 4

    def escribir(destino: Path) -> Path:
        with pd.ExcelWriter(destino, engine='openpyxl') as xw:
            indice = pd.DataFrame({'Hoja': [h['hoja'] for h in hojas], 'Contenido': [h['titulo'] for h in hojas],
                                   'Descripción': [h.get('descripcion', '') for h in hojas],
                                   'Filas': [len(h['tabla']) for h in hojas]})
            indice.to_excel(xw, sheet_name='Índice', index=False, startrow=FILA_ENC - 1)
            ws = xw.sheets['Índice']
            ws['A1'] = titulo
            ws['A1'].font = Font(size=14, bold=True, color=TINTA[1:])
            ws['A2'] = f'Generado el {datetime.now():%Y-%m-%d %H:%M}. {FUENTE}'
            ws['A2'].font = Font(size=9, italic=True, color=TINTA_3[1:])
            for i, h in enumerate(hojas, start=FILA_ENC + 1):
                c = ws.cell(row=i, column=1)
                c.hyperlink = f"#'{h['hoja']}'!A1"
                c.font = Font(color=AZUL.replace('#', ''), underline='single')
            for k, w in enumerate([28, 46, 90, 8], start=1):
                ws.column_dimensions[get_column_letter(k)].width = w

            for n, h in enumerate(hojas, start=1):
                t = h['tabla'].copy()
                for col in t.columns:
                    if pd.api.types.is_datetime64_any_dtype(t[col]):
                        t[col] = t[col].dt.strftime('%Y-%m')
                t.to_excel(xw, sheet_name=h['hoja'], index=False, startrow=FILA_ENC - 1)
                ws = xw.sheets[h['hoja']]
                ws.sheet_view.showGridLines = False
                ws['A1'] = h['titulo']
                ws['A1'].font = Font(size=13, bold=True, color=TINTA[1:])
                ws['A2'] = h.get('descripcion', '')
                ws['A2'].font = Font(size=9, italic=True, color=TINTA_2[1:])
                ws.freeze_panes = ws.cell(row=FILA_ENC + 1, column=1)
                if len(t):
                    ref = f'A{FILA_ENC}:{get_column_letter(t.shape[1])}{FILA_ENC + len(t)}'
                    tab = Table(displayName=f'T{n}_{"".join(ch for ch in h["hoja"] if ch.isalnum())[:20]}', ref=ref)
                    tab.tableStyleInfo = TableStyleInfo(name='TableStyleMedium2', showRowStripes=True)
                    ws.add_table(tab)
                formatos = h.get('formatos', {})
                for k, col in enumerate(t.columns, start=1):
                    letra = get_column_letter(k)
                    ancho = max(len(str(col)), *(len(str(v)) for v in t[col].head(200))) if len(t) else len(str(col))
                    ws.column_dimensions[letra].width = min(max(10, ancho + 2), 60)
                    ws.cell(row=FILA_ENC, column=k).alignment = Alignment(wrap_text=True, vertical='center')
                    fmt = formatos.get(col)
                    if fmt is None and pd.api.types.is_float_dtype(t[col]):
                        fmt = '#,##0.00'
                    elif fmt is None and pd.api.types.is_integer_dtype(t[col]):
                        fmt = '#,##0'
                    if fmt:
                        for fila in range(FILA_ENC + 1, FILA_ENC + 1 + len(t)):
                            ws.cell(row=fila, column=k).number_format = fmt
                ws.cell(row=FILA_ENC, column=1).fill = PatternFill('solid', fgColor='1B4F91')
        return destino

    try:
        return escribir(ruta)
    except PermissionError:
        alterna = ruta.with_name(f'{ruta.stem}_{datetime.now():%Y%m%d_%H%M%S}{ruta.suffix}')
        print(f'Aviso: {ruta.name} está abierto en otro programa; se guarda como {alterna.name}')
        return escribir(alterna)


def escribir_data_js(ruta: Path = RUTA_DATA_JS, **variables) -> Path:
    """Escribe static/js/data.js con una variable global por argumento (window.NOMBRE = {...})."""
    ruta = Path(ruta)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    partes = ['/* Archivo generado automáticamente por src/prediccion.py: no editar a mano. */']
    for nombre, valor in variables.items():
        texto = json.dumps(valor, ensure_ascii=False, separators=(',', ':'), allow_nan=False, default=_json_default)
        partes.append(f'window.{nombre} = {texto};')
    ruta.write_text('\n'.join(partes) + '\n', encoding='utf-8')
    return ruta


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.strftime('%Y-%m')
    raise TypeError(type(o))


def redondear(valores, dec: int = 0) -> list:
    """Lista JSON-segura: NaN/inf -> None, redondeo opcional."""
    out = []
    for v in valores:
        if v is None or (isinstance(v, float) and not np.isfinite(v)):
            out.append(None)
        else:
            out.append(int(round(float(v))) if dec == 0 else round(float(v), dec))
    return out
