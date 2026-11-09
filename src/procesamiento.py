"""Procesamiento de datos: carga, consolidación de usuarios, calendario y datos del dashboard exploratorio.

La consolidación replica exactamente la sección 4 de ``homework/Analisis_Exploratorio.ipynb``:
1. NOMBRE_LIMPIO: mayúsculas, sin espacios extremos ni dobles.
2. Cada cuenta toma el ÚLTIMO nombre con el que aparece (titular actual).
3. Las variantes de escritura se unen con el diccionario ``REMPLAZAR``.
Resultado: 701 cuentas → 152 usuarios (151 con datos hasta el último mes completo).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

from . import utils

REMPLAZAR = {
    'ASOSANTANA': 'ASOSANTANA (ASOCIACION DE USUARIOS)',
    'ASOSANTANA (ASOCIACION DE USUA': 'ASOSANTANA (ASOCIACION DE USUARIOS)',
    'CAFE FORTALEZA LTDA': 'CAFE FORTALEZA S.A.S.',
    'E.S.E HOSPITAL DPTAL SAN ANTON': 'E.S.E HOSPITAL DPTAL SAN ANTONIO (PITALITO)',
    'E.S.E.HOSPITAL SAN ANTONIO DE ': 'E.S.E HOSPITAL DPTAL SAN ANTONIO (LA PLATA)',
    'E.S.E. HOSPITAL DEPARTAMENTAL': 'E.S.E HOSPITAL DPTAL SAN ANTONIO (LA PLATA)',
    'PISCICOLA EL CARACOLI SAS': 'PISCICOLA EL CARACOLI S.A.S.',
    'PISCICOLA NEWYORK S.A.': 'PISCICOLA NEW YORK S.A.',
}

PALABRAS_ENTIDAD = {
    'SAS', 'SA', 'LTDA', 'ESP', 'CIA', 'SCA', 'MUNICIPIO', 'HOSPITAL', 'CLINICA', 'ESE', 'EMPRESA', 'EMPRESAS',
    'INVERSIONES', 'ASOCIACION', 'CENTRO', 'COMERCIAL', 'COLOMBIA', 'DEPARTAMENTO', 'NACIONAL', 'POLICIA', 'UNIVERSIDAD',
    'INSTITUTO', 'COOPERATIVA', 'FONDO', 'CAJA', 'HOTEL', 'HOTELES', 'PISCICOLA', 'AVICOLA', 'CAFE', 'CARNES', 'FIDUCIARIA',
    'DIRECCION', 'UNIDAD', 'SALUD', 'BANCO', 'GRUPO', 'SOCIEDAD', 'CORPORACION', 'CORPORACIÓN', 'FUNDACION',
    'COMERCIALIZADORA', 'INDUSTRIA', 'INDUSTRIAS', 'MINERALES', 'DISTRITO', 'USUARIOS', 'CONSORCIO', 'UNION', 'TEMPORAL',
    'GOBERNACION', 'HUILA', 'NEIVA', 'SEDE', 'INTEGRADOR', 'EDS', 'ESTACION', 'CONJUNTO', 'INMOBILIARIO', 'LADRILLERA',
    'SUPERMERCADO', 'LABORATORIO', 'TRITURADOS', 'MOTEL', 'INDUCON', 'CONSTRUCTORA', 'TRILLADORA', 'EXPORTADORES',
    'FERRETERIA', 'MOLINO', 'ARROCERA', 'COMPAÑIA', 'ALFAREROS', 'ALMACENES', 'DISEÑO', 'COSTRUCCION', 'CONSTRUCCION',
    'ARCILLAS', 'FERTILIZANTES', 'QUIMICOS', 'TIERRAS'}

SEGMENTOS = ['Municipio de Neiva', '10 grandes usuarios', 'Resto de usuarios']
TIPOS = ['Persona jurídica o entidad', 'Persona natural']
TRAMOS_TAMANO = [(0, 10, 'Pequeño (< 10 MWh/mes)'), (10, 100, 'Mediano (10–100 MWh/mes)'),
                 (100, 500, 'Grande (100–500 MWh/mes)'), (500, float('inf'), 'Muy grande (> 500 MWh/mes)')]
UMBRAL_MES_COMPLETO = 0.5   # un mes es incompleto si tiene menos del 50 % de las cuentas habituales


def probable_persona_natural(nombre: str) -> bool:
    """Regla de texto: 2–6 palabras, sin palabras de empresa ni forma societaria (se usa para proteger nombres)."""
    if re.search(r'\bS\W{0,2}A\b|\bS\W?EN\W?C\b|&', nombre):
        return False
    tokens = re.sub(r'[^A-ZÑÁÉÍÓÚ ]', ' ', nombre).split()
    if any(t in PALABRAS_ENTIDAD or t.startswith(('ASO', 'COO', 'AGRO', 'INVER', 'COMER', 'DISTRI')) for t in tokens):
        return False
    return 2 <= len(tokens) <= 6


# ----------------------------------------------------------------------------------------------------------
# Carga y consolidación
# ----------------------------------------------------------------------------------------------------------
def cargar_consumos(ruta=utils.RUTA_CONSUMOS) -> pd.DataFrame:
    df = pd.read_excel(ruta, sheet_name=utils.HOJA_CONSUMOS)
    df['FECHA'] = pd.to_datetime(dict(year=df['ANO'], month=df['MES'], day=1))
    return df


def consolidar_usuarios(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df['NOMBRE_LIMPIO'] = df['NOMBRE'].astype(str).str.upper().str.strip().str.replace(r'\s+', ' ', regex=True)
    df['PERIODO'] = df['ANO'] * 100 + df['MES']
    ultimo = (df.sort_values(['CUENTA', 'PERIODO']).groupby('CUENTA')
              .agg(N=('NOMBRE_LIMPIO', 'nunique'), ULTIMO=('NOMBRE_LIMPIO', 'last')).query('N > 1')['ULTIMO'])
    df['USUARIO'] = df['CUENTA'].map(ultimo).fillna(df['NOMBRE']).replace(REMPLAZAR)
    return df


def ultimo_mes_completo(df: pd.DataFrame) -> pd.Timestamp:
    cuentas_mes = df.groupby('FECHA')['CUENTA'].nunique()
    return cuentas_mes[cuentas_mes >= UMBRAL_MES_COMPLETO * cuentas_mes.median()].index.max()


def tabla_usuarios(df: pd.DataFrame) -> pd.DataFrame:
    """Catálogo de usuarios: código Uxxx (orden por consumo total, igual al cuaderno), etiqueta protegida y segmento."""
    u = (df.groupby('USUARIO').agg(CUENTAS=('CUENTA', 'nunique'), KWH=('TOTAL_ACTIVA', 'sum'),
                                   PRIMER_MES=('FECHA', 'min'), ULTIMO_MES=('FECHA', 'max'))
         .sort_values('KWH', ascending=False))
    u['CODIGO'] = [f'U{i + 1:03d}' for i in range(len(u))]
    u['PERSONA_NATURAL'] = u.index.map(probable_persona_natural)
    u['ETIQUETA'] = np.where(u['PERSONA_NATURAL'], 'Persona natural ' + u['CODIGO'], u.index.str.strip())
    neiva = u['CUENTAS'].idxmax()
    grandes = [x for x in u.index if x != neiva][:10]
    u['SEGMENTO'] = np.select([u.index == neiva, u.index.isin(grandes)], SEGMENTOS[:2], SEGMENTOS[2])
    u['TIPO'] = np.where(u['PERSONA_NATURAL'], TIPOS[1], TIPOS[0])
    return u


@dataclass
class Base:
    """Datos listos para el análisis y la predicción."""
    completo: pd.DataFrame        # todos los registros con USUARIO consolidado
    analisis: pd.DataFrame        # solo meses completos
    usuarios: pd.DataFrame        # catálogo (índice = nombre consolidado)
    cuentas: pd.DataFrame         # catálogo de cuentas (número real de cuenta)
    ultimo_mes: pd.Timestamp
    excluidos: pd.DataFrame       # registros de meses incompletos

    @property
    def serie_global(self) -> pd.Series:
        s = self.analisis.groupby('FECHA')['TOTAL_ACTIVA'].sum()
        return s.reindex(pd.date_range(s.index.min(), self.ultimo_mes, freq='MS'), fill_value=0.0).astype(float)


def preparar_base() -> Base:
    df = consolidar_usuarios(cargar_consumos())
    usuarios = tabla_usuarios(df)
    ultimo = ultimo_mes_completo(df)
    analisis = df[df['FECHA'] <= ultimo].copy()
    cod_u = usuarios['CODIGO']
    analisis['CODIGO_USUARIO'] = analisis['USUARIO'].map(cod_u)
    cuentas = (df.sort_values('FECHA').groupby('CUENTA')
               .agg(USUARIO=('USUARIO', 'last'), CICLO=('CICLO', 'last'), PRIMER_MES=('FECHA', 'min'),
                    ULTIMO_MES=('FECHA', 'max')).reset_index().sort_values('CUENTA'))
    cuentas['CODIGO_CUENTA'] = [f'C{i + 1:03d}' for i in range(len(cuentas))]
    cuentas['CODIGO_USUARIO'] = cuentas['USUARIO'].map(cod_u)
    analisis['CODIGO_CUENTA'] = analisis['CUENTA'].map(cuentas.set_index('CUENTA')['CODIGO_CUENTA'])
    return Base(df, analisis, usuarios, cuentas, ultimo, df[df['FECHA'] > ultimo])


def escribir_catalogo_usuarios(base: Base, ruta=utils.RUTA_USUARIOS):
    """data/input/usuarios.xlsx: catálogo de usuarios consolidados y de cuentas (insumo de referencia)."""
    u = base.usuarios.reset_index()
    t_u = pd.DataFrame({'Código usuario': u['CODIGO'], 'Usuario consolidado': u['USUARIO'], 'Etiqueta protegida': u['ETIQUETA'],
                        'Segmento': u['SEGMENTO'], 'Tipo de titular': u['TIPO'], 'Cuentas': u['CUENTAS'],
                        'Primer mes': u['PRIMER_MES'], 'Último mes': u['ULTIMO_MES'], 'Consumo total (kWh)': u['KWH']})
    c = base.cuentas
    t_c = pd.DataFrame({'Cuenta': c['CUENTA'].astype(str), 'Código usuario': c['CODIGO_USUARIO'],
                        'Usuario consolidado': c['USUARIO'], 'Ciclo': c['CICLO'], 'Primer mes': c['PRIMER_MES'],
                        'Último mes': c['ULTIMO_MES']})
    return utils.exportar_excel(ruta, [
        dict(hoja='Usuarios', tabla=t_u, titulo='Catálogo de usuarios consolidados',
             descripcion='Titular actual de cada cuenta con variantes de nombre unificadas. Uso interno: incluye nombres originales.'),
        dict(hoja='Cuentas', tabla=t_c, titulo='Catálogo de cuentas',
             descripcion='Cada cuenta (número real) con su usuario titular y ciclo de facturación.'),
    ], 'Catálogo de usuarios y cuentas (generado desde consumos.xlsx)')


# ----------------------------------------------------------------------------------------------------------
# Variables externas de calendario (festivos de Colombia, Ley 51 de 1983)
# ----------------------------------------------------------------------------------------------------------
def _pascua(anio: int) -> date:
    a, b, c = anio % 19, anio // 100, anio % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mes = (h + l - 7 * m + 114) // 31
    dia = (h + l - 7 * m + 114) % 31 + 1
    return date(anio, mes, dia)


def _lunes_siguiente(d: date) -> date:
    return d + timedelta(days=(7 - d.weekday()) % 7)


def festivos_colombia(anio: int) -> set:
    """Festivos nacionales: fijos, trasladables al lunes (Ley Emiliani) y los que dependen de la Pascua."""
    fijos = [date(anio, 1, 1), date(anio, 5, 1), date(anio, 7, 20), date(anio, 8, 7), date(anio, 12, 8), date(anio, 12, 25)]
    trasladables = [date(anio, m, d) for m, d in [(1, 6), (3, 19), (6, 29), (8, 15), (10, 12), (11, 1), (11, 11)]]
    p = _pascua(anio)
    semana_santa = [p - timedelta(days=3), p - timedelta(days=2)]
    moviles = [p + timedelta(days=43), p + timedelta(days=64), p + timedelta(days=71)]   # Ascensión, Corpus, Sagrado Corazón
    return set(fijos) | {_lunes_siguiente(d) for d in trasladables} | set(semana_santa) | set(moviles)


def calendario(desde: str, hasta: str) -> pd.DataFrame:
    """Una fila por mes con días del mes, días hábiles (lunes a viernes no festivos), sábados, domingos y festivos."""
    dias = pd.date_range(desde, pd.Timestamp(hasta) + pd.offsets.MonthEnd(0), freq='D')
    fest = set().union(*(festivos_colombia(a) for a in range(dias.min().year, dias.max().year + 1)))
    d = pd.DataFrame({'DIA': dias})
    d['FECHA'] = d['DIA'].dt.to_period('M').dt.to_timestamp()
    d['FESTIVO'] = d['DIA'].dt.date.isin(fest)
    d['SEMANA'] = d['DIA'].dt.weekday
    d['HABIL'] = (d['SEMANA'] < 5) & ~d['FESTIVO']
    cal = d.groupby('FECHA').agg(DIAS_MES=('DIA', 'size'), DIAS_HABILES=('HABIL', 'sum'),
                                 SABADOS=('SEMANA', lambda s: int((s == 5).sum())),
                                 DOMINGOS=('SEMANA', lambda s: int((s == 6).sum())),
                                 FESTIVOS_ENTRE_SEMANA=('FESTIVO', lambda s: int((s & (d.loc[s.index, 'SEMANA'] < 5)).sum())))
    return cal.astype(int)


def escribir_variables_externas(desde='2020-01-01', hasta='2027-12-01', ruta=utils.RUTA_VARIABLES) -> pd.DataFrame:
    cal = calendario(desde, hasta).reset_index()
    cal['FECHA'] = cal['FECHA'].dt.strftime('%Y-%m-%d')
    cal.to_csv(ruta, index=False, encoding='utf-8-sig')
    return cal


def leer_variables_externas(ruta=utils.RUTA_VARIABLES) -> pd.DataFrame:
    """Lee data/input/variables_externas.csv (FECHA + columnas numéricas). Se pueden agregar columnas nuevas,
    por ejemplo temperatura o actividad económica, siempre que cubran también los meses a pronosticar."""
    cal = pd.read_csv(ruta, encoding='utf-8-sig', parse_dates=['FECHA']).set_index('FECHA').sort_index()
    return cal


# ----------------------------------------------------------------------------------------------------------
# Datos del dashboard exploratorio (tabla de hechos cuenta-mes compacta)
# ----------------------------------------------------------------------------------------------------------
def datos_dashboard_eda(base: Base) -> dict:
    a, usuarios = base.analisis, base.usuarios.copy()
    meses = pd.date_range(a['FECHA'].min(), base.ultimo_mes, freq='MS')
    idx_mes = {f: i for i, f in enumerate(meses)}
    prom = a.groupby(['USUARIO', 'FECHA'])['TOTAL_ACTIVA'].sum().groupby('USUARIO').mean() / 1e3
    usuarios['TAMANO'] = prom.reindex(usuarios.index).fillna(0).map(
        lambda v: next(i for i, (lo, hi, _) in enumerate(TRAMOS_TAMANO) if lo <= v < hi))
    lista_u = usuarios.reset_index()
    pos_u = {n: i for i, n in enumerate(lista_u['USUARIO'])}
    cta = (a.sort_values('FECHA').groupby('CUENTA').agg(USUARIO=('USUARIO', 'last'), CICLO=('CICLO', 'last'))
           .reset_index().sort_values('CUENTA'))
    cta['CODIGO'] = cta['CUENTA'].astype(str)   # se muestra el número real de cuenta
    pos_c = {c: i for i, c in enumerate(cta['CUENTA'])}
    ciclos = sorted(int(x) for x in cta['CICLO'].unique())
    hechos = a.groupby(['CUENTA', 'FECHA'], as_index=False)['TOTAL_ACTIVA'].sum()
    solo_excl = sorted(set(base.completo['USUARIO']) - set(a['USUARIO']))
    modelo = {
        'meta': {
            'generado': datetime.now().strftime('%Y-%m-%d %H:%M'),
            'fuente': 'Electrohuila, tabla estadistica_usuario (tipo_usuario = NR)',
            'ultimo_mes': base.ultimo_mes.strftime('%Y-%m'),
            'meses_excluidos': sorted(base.excluidos['FECHA'].dt.strftime('%Y-%m').unique().tolist()),
            'registros_excluidos': int(len(base.excluidos)),
            'kwh_total': int(a['TOTAL_ACTIVA'].sum()), 'n_usuarios': int(a['USUARIO'].nunique()),
            'n_cuentas': int(a['CUENTA'].nunique()), 'n_usuarios_total': int(len(usuarios)),
            'solo_excluidos': [f"{usuarios.loc[n, 'CODIGO']} {usuarios.loc[n, 'ETIQUETA']}" for n in solo_excl],
        },
        'meses': [f.strftime('%Y-%m') for f in meses],
        'segmentos': SEGMENTOS, 'tamanos': [t[2] for t in TRAMOS_TAMANO], 'tipos': TIPOS, 'ciclos': ciclos,
        'usuarios': {'cod': lista_u['CODIGO'].tolist(), 'nom': lista_u['ETIQUETA'].tolist(),
                     'seg': [SEGMENTOS.index(s) for s in lista_u['SEGMENTO']],
                     'tam': lista_u['TAMANO'].astype(int).tolist(), 'tipo': [TIPOS.index(t) for t in lista_u['TIPO']]},
        'cuentas': {'cod': cta['CODIGO'].tolist(), 'usr': [pos_u[u] for u in cta['USUARIO']],
                    'ciclo': [ciclos.index(int(c)) for c in cta['CICLO']]},
        'hechos': {'c': [pos_c[c] for c in hechos['CUENTA']], 'm': [idx_mes[f] for f in hechos['FECHA']],
                   'v': hechos['TOTAL_ACTIVA'].round().astype(int).tolist()},
    }
    assert sum(modelo['hechos']['v']) == modelo['meta']['kwh_total'], 'Los hechos no suman el total de la base'
    return modelo
